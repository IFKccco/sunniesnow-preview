/* 谱面实时预览器前端
 * 逻辑：监听 SSE → 选中最新保存的谱面 → 拉取 json + 同目录音频/曲绘 → 现场拼成 .ssc → 调内核跑
 */
const AUDIO_EXT = ['.mp3', '.ogg', '.wav', '.flac', '.m4a', '.opus', '.aac'];
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const NOTE_TYPES = ['tap', 'drag', 'flick', 'hold', 'dragFlick', 'headOnlyHold'];
let chartNoteTimes = [];

const $ = s => document.querySelector(s);
const elFiles = $('#files');
const elStatus = $('#status');
const elOverlay = $('#overlay');
const elOverlayText = $('#overlay-text');
const iframe = $('#game');

let files = [];
let current = null;
let previewing = false;
let queued = null;
let lastRunAt = 0;
/* 播放位置：改完重跑时从这里附近接着看 */
let lastTime = 0;
let duration = 0;
let dragging = false;
let wasPaused = false;

/* 画布尺寸跟当前舞台一致，避免窗口变化后拉伸 */
function stageSize() {
	const el = document.querySelector('#stage');
	const dpr = Math.min(window.devicePixelRatio || 1, 2);
	return {
		width: Math.max(640, Math.min(2560, Math.round(el.clientWidth * dpr))),
		height: Math.max(360, Math.min(1600, Math.round(el.clientHeight * dpr)))
	};
}

function fmtClock(t) {
	if (!isFinite(t) || t < 0) t = 0;
	const m = Math.floor(t / 60);
	const s = t - m * 60;
	return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
}

function setStatus(text, cls) {
	elStatus.textContent = text;
	elStatus.className = 'status' + (cls ? ' ' + cls : '');
}

function fmtTime(ms) {
	const d = new Date(ms);
	return d.toTimeString().slice(0, 8);
}

function fmtSize(n) {
	return n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';
}

function basename(p) {
	return p.split(/[\\/]/).pop();
}

function relDir(p) {
	const dir = p.slice(0, p.length - basename(p).length);
	return dir.replace(/[\\/]$/, '').split(/[\\/]/).pop() || '';
}

/* ---------------- 文件列表 ---------------- */

async function refreshList() {
	const r = await fetch('/api/list', {cache: 'no-cache'});
	const data = await r.json();
	files = data.files;
	$('#root-path').textContent = data.root;
	$('#file-count').textContent = files.length;
	renderList();
	return files;
}

function renderList() {
	elFiles.innerHTML = '';
	for (const f of files) {
		const div = document.createElement('div');
		div.className = 'file' + (current && current.path === f.path ? ' active' : '');
		const isSsc = f.name.toLowerCase().endsWith('.ssc');
		div.innerHTML =
			`<div class="name">${escapeHtml(f.name)}${isSsc ? '<span class="badge">ssc</span>' : ''}</div>` +
			`<div class="meta">${escapeHtml(relDir(f.path))} · ${fmtSize(f.size)} · ${fmtTime(f.mtime)}</div>`;
		div.onclick = () => preview(f.path, {manual: true});
		elFiles.appendChild(div);
	}
}

function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}

/* ---------------- 内核接口 ---------------- */

function iframeApi() {
	try { return iframe.contentWindow.__ssapi; } catch (e) { return null; }
}

function waitApi(timeout = 60000) {
	return new Promise((resolve, reject) => {
		const t0 = Date.now();
		const tick = () => {
			const api = iframeApi();
			if (api && api.ready()) return resolve(api);
			if (Date.now() - t0 > timeout) return reject(new Error('内核加载超时'));
			setTimeout(tick, 200);
		};
		tick();
	});
}

/* 整页重载内核 iframe：内核爆过一次（比如裁到空区间）之后要重开一次才干净 */
function reloadIframe() {
	return new Promise(resolve => {
		let settled = false;
		const done = () => {
			if (settled) return;
			settled = true;
			iframe.removeEventListener('load', done);
			resolve();
		};
		iframe.addEventListener('load', done);
		iframe.src = iframe.src;
		setTimeout(done, 15000);
	});
}

/* ---------------- 组装关卡包 ---------------- */

async function fetchBuf(url) {
	const sep = url.includes('?') ? '&' : '?';
	const r = await fetch(url + sep + 't=' + Date.now(), {cache: 'no-cache'});
	if (!r.ok) throw new Error('读取失败：' + r.status + ' ' + url.slice(0, 60));
	return r.arrayBuffer();
}

function siblingCandidates(path, exts) {
	const dir = path.slice(0, path.length - basename(path).length);
	return {dir, exts};
}

