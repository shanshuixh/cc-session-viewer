# Claude Code 会话浏览

本地浏览 Claude Code 历史会话记录（`~/.claude/projects/`）的纯前端 H5 工具，无需部署、无依赖，双击 `index.html` 即可使用。

## 使用

1. 用 Chrome / Edge 打开 `index.html`
2. 点击「选择 projects 目录」，在对话框地址栏粘贴路径后回车：
   - Windows：`%USERPROFILE%\.claude\projects`
   - macOS / Linux：`~/.claude/projects`
3. 左侧选择工程 → 会话

选中 `.claude` 或用户主目录也会自动定位到 `projects`；也可以把文件夹直接拖到页面上。

### 目录只设置一次

首次选择的目录会保存在浏览器里（IndexedDB，按浏览器 + 本页面路径区分），之后打开页面自动使用该目录，不再显示选择入口。

- 浏览器每次重新打开页面会要求确认读取权限：在页面上任意点一下即弹出授权；授权时若出现「每次访问时都允许」，选它以后就不再询问。
- 默认使用上次打开的目录；需要更换时，点顶部 📂（刷新按钮旁）重新设置，或点左下角「更换目录」（会二次确认并清除已保存的目录）。
- 保存位置不是 `setting.json` 文件：直接打开的本地网页无法写入磁盘文件，也无法仅凭路径字符串读取目录。
- Firefox / Safari 不支持保存目录句柄，仍需每次选择（兼容模式，读取的是快照）。

## 功能

- 工程列表（按最近使用排序，显示真实路径）→ 会话列表（AI 标题、时间、大小）
- 对话渲染：Markdown、思考过程、工具调用（命令、Edit diff、TodoWrite、结果）、图片、斜杠命令
- 子代理（Agent）会话内嵌展开
- 会话信息：目录、分支、模型、耗时、token 用量、费用，一键复制 `claude --resume` 命令
- 工程 / 标题筛选、全部会话全文搜索并跳转定位
- 工程记忆（memory）查看
- 明暗主题、手机端抽屉布局

数据只在本地浏览器中读取，不会上传。

## 结构

```
index.html
css/app.css
js/md.js       Markdown 渲染
js/fs.js       目录读取（File System Access / webkitdirectory / 拖拽）
js/render.js   会话渲染
js/app.js      侧边栏、路由、搜索
```
