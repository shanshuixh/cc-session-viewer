# Claude Code Session Viewer

English | [中文](README-ZH.md)

A pure front-end H5 tool for browsing your local Claude Code session history (`~/.claude/projects/`). No deployment, no dependencies — just double-click `index.html`.

## Usage

1. Open `index.html` in Chrome / Edge
2. Click "Select projects directory", paste the path into the dialog's address bar and press Enter:
   - Windows: `%USERPROFILE%\.claude\projects`
   - macOS / Linux: `~/.claude/projects`
3. Pick a project on the left → a session

Selecting `.claude` or your home directory also locates `projects` automatically; you can also drag the folder onto the page.

### Set the directory only once

The first directory you choose is saved in the browser (IndexedDB, scoped per browser + page path). Afterwards the page uses it automatically and no longer shows the picker.

- Each time the browser reopens the page it asks to confirm read permission: click anywhere on the page to trigger the prompt. If "Allow on every visit" is offered, choose it and you won't be asked again.
- The last opened directory is used by default. To change it, click 📂 at the top (next to the refresh button), or "Change directory" at the bottom left (asks for confirmation and clears the saved directory).
- The setting is not stored in a `setting.json` file: a locally opened web page can't write files to disk, nor read a directory from a path string alone.
- Firefox / Safari don't support persisting directory handles, so you need to choose each time (fallback mode, reads a snapshot).

## Features

- Project list (sorted by recent use, showing real paths) → session list (AI title, time, size)
- Conversation rendering: Markdown, thinking, tool calls (commands, Edit diffs, TodoWrite, results), images, slash commands
- Sub-agent (Agent) sessions expanded inline
- Session info: directory, branch, model, duration, token usage, cost, one-click copy of the `claude --resume` command
- Project / title filtering, full-text search across all sessions with jump-to-match
- Project memory viewer
- Light / dark theme, drawer layout on mobile

Data is read only in your local browser and never uploaded.

## Structure

```
index.html
css/app.css
js/md.js       Markdown rendering
js/fs.js       Directory reading (File System Access / webkitdirectory / drag & drop)
js/render.js   Session rendering
js/app.js      Sidebar, routing, search
```