async function buildFromJson(path, text) {
	const dir = path.slice(0, path.length - basename(path).length);
	const dirApi = await fetch('/api/list?dir=' + encodeURIComponent(dir), {cache: 'no-cache'});
	const dirFiles = dirApi.ok ? (await dirApi.json()).files || [] : [];
	const all = dirFiles.length ? dirFiles : files.filter(f => f.path.startsWith(dir));

	let json;
	try { json = JSON.parse(text); } catch (e) { throw new Error('JSON 语法错误：' + e.message); }

	const audioName = json.music || json.musicFile || json.audio || '';
	const audio = all.find(f => audioName && basename(f.path) === audioName)
		|| all.find(f => AUDIO_EXT.includes(extOf(f.path)));
	if (!audio) throw new Error('同目录没找到音频文件（mp3/ogg/wav…）');

	const cover = all.find(f => IMAGE_EXT.includes(extOf(f.path)));

	const zip = new JSZip();
	zip.file(basename(path), text);
	zip.file(basename(audio.path), await fetchBuf('/api/raw?path=' + encodeURIComponent(audio.path)));
	if (cover) zip.file(basename(cover.path), await fetchBuf('/api/raw?path=' + encodeURIComponent(cover.path)));
	const blob = await zip.generateAsync({type: 'blob'});
	const events = Array.isArray(json.events) ? json.events.length : (Array.isArray(json) ? json.length : 0);
	/* 记下所有音符时间：用来把时间轴上限压到「最后一个音符」，避免跳到谱面尾部空白区 */
	const noteTimes = (json.events || [])
		.filter(e => e && typeof e.time === 'number' && NOTE_TYPES.includes(String(e.type)))
		.map(e => Number(e.time))
		.sort((a, b) => a - b);
	chartNoteTimes = noteTimes;
	return {
		file: new File([blob], basename(path).replace(/\.json$/i, '') + '.ssc', {type: 'application/zip'}),
		chart: basename(path),
		info: `${json.title || basename(path)} · ${events} 事件 · ${basename(audio.path)}${cover ? ' · ' + basename(cover.path) : ''}`,
		events
	};
}

function extOf(p) {
	const i = p.lastIndexOf('.');
	return i < 0 ? '' : p.slice(i).toLowerCase();
}

function lastNoteBefore(t) {
	let v = null;
	for (const x of chartNoteTimes) { if (x <= t + 0.5) v = x; else break; }
	return v;
}

/* 时间轴能拖到哪：不超过音乐长度，也不超过最后一个音符 */
function playableEnd() {
	if (!chartNoteTimes.length || !duration) return duration || 0;
	return Math.min(duration, chartNoteTimes[chartNoteTimes.length - 1]);
}

/* ---------------- 预览 ---------------- */

