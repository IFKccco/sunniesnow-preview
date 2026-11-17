/* Sunniesnow PC 实时预览器
 * 监听程序所在目录（含子目录）里的 .json / .ssc，一旦被外部编辑器保存，
 * 就把最新那份谱面拼成关卡包直接喂给内核跑起来。
 */
const {app, BrowserWindow, shell} = require('electron');
const path = require('path');
const fs = require('fs');
const {startServer} = require('./server');

const isPackaged = app.isPackaged;

/* 工作目录 = 用户放谱面的地方：
 *   便携单文件 exe → exe 所在目录
 *   绿色版文件夹   → 程序文件夹的上一级（程序文件夹里有 resources）
 *   开发时         → 项目目录
 */
function resolveRoot() {
	if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
	if (!isPackaged) return __dirname;
	const exeDir = path.dirname(process.execPath);
	if (fs.existsSync(path.join(exeDir, 'resources'))) return path.dirname(exeDir);
	return exeDir;
}

const APP_ROOT = resolveRoot();

const WWW_DIR = process.env.WWW_DIR || path.join(__dirname, 'www');
const UI_DIR = path.join(__dirname, 'ui');

let win = null;

async function boot() {
	const {port} = await startServer({wwwDir: WWW_DIR, uiDir: UI_DIR, watchRoot: APP_ROOT, port: 0});
	win = new BrowserWindow({
		width: 1500,
		height: 900,
		backgroundColor: '#0f1418',
		title: 'Sunniesnow 谱面预览',
		autoHideMenuBar: true,
		icon: path.join(UI_DIR, 'icon.ico'),
		webPreferences: {contextIsolation: true, backgroundThrottling: false}
	});
	win.setMenuBarVisibility(false);
	win.loadURL(`http://127.0.0.1:${port}/`);
	win.webContents.setWindowOpenHandler(({url}) => { shell.openExternal(url); return {action: 'deny'}; });
	console.log('root', APP_ROOT, 'www', WWW_DIR, 'port', port);
}

app.whenReady().then(boot);
app.on('window-all-closed', () => app.quit());
