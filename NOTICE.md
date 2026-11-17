# NOTICE

本项目（Sunniesnow 谱面预览器）复用了 [Sunniesnow](https://github.com/sunniesnow/sunniesnow) 的网页内核来渲染与演奏谱面。

- 上游项目：Sunniesnow
- 作者：UlyssesZhan <ulysseszhan@gmail.com>
- 项目主页：https://sunniesnow.github.io/
- 源代码：https://github.com/sunniesnow/sunniesnow
- 许可证：GNU Affero General Public License v3.0（AGPL-3.0）

`www/` 目录即上述内核的副本，不随本仓库分发。构建前请自行取得上游产物并按 AGPL-3.0 的要求保留其许可证与署名。

本仓库新增的部分为外壳与工作流：Electron 主进程、本地 HTTP/SSE 服务、预览界面（`main.js`、`server.js`、`ui/`），同样以 AGPL-3.0-or-later 发布。