async function preview(path, opts = {}) {
	if (!path) return;
	if (previewing) { queued = {path, opts}; return; }
	previewing = true;
	const f = files.find(x => x.path === path) || {path, name: basename(path)};
	const sameSong = current && current.path === path;
	let resumeAt = opts.startTime != null ? opts.startTime
		: (sameSong && lastTime > 3 ? Math.max(0, lastTime - 2.5) : null);
	/* 目标落在谱面音符结束之后的空白区时，压回最后一个音符，免得内核判「区间无音符」直接报错 */
	let clampedTo = null;
	if (resumeAt != null && chartNoteTimes.length) {
		const lastNote = chartNoteTimes[chartNoteTimes.length - 1];
		const ceiling = Math.max(0, lastNote - 2.5);
		if (resumeAt > ceiling) {
			resumeAt = ceiling;
			clampedTo = resumeAt;
		}
	}
	current = f;
	renderList();
	elOverlay.classList.remove('hidden');
	elOverlayText.textContent = resumeAt != null ? '准备谱面 · 从 ' + fmtClock(resumeAt) + ' 继续…' : '准备谱面…';
	try {
		/* 跳转/续播都换一页新内核来跑，避免同一个页面里反复起停把内核搞成加载卡死 */
		if (resumeAt != null && opts.freshKernel !== false) {
			elOverlayText.textContent = '重开内核…';
			await reloadIframe();
		}
		let api = await waitApi();
		let payload;
		if (extOf(path) === '.ssc') {
			const buf = await fetchBuf('/api/raw?path=' + encodeURIComponent(path));
			payload = {file: new File([buf], basename(path), {type: 'application/zip'}), chart: null, info: basename(path)};
		} else {
			const buf = await fetchBuf('/api/raw?path=' + encodeURIComponent(path));
			payload = await buildFromJson(path, new TextDecoder().decode(buf));
		}
		elOverlayText.textContent = '内核解析中…';
		/* 同曲续播 / 跳转：有总时长就按百分比让内核直接从目标位置起，画面不会糊成一片 */
		const size = stageSize();
		const launchOpts = {auto: true, startTime: resumeAt, width: size.width, height: size.height};
		if (resumeAt != null && duration > 0) launchOpts.startPercent = resumeAt / duration;
		if (opts.pauseAt) launchOpts.pauseAt = true;
		let res = await api.preview(payload.file, payload.chart, launchOpts);
		if (!res || !res.ok) throw new Error((res && res.error) || '预览失败');
		let fellBack = false;
		/* 目标位置往后没有音符 / 内核这次没起来：换干净内核、从头起播再跳过去 */
		if ((res.placed === 'nomusic' || res.placed === 'lost') && resumeAt != null) {
			const lastBefore = lastNoteBefore(resumeAt);
			elOverlayText.textContent = res.placed === 'nomusic' ? '该处之后没有音符，退回到最后一个音符…' : '内核没起来，换页重试…';
			await reloadIframe();
			api = await waitApi();
			if (res.placed === 'nomusic' && lastBefore != null && duration > 0) {
				const pos = Math.max(0, Math.min(lastBefore - 2.5, lastBefore));
				launchOpts.startPercent = Math.max(0, Math.min(1, pos / duration));
				resumeAt = pos;
				clampedTo = resumeAt;
			} else {
				delete launchOpts.startPercent;
			}
			launchOpts.startTime = resumeAt;
			res = await api.preview(payload.file, payload.chart, launchOpts);
			if (!res || !res.ok) throw new Error((res && res.error) || '预览失败');
			fellBack = true;
		}
		$('#einfo').textContent = payload.info;
		elOverlay.classList.add('hidden');
		lastRunAt = Date.now();
		if (!resumeAt) { lastTime = 0; duration = 0; $('#seek').value = 0; }
		const located = resumeAt != null ? (opts.pauseAt ? ' · 已定位 ' + fmtClock(resumeAt) + '（空格继续）' : ' · 从 ' + fmtClock(resumeAt) + ' 继续') : '';
		const clipped = clampedTo != null ? '（该位置之后没有音符，已停在谱面末尾附近）' : '';
		const warn = res.placed && res.placed !== 'ok' ? '（内核没走到 ' + fmtClock(resumeAt) + '）' : '';
		setStatus('已开跑 · ' + (res.title || payload.info) + ' · 谱面 ' + res.chart + located + clipped + (fellBack ? '（已退回干净起播）' : '') + warn, res.placed && res.placed !== 'ok' ? 'err' : 'ok');
	} catch (e) {
		elOverlay.classList.add('hidden');
		setStatus(String(e.message || e), 'err');
	} finally {
		previewing = false;
		if (queued) { const q = queued; queued = null; preview(q.path, q.opts); }
	}
}

/* ---------------- 事件 ---------------- */

const es = new EventSource('/api/events');
es.onmessage = async ev => {
	let msg;
	try { msg = JSON.parse(ev.data); } catch (e) { return; }
	if (msg.type !== 'change') return;
	await refreshList();
	if (!$('#follow').checked) {
		setStatus('检测到保存：' + basename(msg.path) + '（自动重跑已关闭）');
		return;
	}
	const hit = files.find(f => f.path === msg.path);
	if (!hit) return;
	/* 同一个文件连续保存时，等编辑器写完再读 */
	setTimeout(() => preview(msg.path, {auto: true}), 250);
};

/* ---------------- 时间轴 ---------------- */

const elSeek = $('#seek');
const elNow = $('#tnow');
const elEnd = $('#tend');

elSeek.addEventListener('input', e => {
	dragging = true;
	elNow.textContent = fmtClock(Number(e.target.value));
});
elSeek.addEventListener('change', e => {
	const t = Number(e.target.value);
	dragging = false;
	/* 大跨度跳转直接改音乐时间会把中间几十秒的音效/音符一次性补出来，
	   画面会糊成一片；这里改成从目标位置重开内核，落点精确并停住 */
	if (!current) { setStatus('先选一份谱面', 'err'); return; }
	lastTime = t;
	setStatus('定位到 ' + fmtClock(t) + ' · 重开内核…');
	preview(current.path, {startTime: t, pauseAt: true});
});

setInterval(() => {
	const api = iframeApi();
	if (!api || !api.state) return;
	const s = api.state();
	if (!s || s.time == null) return;
	wasPaused = !!s.paused;
	if (s.playing || s.time > 0) lastTime = s.time;
	if (s.duration && Math.abs(s.duration - duration) > 0.5) {
		duration = s.duration;
		elSeek.max = String(playableEnd());
		elEnd.textContent = fmtClock(duration);
	}
	if (!dragging && !previewing) {
		elSeek.value = String(Math.max(0, Math.min(duration || s.time, s.time)));
		elNow.textContent = fmtClock(Math.max(0, s.time));
	}
}, 200);

