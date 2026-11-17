#!/usr/bin/env node
/* 把 Sunniesnow 的网页构建产物复制到 ./www
 * 用法：node scripts/prepare-kernel.js <sunniesnow-web-dir>
 * 该目录里应当有 game/index.html
 */
const fs = require('fs');
const path = require('path');

const src = process.argv[2] || process.env.SUNNIESNOW_WWW;
if (!src) {
	console.error('用法：node scripts/prepare-kernel.js <Sunniesnow 网页目录>');
	console.error('也支持环境变量 SUNNIESNOW_WWW。');
	process.exit(1);
}

const srcAbs = path.resolve(src);
if (!fs.existsSync(path.join(srcAbs, 'game', 'index.html')) && !fs.existsSync(path.join(srcAbs, 'index.html'))) {
	console.error(`这个目录里没找到 Sunniesnow 网页：${srcAbs}`);
	console.error('应该能直接看到 game/ 目录或 index.html。');
	process.exit(1);
}

const root = path.resolve(__dirname, '..');
const dst = path.join(root, 'www');

function copyDir(from, to) {
	fs.mkdirSync(to, {recursive: true});
	for (const entry of fs.readdirSync(from, {withFileTypes: true})) {
		const f = path.join(from, entry.name);
		const t = path.join(to, entry.name);
		if (entry.isDirectory()) copyDir(f, t);
		else if (entry.isFile()) fs.copyFileSync(f, t);
	}
}

fs.rmSync(dst, {recursive: true, force: true});
copyDir(srcAbs, dst);
console.log('内核已复制到', dst);
console.log('接下来：npm start 或 npm run build');
