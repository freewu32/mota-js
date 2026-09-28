# AGENTS.md

HTML5 魔塔（Magic Tower）游戏样板/引擎 + 可视化编辑器。纯浏览器端 JS，没有 `package.json`、构建、lint 或测试；所有"运行/验证"都靠本地 HTTP 服务 + 浏览器。

## 启动服务（开发入口）

- `node server.js`：在**仓库根目录**运行，无需 `npm install`（只用 Node 内置模块）。端口从 `3000` 起自增，带热重载。
  - 启动时会同步读取 `./project/data.js` 并 `JSON.parse`（去掉首行 `var xxx = `），所以必须在根目录运行，且不要改动该文件的整体结构。
- `python server.py`：需 `pip install flask`。端口从 `1055` 起自增，**绝对路径必须全英文**，无热重载（与官方文档一致）。
- Windows：双击 `启动服务.exe`。
- 之后访问 `http://127.0.0.1:<port>/index.html`（游戏）和 `/editor.html`（编辑器，竖屏用 `editor-mobile.html`）。

> 编辑器读写文件依赖服务端的 `/readFile`、`/writeFile`、`/listFile` 等 POST 接口（见 `_server/fs.js`），并用服务端生成的 `__all_floors__.js` 批量加载楼层。**不能用任意静态服务器替代**，否则编辑器/楼层无法工作。

## 验证

- 没有测试、lint、typecheck 脚本。验证方式：起服务后打开页面看浏览器控制台报错。
- 单文件语法检查可用 `node --check <file.js>`。
- `tsconfig.json` 只服务编辑器/VSCode 的 JS 智能提示（`allowJs` + `noEmit`），**不要运行 `tsc`**。

## 架构要点

- `index.html` + `main.js`：游戏入口（`main.init('play')`）。`main.loadList` 定义 `libs/` 的固定加载顺序，`main.pureData` 定义 `project/` 的数据文件。
- `libs/`：引擎运行时（`core` 入口 + 转发，`control` 逻辑，`events` 事件，`maps`/`ui`/`loader`/`actions`/`enemys`/`items` 等）。`libs/*.js` 会把 `icons`/`items` 等转发到 `project/` 的数据。
- `project/`：**用户自己的塔**的内容（数据、剧本、素材）。
- `editor.html`（+`editor-mobile.html`）与 `_server/`：可视化编辑器。`_server/README.md` 讲编辑器内部结构，`_server/refactoring.md` 讲待重构方向（目前维持稳定，计划 3.0 重写）。

### 加载顺序与数据约定（易踩坑）

- `main.init` **先**加载 `project/` 的 pureData（`data`/`enemys`/`icons`/`maps`/`items`/`functions`/`events`/`plugins`），**再**加载 `libs/`。project 文件提供 libs 依赖的全局变量，顺序不能反。
- `project/*.js` 顶层的全局变量名带**硬编码 GUID 后缀**，例如 `data_a1e2fb4a_e986_4524_b0da_9b7ba7c0874d`、`functions_d6ad677b_427a_4623_b50f_a445a3b0ef8a`。它们被 `libs/*.js` 和 `_server` 直接引用（如 `libs/data.js`）。**不要重命名**。
- `project/floors/*.js` 由服务端动态生成的 `__all_floors__.js` 批量加载；`main.useCompress == true` 时改为 `project/floors.min.js`。
- `project/` 的数据由编辑器的表格结构（`_server/table/*.comment.js`）驱动，编辑器用带特殊 replacer 的 `JSON.stringify` 写回。**改数据优先用编辑器**，手改 `project/*.js` 容易破坏编辑器可解析性。
- `main.useCompress`（`main.js` 顶部）开发时必须为 `false`；只有发布前用 JS 压缩工具生成 `*.min.js` 后才置 `true`（届时读 `libs/*.min.js`、`project/floors.min.js`）。
- 改动脚本后建议同步提升 `main.version`，它被用作 `?v=` 缓存参数。
- `extensions/` 下的 JS 仅在通过本地服务运行时由 `libs/extensions.js` 动态加载，发布到网站不会加载。

## 类型与文档

- `runtime.d.ts`：`project/` 脚本的类型标注，脚本顶部用 `///<reference path='../runtime.d.ts'/>` 引入；`runtime.min.d.ts` 供内嵌 Monaco（`extensions/ui-editor/`）使用。
- 用户文档在 `_docs/`（docsify），教程在 `_codelab/`；`README.md` 主要是版本更新日志。
- 代码风格：中文注释，ES5 风格（`var`、prototype 构造函数），与周边保持一致。

## 其他

- 分支：`master`。提交信息为中文。
- `.gitignore` 排除 `_server/config.json`、`_saves/`、`dist/`、`_ui/`、`*.zip`、`node_modules`，不要提交。
- 工作区当前删除了 `.github/workflows/codeql.yml`（git 中仍跟踪）；该文件是唯一 CI（CodeQL，js + python），非必要不要擅自恢复或改动。