/* 窗口被拉伸/缩小时按新尺寸重开一次；画布比例不会失真 */
let resizeTimer = null;
window.addEventListener('resize', () => {
	clearTimeout(resizeTimer);
	resizeTimer = setTimeout(() => {
		if (!current || previewing) return;
		preview(current.path, {startTime: lastTime, pauseAt: wasPaused});
	}, 800);
});

$('#follow').addEventListener('change', e => setStatus(e.target.checked ? '已开启自动重跑' : '已关闭自动重跑'));

/* ---------------- 快捷键 ---------------- */

const elKeysPanel = $('#keys-panel');
$('#keys').addEventListener('click', () => elKeysPanel.classList.toggle('hidden'));

/* ←/→ 也走「按百分比重开」：直接改时间的话，退回去之后前面已经判过的音符不会再出现，
   只剩游标，所以这里改成攒一小段防抖后重开一次，落在目标位置 */
let stepTarget = null;
let stepTimer = null;
function jumpBy(delta) {
	const api = iframeApi();
	if (!api || !api.state) return;
	const s = api.state();
	if (!s) return;
	const base = stepTarget != null ? stepTarget : (s.time == null ? lastTime : s.time);
	const max = playableEnd() || s.duration || 1e9;
	stepTarget = Math.max(0, Math.min(max, base + delta));
	elSeek.value = String(stepTarget);
	elNow.textContent = fmtClock(stepTarget);
	setStatus('定位到 ' + fmtClock(stepTarget));
	clearTimeout(stepTimer);
	stepTimer = setTimeout(() => {
		const t = stepTarget;
		stepTarget = null;
		if (t == null || !current) return;
		lastTime = t;
		preview(current.path, {startTime: t, pauseAt: wasPaused});
	}, 400);
}

function stepFile(d) {
	if (!files.length) return;
	const i = files.findIndex(f => current && f.path === current.path);
	const n = Math.max(0, Math.min(files.length - 1, (i < 0 ? 0 : i) + d));
	if (!files[n]) return;
	preview(files[n].path, {startTime: null});
}

function toggleFullscreen() {
	if (document.fullscreenElement) document.exitFullscreen();
	else document.documentElement.requestFullscreen().catch(() => {});
}

function handleKey(e) {
	if (e.target && e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
	const k = e.key;
	if (k === ' ' || k === 'Spacebar') {
		e.preventDefault();
		const api = iframeApi();
		if (!api || !api.pause) return;
		const paused = api.pause();
		if (paused === null || paused === undefined) setStatus('内核还没开始演奏', 'err');
		else setStatus(paused ? '已暂停 · 空格继续' : '继续');
	} else if (k === 'ArrowLeft') {
		e.preventDefault();
		jumpBy(e.shiftKey ? -1 : -5);
	} else if (k === 'ArrowRight') {
		e.preventDefault();
		jumpBy(e.shiftKey ? 1 : 5);
	} else if (k === 'ArrowUp') {
		e.preventDefault();
		stepFile(-1);
	} else if (k === 'ArrowDown') {
		e.preventDefault();
		stepFile(1);
	} else if (k === 'Home') {
		e.preventDefault();
		jumpBy(-1e9);
	} else if (k === 'r' || k === 'R') {
		if (current) preview(current.path, {startTime: lastTime > 3 ? Math.max(0, lastTime - 2.5) : null});
	} else if (k === 'f' || k === 'F') {
		e.preventDefault();
		toggleFullscreen();
	}
}

window.addEventListener('keydown', handleKey);

/* 焦点在内核 iframe 里时，键盘事件不会冒泡到父窗口，这里把同一个处理挂进去 */
function attachIframeKeys() {
	try {
		const w = document.querySelector('#game').contentWindow;
		if (w && !w.__ssKeysBound) {
			w.addEventListener('keydown', handleKey);
			w.__ssKeysBound = true;
		}
	} catch (e) {}
}
document.querySelector('#game').addEventListener('load', attachIframeKeys);
setInterval(attachIframeKeys, 1500);
$('#rerun').onclick = () => current && preview(current.path, {manual: true});
$('#reload-engine').onclick = () => {
	current = null;
	iframe.src = iframe.src;
	setStatus('内核已重启');
};

/* 启动 */
(async () => {
	await refreshList();
	if (files.length) preview(files[0].path, {auto: true});
	else setStatus('这个目录还没有谱面\n把 .json 或 .ssc 放到：\n' + $('#root-path').textContent);
	/* 兜底轮询：某些编辑器用 rename 保存，fs.watch 可能漏事件 */
	setInterval(refreshList, 3000);
})();
