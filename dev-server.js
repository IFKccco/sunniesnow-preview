/* 只起服务不起窗口，方便用浏览器调试 PC 预览器 */
const path = require('path');
const {startServer} = require('./server');

const WATCH = process.env.WATCH_ROOT || path.join(__dirname, 'charts');
const WWW = process.env.WWW_DIR || path.join(__dirname, 'www');

startServer({wwwDir: WWW, uiDir: path.join(__dirname, 'ui'), watchRoot: WATCH, port: Number(process.env.PORT || 8125)})
	.then(r => console.log('dev server on', r.port, 'root', WATCH));
