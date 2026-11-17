/* 内置 HTTP 服务：
 *   /            → ui 静态文件
 *   /game/**     → Sunniesnow 内核（www/game）
 *   /levels/**   等 → www 静态
 *   /api/list     → 列出监听目录里的谱面文件
 *   /api/raw      → 读文件（json / 音频 / 图片 / ssc）
 *   /api/events   → SSE，文件保存时推送 change 事件
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.wasm': 'application/wasm',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.gif': 'image/gif',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
	'.mp3': 'audio/mpeg',
	'.wav': 'audio/wav',
	'.ogg': 'audio/ogg',
	'.m4a': 'audio/mp4',
	'.flac': 'audio/flac',
	'.opus': 'audio/opus',
	'.aac': 'audio/aac',
	'.ttf': 'font/ttf',
	'.otf': 'font/otf',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ssc': 'application/zip',
	'.txt': 'text/plain; charset=utf-8',
	'.md': 'text/markdown; charset=utf-8'
};

const CHART_EXT = ['.json', '.ssc'];

function send(res, code, body, type) {
	res.writeHead(code, {'content-type': type || 'text/plain; charset=utf-8', 'cache-control': 'no-cache'});
	res.end(body);
}

function serveFile(res, file) {
	fs.stat(file, (err, st) => {
		if (err || !st.isFile()) return send(res, 404, 'Not Found');
		res.writeHead(200, {
			'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
			'content-length': st.size,
			'cache-control': 'no-cache'
		});
		fs.createReadStream(file).pipe(res);
	});
}

function walkCharts(dir, depth, out) {
	if (depth < 0 || !fs.existsSync(dir)) return out;
	for (const name of fs.readdirSync(dir)) {
		const p = path.join(dir, name);
		let st;
		try { st = fs.statSync(p); } catch (e) { continue; }
		if (st.isDirectory()) {
			if (name.startsWith('.') || name === 'node_modules' || name === 'www' || name === 'ui'
				|| name === 'dist' || fs.existsSync(path.join(p, 'resources'))) continue;
			walkCharts(p, depth - 1, out);
		} else if (CHART_EXT.includes(path.extname(name).toLowerCase())) {
			out.push({name, path: p, dir: path.dirname(p), size: st.size, mtime: st.mtimeMs});
		}
	}
	return out;
}

function startServer({wwwDir, uiDir, watchRoot, port}) {
	const clients = new Set();

	const server = http.createServer((req, res) => {
		const u = new URL(req.url, 'http://127.0.0.1');
		const p = decodeURIComponent(u.pathname);

		if (p === '/api/list') {
			const dir = u.searchParams.get('dir');
			if (dir && fs.existsSync(dir)) {
				const files = [];
				for (const name of fs.readdirSync(dir)) {
					const fp = path.join(dir, name);
					let st;
					try { st = fs.statSync(fp); } catch (e) { continue; }
					if (!st.isFile()) continue;
					files.push({name, path: fp, dir, size: st.size, mtime: st.mtimeMs});
				}
				return send(res, 200, JSON.stringify({root: dir, files}), 'application/json; charset=utf-8');
			}
			const files = walkCharts(watchRoot, 3, []).sort((a, b) => b.mtime - a.mtime);
			return send(res, 200, JSON.stringify({root: watchRoot, files}), 'application/json; charset=utf-8');
		}

		if (p === '/api/raw') {
			const f = u.searchParams.get('path') || '';
			if (!fs.existsSync(f)) return send(res, 404, 'Not Found');
			return serveFile(res, f);
		}

		if (p === '/api/events') {
			res.writeHead(200, {
				'content-type': 'text/event-stream',
				'cache-control': 'no-cache',
				connection: 'keep-alive'
			});
			res.write('retry: 2000\n\n');
			clients.add(res);
			req.on('close', () => clients.delete(res));
			return;
		}

		let file;
		if (p === '/' ) file = path.join(uiDir, 'player.html');
		else if (fs.existsSync(path.join(uiDir, p.slice(1)))) file = path.join(uiDir, p.slice(1));
		else file = path.join(wwwDir, p.slice(1));
		serveFile(res, file);
	});

	/* 目录监听：任何 .json / .ssc 保存都推给页面 */
	let timer = null;
	const pending = new Map();
	try {
		const watcher = fs.watch(watchRoot, {recursive: true}, (ev, filename) => {
			if (!filename) return;
			const full = path.resolve(watchRoot, filename);
			if (!CHART_EXT.includes(path.extname(full).toLowerCase())) return;
			pending.set(full, Date.now());
			clearTimeout(timer);
			timer = setTimeout(() => {
				for (const f of pending.keys()) {
					let mtime = 0;
					try { mtime = fs.statSync(f).mtimeMs; } catch (e) {}
					const msg = `data: ${JSON.stringify({type: 'change', path: f, mtime})}\n\n`;
					for (const c of clients) c.write(msg);
				}
				pending.clear();
			}, 400);
		});
		server.on('close', () => watcher.close());
	} catch (e) {
		console.error('watch failed', e);
	}

	return new Promise(resolve => {
		server.listen(port, '127.0.0.1', () => resolve({server, port: server.address().port}));
	});
}

module.exports = {startServer};
