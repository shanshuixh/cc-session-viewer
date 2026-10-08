(() => {
  const $ = s => document.querySelector(s);
  const { el, fmtTime, fmtDur, fmtNum } = R;
  const esc = MD.esc;

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 无痕模式 */ } },
  };

  const S = {
    rootNode: null, rootName: '', mode: null, projects: [],
    expanded: new Set(store.get('cc-expanded', [])),
    filter: '', cur: null,
  };
  const settings = Object.assign({ thinking: true, tools: true, meta: false, system: false }, store.get('cc-settings', {}));

  // ---------- 通用 ----------
  function toast(msg, ms = 2200) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), ms);
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = el('textarea'); ta.value = text; document.body.append(ta); ta.select();
      document.execCommand('copy'); ta.remove();
    }
    toast('已复制：' + (text.length > 60 ? text.slice(0, 60) + '…' : text));
  }
  function relTime(ms) {
    if (!ms) return '';
    const d = new Date(ms), now = new Date();
    const p = n => String(n).padStart(2, '0');
    const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
    const day = 864e5, startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (ms >= startToday) return '今天 ' + hm;
    if (ms >= startToday - day) return '昨天 ' + hm;
    if (d.getFullYear() === now.getFullYear()) return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  const fmtSize = b => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
  const baseName = p => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  const projName = p => p.cwd ? baseName(p.cwd) : p.dir;
  const sessTitle = s => {
    const m = s.meta;
    if (!m) return s.size === 0 ? '（空会话）' : '加载中…';
    return m.customTitle || m.aiTitle || m.summary || m.firstPrompt || m.lastPrompt || '（无标题）';
  };

  // ---------- 目录扫描 ----------
  async function scan(rootNode) {
    const pr = await FS.resolveProjectsRoot(rootNode);
    const dirs = (await pr.list()).filter(n => n.kind === 'dir');
    const projects = await Promise.all(dirs.map(async d => {
      const p = { dir: d.name, node: d, sessions: [], sessionDirs: new Map(), memory: null, cwd: null, last: 0 };
      for (const c of await d.list()) {
        if (c.kind === 'file' && c.name.endsWith('.jsonl')) {
          const f = await c.file();
          p.sessions.push({ id: c.name.slice(0, -6), node: c, size: f.size, mtime: f.lastModified, project: p, meta: null });
        } else if (c.kind === 'dir') {
          if (c.name === 'memory') p.memory = c; else p.sessionDirs.set(c.name, c);
        }
      }
      p.sessions.sort((a, b) => b.mtime - a.mtime);
      p.last = p.sessions[0]?.mtime || 0;
      return p;
    }));
    return { name: pr.name, projects: projects.filter(p => p.sessions.length || p.memory).sort((a, b) => b.last - a.last) };
  }

  // 只读文件头尾，快速拿到标题 / cwd
  function scanLines(lines, m) {
    for (const line of lines) {
      if (!line || line[0] !== '{') continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type === 'ai-title' && o.aiTitle) m.aiTitle = o.aiTitle;
      else if (o.type === 'custom-title' && o.customTitle) m.customTitle = o.customTitle;
      else if (o.type === 'summary' && o.summary) m.summary = m.summary || o.summary;
      else if (o.type === 'last-prompt' && o.lastPrompt) m.lastPrompt = o.lastPrompt;
      if (!m.cwd && o.cwd) m.cwd = o.cwd;
      if (o.timestamp && !m.start) m.start = o.timestamp;
      if (!m.firstPrompt && o.type === 'user' && !o.isMeta && !o.isSidechain) {
        const t = R.userContentText(o.message?.content).trim();
        const cmd = t.match(/<command-name>([\s\S]*?)<\/command-name>/);
        if (cmd) m.firstCmd = m.firstCmd || cmd[1] + ' ' + ((t.match(/<command-args>([\s\S]*?)<\/command-args>/) || [])[1] || '');
        else if (t && !t.startsWith('<')) m.firstPrompt = t.replace(/\s+/g, ' ').slice(0, 160);
      }
    }
  }
  async function loadMeta(s) {
    if (s.meta) return s.meta;
    const f = await s.node.file();
    const m = {};
    const HEAD = 256 * 1024, TAIL = 128 * 1024;
    scanLines((await f.slice(0, HEAD).text()).split('\n'), m);
    if (f.size > HEAD) {
      const ls = (await f.slice(Math.max(HEAD, f.size - TAIL)).text()).split('\n');
      ls.shift();
      scanLines(ls, m);
    }
    if (!m.firstPrompt && m.firstCmd) m.firstPrompt = m.firstCmd.trim();
    s.meta = m; s.size = f.size; s.mtime = f.lastModified;
    if (!s.project.cwd && m.cwd) s.project.cwd = m.cwd;
    return m;
  }
  async function loadMetas(list) {
    let i = 0;
    const worker = async () => {
      while (i < list.length) {
        const s = list[i++];
        if (s.meta) continue;
        try { await loadMeta(s); } catch { s.meta = {}; }
        scheduleTree();
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
  }

  // ---------- 侧边栏 ----------
  let treeRaf = 0;
  const scheduleTree = () => { if (!treeRaf) treeRaf = requestAnimationFrame(() => { treeRaf = 0; renderTree(); }); };

  function renderTree() {
    const tree = $('#tree');
    const scroll = tree.scrollTop;
    tree.innerHTML = '';
    if (!S.projects.length) {
      tree.append(el('div', 'empty-tip', S.rootNode ? '该目录下没有找到会话记录' : '尚未打开目录'));
      return;
    }
    const q = S.filter.trim().toLowerCase();
    let shown = 0;
    for (const p of S.projects) {
      const name = projName(p);
      const pMatch = !q || name.toLowerCase().includes(q) || (p.cwd || p.dir).toLowerCase().includes(q);
      const sess = q && !pMatch ? p.sessions.filter(s => sessTitle(s).toLowerCase().includes(q) || s.id.includes(q)) : p.sessions;
      if (q && !pMatch && !sess.length) continue;
      shown++;
      const open = S.expanded.has(p.dir) || (q && !pMatch);
      const pe = el('div', 'proj' + (open ? ' open' : ''));
      const row = el('div', 'proj-row', `
        <span class="chev">›</span>
        <div class="proj-text">
          <div class="proj-name">${esc(name)}</div>
          <div class="proj-path" title="${esc(p.cwd || p.dir)}">${esc(p.cwd || p.dir)}</div>
        </div>
        <span class="badge">${p.sessions.length}</span>`);
      row.onclick = () => {
        if (S.expanded.has(p.dir)) S.expanded.delete(p.dir); else { S.expanded.add(p.dir); loadMetas(p.sessions); }
        store.set('cc-expanded', [...S.expanded]);
        renderTree();
      };
      pe.append(row);
      if (open) {
        const list = el('div', 'sess-list');
        for (const s of sess) {
          const active = S.cur?.session === s;
          const se = el('div', 'sess' + (active ? ' active' : ''), `
            <div class="sess-title">${esc(sessTitle(s))}</div>
            <div class="sess-meta"><span>${relTime(s.mtime)}</span><span>${fmtSize(s.size)}</span><span class="sid">${esc(s.id.slice(0, 8))}</span></div>`);
          se.title = s.id;
          se.onclick = () => openSession(s);
          list.append(se);
        }
        if (p.memory && !q) {
          const me = el('div', 'sess mem' + (S.cur?.memory === p ? ' active' : ''), '<div class="sess-title">📝 记忆 memory</div>');
          me.onclick = () => openMemory(p);
          list.append(me);
        }
        pe.append(list);
      }
      tree.append(pe);
    }
    if (!shown) tree.append(el('div', 'empty-tip', '没有匹配的工程或会话'));
    tree.scrollTop = scroll;
  }

  // ---------- 打开目录 ----------
  async function loadRoot(node, mode) {
    S.rootNode = node; S.mode = mode;
    $('#tree').innerHTML = '<div class="empty-tip">正在扫描…</div>';
    try {
      const { name, projects } = await scan(node);
      S.rootName = name; S.projects = projects;
    } catch (e) {
      $('#tree').innerHTML = `<div class="empty-tip">读取失败：${esc(e.message)}${S.saved ? '<br>已保存的目录可能已被移动或删除，可点左下角「更换目录」' : ''}</div>`;
      updateLockUI();
      return;
    }
    updateLockUI();
    renderTree();
    // 先加载展开的工程，再为每个工程取一个会话拿到真实路径
    await loadMetas(S.projects.filter(p => S.expanded.has(p.dir)).flatMap(p => p.sessions));
    await loadMetas(S.projects.map(p => p.sessions[0]).filter(Boolean));
    if (!S.cur) routeFromHash() || showHome();
  }

  // 选择后保存句柄到浏览器（IndexedDB），之后默认使用上次的目录；顶部 📂 按钮仍可随时重新设置
  async function saveHandle(h) {
    try { await FS.idbSet('root', h); S.saved = true; S.savedName = h.name; } catch { /* 无法持久化时下次需重新选择 */ }
  }

  function updateLockUI() {
    $('#btnPick').title = S.saved || S.pendingHandle ? '重新设置目录' : '选择目录';
    const foot = $('#sideFoot');
    const total = S.projects.reduce((n, p) => n + p.sessions.length, 0);
    const info = S.rootNode
      ? `${S.rootName} · ${S.projects.length} 个工程 · ${total} 个会话${S.mode === 'files' ? ' · 快照模式' : ''}`
      : S.pendingHandle ? `已保存目录：${S.pendingHandle.name}（待授权）` : '';
    foot.innerHTML = `<span class="foot-info" title="${esc(info)}">${esc(info)}</span>`;
    if (S.saved || S.pendingHandle) {
      const b = el('button', 'link-btn', '更换目录');
      b.title = '清除已保存的目录，重新选择';
      b.onclick = resetDirectory;
      foot.append(b);
    }
  }

  async function resetDirectory() {
    if (!confirm(`当前固定使用目录「${S.savedName || S.pendingHandle?.name || S.rootName}」。\n确定要清除它并重新选择吗？`)) return;
    try { await FS.idbDel('root'); } catch { /* 忽略 */ }
    Object.assign(S, { saved: false, savedName: '', pendingHandle: null, rootNode: null, rootName: '', mode: null, projects: [], cur: null });
    history.replaceState(null, '', '#');
    renderTree();
    updateLockUI();
    showHome();
    pickDirectory();
  }

  async function pickDirectory() {
    if (FS.supportsPicker) {
      try {
        const h = await window.showDirectoryPicker({ id: 'cc-projects', mode: 'read' });
        await saveHandle(h);
        S.pendingHandle = null;
        S.cur = null;
        await loadRoot(FS.fromHandle(h), 'handle');
      } catch (e) {
        if (e.name !== 'AbortError') { toast('无法打开目录：' + e.message + '，改用兼容方式'); $('#dirInput').click(); }
      }
    } else {
      $('#dirInput').click();
    }
  }

  async function tryRestore() {
    if (!FS.supportsPicker) return false;
    let h;
    try { h = await FS.idbGet('root'); } catch { return false; }
    if (!h) return false;
    S.savedName = h.name;
    let perm = 'prompt';
    try { perm = await h.queryPermission({ mode: 'read' }); } catch { /* 忽略 */ }
    if (perm === 'granted') { S.saved = true; await loadRoot(FS.fromHandle(h), 'handle'); return true; }
    // 浏览器要求用户操作后才能重新授权：页面上任意一次点击或按键即触发授权
    S.pendingHandle = h;
    const onGesture = e => {
      if (e.target.closest?.('.link-btn, #btnPick')) return; // 点「更换目录」或重新设置目录时不弹授权
      document.removeEventListener('pointerdown', onGesture, true);
      document.removeEventListener('keydown', onGesture, true);
      if (S.pendingHandle) reopenPending();
    };
    document.addEventListener('pointerdown', onGesture, true);
    document.addEventListener('keydown', onGesture, true);
    updateLockUI();
    return false;
  }

  async function reopenPending() {
    const h = S.pendingHandle;
    if (!h || S.requesting) return;
    S.requesting = true;
    try {
      if ((await h.requestPermission({ mode: 'read' })) === 'granted') {
        S.pendingHandle = null; S.saved = true;
        await loadRoot(FS.fromHandle(h), 'handle');
      } else toast('需要授权才能读取已保存的目录');
    } catch (e) { toast('授权失败：' + e.message); }
    S.requesting = false;
  }

  async function refresh() {
    if (S.pendingHandle && !S.rootNode) return reopenPending();
    if (!S.rootNode) return pickDirectory();
    if (S.mode === 'files') { toast('兼容模式下数据是快照，请重新选择目录以刷新'); return; }
    const cur = S.cur?.session ? { dir: S.cur.session.project.dir, id: S.cur.session.id } : null;
    const keepMeta = new Map(S.projects.flatMap(p => p.sessions.map(s => [p.dir + '/' + s.id, s])));
    const { projects } = await scan(S.rootNode);
    for (const p of projects) for (const s of p.sessions) {
      const old = keepMeta.get(p.dir + '/' + s.id);
      if (old && old.meta && old.mtime === s.mtime) { s.meta = old.meta; if (!p.cwd) p.cwd = old.meta.cwd || null; }
    }
    S.projects = projects;
    renderTree();
    loadMetas(projects.filter(p => S.expanded.has(p.dir)).flatMap(p => p.sessions));
    loadMetas(projects.map(p => p.sessions[0]).filter(Boolean));
    if (cur) {
      const s = findSession(cur.dir, cur.id);
      if (s) openSession(s, { keepScroll: true });
    }
    toast('已刷新');
  }

  // ---------- 主视图 ----------
  const view = () => $('#view');
  function setCrumb(parts) { $('#crumb').innerHTML = parts.map(p => `<span>${esc(p)}</span>`).join('<i>/</i>'); }

  function showHome() {
    S.cur = null;
    setCrumb(['Claude Code 会话浏览']);
    const v = view();
    v.innerHTML = '';
    const home = el('div', 'home');
    const pending = S.pendingHandle;
    const intro = `
      <h1>Claude Code 会话浏览</h1>
      <p class="lead">浏览本机 Claude Code 保存的全部历史会话。数据只在本地浏览器中读取，不会上传到任何地方。</p>`;
    if (pending || S.saved) {
      home.innerHTML = intro + (pending ? `
        <div class="home-actions"><button class="btn primary" id="hReopen">读取已保存的目录（${esc(pending.name)}）</button></div>
        <p class="muted">浏览器每次重新打开页面都需要确认一次读取权限。授权时如果出现<b>「每次访问时都允许」</b>，选它以后就不会再询问。</p>`
        : `<p class="muted">已加载目录「${esc(S.rootName)}」：${S.projects.length} 个工程，请在左侧选择会话。</p>`) +
        `<p class="muted small-note">默认使用上次的目录。如需更换，点顶部 📂 重新设置，或点左下角「更换目录」。</p>`;
      v.append(home);
      if (pending) $('#hReopen').onclick = reopenPending;
      return;
    }
    home.innerHTML = intro + `
      <div class="home-actions">
        <button class="btn primary" id="hPick">选择 projects 目录</button>
      </div>
      <div class="paths">
        <div class="path-row"><span class="os">Windows</span><code>%USERPROFILE%\\.claude\\projects</code><button class="btn small" data-copy="%USERPROFILE%\\.claude\\projects">复制</button></div>
        <div class="path-row"><span class="os">macOS / Linux</span><code>~/.claude/projects</code><button class="btn small" data-copy="~/.claude/projects">复制</button></div>
      </div>
      <ol class="steps">
        <li>点击「选择 projects 目录」，在弹出的对话框地址栏中<b>粘贴上面的路径</b>后回车，再点「选择文件夹」。（<code>.claude</code> 是隐藏目录，直接粘贴路径最方便；选中 <code>.claude</code> 或用户主目录也能自动识别。）</li>
        <li><b>目录只需设置一次</b>：Chrome / Edge 会保存该目录，以后打开本页面默认使用上次的目录；需要时可点顶部 📂 重新设置。Firefox / Safari 不支持保存，使用兼容方式读取（数据为快照，刷新需重新选择）。</li>
        <li>也可以直接把 <code>projects</code> 文件夹<b>拖拽</b>到本页面。</li>
      </ol>
      ${S.projects.length ? `<p class="muted">已加载 ${S.projects.length} 个工程，请在左侧选择会话。</p>` : ''}`;
    v.append(home);
    home.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => copy(b.dataset.copy));
    $('#hPick').onclick = pickDirectory;
  }

  function findSession(dir, id) {
    const p = S.projects.find(x => x.dir === dir);
    return p?.sessions.find(s => s.id === id);
  }
  function routeFromHash() {
    const h = decodeURIComponent(location.hash.slice(1));
    const i = h.lastIndexOf('/');
    if (i < 0) return false;
    const s = findSession(h.slice(0, i), h.slice(i + 1));
    if (!s) return false;
    if (!S.expanded.has(s.project.dir)) { S.expanded.add(s.project.dir); loadMetas(s.project.sessions); }
    openSession(s);
    return true;
  }

  async function loadSubagents(s) {
    const out = { byTool: new Map(), byAgent: new Map(), count: 0 };
    const dir = s.project.sessionDirs.get(s.id);
    if (!dir) return out;
    try {
      const sub = (await dir.list()).find(n => n.kind === 'dir' && n.name === 'subagents');
      if (!sub) return out;
      const files = await sub.list();
      const metas = files.filter(f => f.name.endsWith('.meta.json'));
      for (const f of files) {
        if (!f.name.endsWith('.jsonl')) continue;
        out.byAgent.set(f.name.replace(/^agent-/, '').replace(/\.jsonl$/, ''), f);
        out.count++;
      }
      await Promise.all(metas.map(async m => {
        try {
          const j = JSON.parse(await (await m.file()).text());
          const jsonl = files.find(f => f.name === m.name.replace(/\.meta\.json$/, '.jsonl'));
          if (j.toolUseId && jsonl) out.byTool.set(j.toolUseId, jsonl);
        } catch { /* 忽略 */ }
      }));
    } catch { /* 忽略 */ }
    return out;
  }

  function applySettings(root) {
    root.classList.toggle('hide-thinking', !settings.thinking);
    root.classList.toggle('hide-tools', !settings.tools);
    root.classList.toggle('hide-meta', !settings.meta);
    root.classList.toggle('hide-system', !settings.system);
  }

  async function openSession(s, opts = {}) {
    const prevScroll = view().scrollTop;
    S.cur = { session: s };
    const hash = '#' + encodeURIComponent(s.project.dir + '/' + s.id);
    if (location.hash !== hash) history.replaceState(null, '', hash);
    renderTree();
    closeDrawer();
    setCrumb([projName(s.project), sessTitle(s)]);
    const v = view();
    if (!opts.keepScroll) v.innerHTML = '<div class="loading">正在读取会话…</div>';
    let recs, subagents;
    try {
      const f = await s.node.file();
      s.size = f.size; s.mtime = f.lastModified;
      [recs, subagents] = await Promise.all([f.text().then(R.parseJSONL), loadSubagents(s)]);
    } catch (e) {
      v.innerHTML = `<div class="loading">读取失败：${esc(e.message)}</div>`;
      return;
    }
    if (S.cur?.session !== s) return;
    await loadMeta(s).catch(() => {});
    setCrumb([projName(s.project), sessTitle(s)]);

    const { frag, stats } = R.renderConversation(recs, { subagents });
    v.innerHTML = '';
    const page = el('div', 'session');
    applySettings(page);

    const cwd = stats.cwd || s.project.cwd || '';
    const resume = cwd ? `cd "${cwd}" && claude --resume ${s.id}` : `claude --resume ${s.id}`;
    const dur = stats.start && stats.end ? fmtDur(new Date(stats.end) - new Date(stats.start)) : '';
    const head = el('div', 'sess-head');
    head.innerHTML = `
      <h1>${esc(sessTitle(s))}</h1>
      <div class="meta-grid">
        ${cwd ? `<div><span class="k">目录</span><span class="v mono">${esc(cwd)}</span></div>` : ''}
        <div><span class="k">会话</span><span class="v mono">${esc(s.id)}</span></div>
        <div><span class="k">时间</span><span class="v">${fmtTime(stats.start)} → ${fmtTime(stats.end)}${dur ? `（${dur}）` : ''}</span></div>
        ${stats.models.size ? `<div><span class="k">模型</span><span class="v">${esc([...stats.models].join(', '))}</span></div>` : ''}
        ${stats.branch || stats.version ? `<div><span class="k">环境</span><span class="v">${stats.branch ? '分支 ' + esc(stats.branch) : ''}${stats.version ? ' · Claude Code ' + esc(stats.version) : ''}</span></div>` : ''}
      </div>
      <div class="chips">
        <span class="chip">提问 <b>${stats.user}</b></span>
        <span class="chip">回复 <b>${stats.assistant}</b></span>
        <span class="chip">工具调用 <b>${stats.tools}</b></span>
        ${subagents.count ? `<span class="chip">子代理 <b>${subagents.count}</b></span>` : ''}
        <span class="chip">输入 tokens <b>${fmnum(stats.inTok)}</b></span>
        <span class="chip">输出 tokens <b>${fmnum(stats.outTok)}</b></span>
        ${stats.cost != null ? `<span class="chip">费用 <b>$${stats.cost.toFixed(2)}</b></span>` : ''}
        <span class="chip">${fmtSize(s.size)}</span>
      </div>
      <div class="head-actions">
        <button class="btn small" data-act="resume" title="${esc(resume)}">复制恢复命令</button>
        <button class="btn small" data-act="id">复制会话 ID</button>
        <button class="btn small" data-act="expand">展开全部工具</button>
        <button class="btn small" data-act="collapse">全部折叠</button>
        <button class="btn small" data-act="bottom">跳到末尾</button>
      </div>
      <div class="toggles">
        ${toggle('thinking', '思考过程')}${toggle('tools', '工具调用')}${toggle('meta', '附件 / 系统提醒')}${toggle('system', '系统事件')}
      </div>`;
    function toggle(k, label) { return `<label class="tg"><input type="checkbox" data-set="${k}" ${settings[k] ? 'checked' : ''}><span>${label}</span></label>`; }
    function fmnum(n) { return fmtNum(n); }
    head.querySelectorAll('[data-set]').forEach(cb => cb.onchange = () => {
      settings[cb.dataset.set] = cb.checked; store.set('cc-settings', settings); applySettings(page);
    });
    head.querySelector('[data-act=resume]').onclick = () => copy(resume);
    head.querySelector('[data-act=id]').onclick = () => copy(s.id);
    head.querySelector('[data-act=expand]').onclick = () => page.querySelectorAll('details.tool').forEach(d => { d.open = true; });
    head.querySelector('[data-act=collapse]').onclick = () => page.querySelectorAll('.conv details').forEach(d => { d.open = false; });
    head.querySelector('[data-act=bottom]').onclick = () => { v.scrollTop = v.scrollHeight; };

    const conv = el('div', 'conv');
    conv.append(frag);
    if (!conv.childElementCount) conv.append(el('div', 'empty-tip', '这个会话没有可显示的消息'));
    page.append(head, conv);
    v.append(page);
    if (opts.keepScroll) v.scrollTop = prevScroll;
    else if (opts.uuid) scrollToUuid(page, opts.uuid);
    else v.scrollTop = 0;
  }

  function scrollToUuid(page, uuid) {
    const t = page.querySelector(`[data-uuid="${CSS.escape(uuid)}"]`);
    if (!t) return;
    // 若目标被开关隐藏，临时打开对应开关
    const need = t.classList.contains('thinking') ? 'thinking' : t.classList.contains('tool') ? 'tools' : null;
    if (need && !settings[need]) {
      settings[need] = true; store.set('cc-settings', settings); applySettings(page);
      const cb = page.querySelector(`[data-set=${need}]`); if (cb) cb.checked = true;
    }
    if (t.tagName === 'DETAILS') t.open = true;
    for (let p = t.parentElement; p; p = p.parentElement) if (p.tagName === 'DETAILS') p.open = true;
    t.scrollIntoView({ block: 'center' });
    t.classList.add('flash');
    setTimeout(() => t.classList.remove('flash'), 2400);
  }

  async function openMemory(p) {
    S.cur = { memory: p };
    history.replaceState(null, '', '#');
    renderTree(); closeDrawer();
    setCrumb([projName(p), '记忆']);
    const v = view();
    v.innerHTML = '<div class="loading">读取中…</div>';
    const files = (await p.memory.list()).filter(f => f.kind === 'file').sort((a, b) => (a.name === 'MEMORY.md' ? -1 : b.name === 'MEMORY.md' ? 1 : a.name.localeCompare(b.name)));
    const page = el('div', 'session');
    page.append(el('div', 'sess-head', `<h1>记忆 · ${esc(projName(p))}</h1><div class="muted">${files.length} 个文件</div>`));
    if (!files.length) page.append(el('div', 'empty-tip', '记忆目录是空的'));
    for (const f of files) {
      const text = await (await f.file()).text();
      const card = el('div', 'mem-card');
      card.append(el('div', 'mem-name', esc(f.name)), el('div', 'md', MD.render(text.replace(/^---\n[\s\S]*?\n---\n/, m => '```yaml\n' + m.replace(/^---\n|---\n$/g, '') + '```\n'))));
      page.append(card);
    }
    v.innerHTML = '';
    v.append(page);
    v.scrollTop = 0;
  }

  // ---------- 全文搜索 ----------
  let searchToken = 0;
  function showSearch() {
    if (!S.projects.length) { toast('请先选择目录'); return; }
    S.cur = { search: true };
    history.replaceState(null, '', '#');
    renderTree(); closeDrawer();
    setCrumb(['全文搜索']);
    const v = view();
    v.innerHTML = '';
    const page = el('div', 'search-page');
    page.innerHTML = `
      <h1>全文搜索</h1>
      <form class="search-form"><input type="search" placeholder="搜索全部会话中的提问、回复、思考与工具参数…" value="${esc(S.lastQuery || '')}"><button class="btn primary">搜索</button></form>
      <div class="search-scope"><label><input type="checkbox" class="cur-proj"> 仅搜索当前展开的工程</label></div>
      <div class="search-status muted"></div>
      <div class="search-results"></div>`;
    v.append(page);
    const input = page.querySelector('input[type=search]');
    input.focus();
    page.querySelector('form').onsubmit = e => { e.preventDefault(); runSearch(input.value.trim(), page); };
    if (S.lastQuery) runSearch(S.lastQuery, page);
  }

  async function runSearch(q, page) {
    if (!q) return;
    S.lastQuery = q;
    const token = ++searchToken;
    const ql = q.toLowerCase();
    const status = page.querySelector('.search-status');
    const box = page.querySelector('.search-results');
    box.innerHTML = '';
    const onlyExpanded = page.querySelector('.cur-proj').checked;
    const sessions = S.projects.filter(p => !onlyExpanded || S.expanded.has(p.dir)).flatMap(p => p.sessions);
    let hits = 0, done = 0, matchedSess = 0;
    const MAX = 500;
    const reHi = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    for (const s of sessions) {
      if (token !== searchToken) return;
      done++;
      status.textContent = `正在搜索 ${done}/${sessions.length} 个会话… 已找到 ${hits} 处`;
      let text;
      try { text = await (await s.node.file()).text(); } catch { continue; }
      if (!text.toLowerCase().includes(ql)) continue;
      const found = [];
      for (const line of text.split('\n')) {
        if (found.length >= 30) break;
        if (!line.toLowerCase().includes(ql)) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        for (const t of R.searchTexts(o)) {
          const idx = t.text.toLowerCase().indexOf(ql);
          if (idx < 0) continue;
          const from = Math.max(0, idx - 60);
          const snip = (from ? '…' : '') + t.text.slice(from, idx + q.length + 100).replace(/\s+/g, ' ');
          found.push({ uuid: o.uuid, role: t.role, snip, ts: o.timestamp });
          break;
        }
      }
      if (!found.length) continue;
      if (!s.meta) await loadMeta(s).catch(() => {});
      matchedSess++;
      const grp = el('div', 'hit-group');
      grp.append(el('div', 'hit-head', `<b>${esc(sessTitle(s))}</b><span class="muted">${esc(projName(s.project))} · ${relTime(s.mtime)} · ${found.length} 处</span>`));
      for (const h of found) {
        const it = el('div', 'hit', `<span class="role">${esc(h.role)}</span><span class="snip">${esc(h.snip).replace(reHi, m => `<mark>${m}</mark>`)}</span>`);
        it.onclick = () => {
          if (!S.expanded.has(s.project.dir)) { S.expanded.add(s.project.dir); loadMetas(s.project.sessions); }
          openSession(s, { uuid: h.uuid });
        };
        grp.append(it);
      }
      box.append(grp);
      hits += found.length;
      if (hits >= MAX) break;
    }
    if (token !== searchToken) return;
    status.textContent = hits ? `共在 ${matchedSess} 个会话中找到 ${hits} 处${hits >= MAX ? '（已达上限，请缩小关键词）' : ''}` : '没有找到匹配内容';
  }

  // ---------- 移动端抽屉 ----------
  const closeDrawer = () => document.body.classList.remove('drawer');
  $('#btnMenu').onclick = () => document.body.classList.toggle('drawer');
  $('#backdrop').onclick = closeDrawer;

  // ---------- 主题 ----------
  function applyTheme(t) {
    if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  }
  applyTheme(store.get('cc-theme', null));
  $('#btnTheme').onclick = () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    const t = dark ? 'light' : 'dark';
    applyTheme(t); store.set('cc-theme', t);
  };

  // ---------- 事件绑定 ----------
  $('#btnPick').onclick = pickDirectory;
  $('#btnRefresh').onclick = refresh;
  $('#btnSearch').onclick = showSearch;
  let filterT = 0;
  $('#filter').oninput = e => {
    S.filter = e.target.value;
    clearTimeout(filterT);
    filterT = setTimeout(() => {
      renderTree();
      if (S.filter.trim()) loadMetas(S.projects.flatMap(p => p.sessions));
    }, 120);
  };
  $('#dirInput').onchange = e => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    S.cur = null;
    loadRoot(FS.fromFileList(files), 'files');
  };
  window.addEventListener('hashchange', () => { if (S.projects.length) routeFromHash(); });

  // 拖拽文件夹
  document.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dragging'); });
  document.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
  document.addEventListener('drop', async e => {
    e.preventDefault();
    document.body.classList.remove('dragging');
    if (S.saved || S.pendingHandle) { toast('目录已固定，如需更换请点左下角「更换目录」'); return; }
    const item = [...(e.dataTransfer?.items || [])].find(i => i.kind === 'file');
    if (!item) return;
    // DataTransferItem 在第一次 await 之后就失效，必须同步取出
    const handleP = item.getAsFileSystemHandle?.();
    const entry = item.webkitGetAsEntry?.();
    try {
      if (handleP) {
        const h = await handleP;
        if (h?.kind === 'directory') {
          await saveHandle(h);
          S.cur = null;
          return loadRoot(FS.fromHandle(h), 'handle');
        }
      }
      if (entry?.isDirectory) { S.cur = null; return loadRoot(FS.fromEntry(entry), 'entry'); }
      toast('请拖入文件夹（projects 或 .claude）');
    } catch (err) { toast('读取失败：' + err.message); }
  });

  // 供调试 / 自动化测试使用
  window.ccApp = { loadRoot, openSession, showSearch, state: S };

  // ---------- 启动 ----------
  (async () => {
    view().innerHTML = '<div class="loading">正在加载…</div>';
    if (await tryRestore()) return;
    showHome();
  })();
})();
