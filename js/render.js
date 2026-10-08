// 会话渲染：把 jsonl 记录渲染成对话流
const R = (() => {
  const esc = MD.esc;
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const stripAnsi = s => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const LIMIT = 6000;

  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d)) return '';
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  function fmtDur(ms) {
    if (!ms && ms !== 0) return '';
    const s = Math.round(ms / 1000);
    if (s < 60) return s + ' 秒';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} 分 ${s % 60} 秒`;
    return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
  }
  const fmtNum = n => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n);

  function parseJSONL(text) {
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* 写入中的半行 */ }
    }
    return out;
  }

  // 长文本：先显示前一段，按钮展开全部
  function pre(text, cls = '') {
    text = stripAnsi(text ?? '');
    const p = el('pre', 'out ' + cls);
    if (text.length <= LIMIT) { p.textContent = text; return p; }
    p.textContent = text.slice(0, LIMIT);
    const wrap = el('div', 'pre-wrap');
    const b = el('button', 'btn small more', `显示全部（共 ${text.length.toLocaleString()} 字符）`);
    b.onclick = () => { p.textContent = text; b.remove(); };
    wrap.append(p, b);
    return wrap;
  }

  function lazyDetails(cls, summaryHTML, fill, open = false) {
    const d = el('details', cls);
    d.innerHTML = `<summary>${summaryHTML}</summary>`;
    const body = el('div', 'dbody');
    d.append(body);
    let done = false;
    const run = () => { if (!done && d.open) { done = true; fill(body); } };
    d.addEventListener('toggle', run);
    if (open) { d.open = true; run(); }
    return d;
  }

  function imageEl(b) {
    const src = b.source;
    if (!src) return el('div', 'muted', '[图片]');
    const url = src.type === 'base64' ? `data:${src.media_type};base64,${src.data}` : src.url;
    const img = el('img', 'msg-img');
    img.src = url; img.loading = 'lazy';
    img.onclick = () => window.open(url, '_blank');
    return img;
  }

  // ---- 用户文本：识别斜杠命令、本地命令输出、! bash、系统提醒、粘贴内容 ----
  const tag = (t, name) => { const m = t.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)); return m ? m[1] : null; };

  function userText(t) {
    const box = el('div', 'utext');
    const reminders = [];
    t = t.replace(/<system-reminder>([\s\S]*?)<\/system-reminder>/g, (_, c) => { reminders.push(c.trim()); return ''; }).trim();
    const cmd = tag(t, 'command-name');
    const stdout = tag(t, 'local-command-stdout');
    const bashIn = tag(t, 'bash-input');
    const bashOut = tag(t, 'bash-stdout'), bashErr = tag(t, 'bash-stderr');
    if (cmd) {
      const args = tag(t, 'command-args') || '';
      box.append(el('div', 'cmd-chip', `<span class="k">命令</span> ${esc(cmd)} ${esc(args)}`));
    } else if (stdout != null) {
      box.append(el('div', 'label', '命令输出'), pre(stdout));
    } else if (bashIn != null) {
      box.append(pre('! ' + bashIn, 'shell'));
    } else if (bashOut != null || bashErr != null) {
      if (bashOut) box.append(pre(bashOut, 'shell'));
      if (bashErr) box.append(pre(bashErr, 'shell err'));
    } else if (t) {
      // 粘贴内容折叠显示
      const re = /<pasted_content[^>]*>([\s\S]*?)<\/pasted_content>/g;
      let last = 0, m;
      while ((m = re.exec(t))) {
        if (m.index > last) box.append(el('div', 'md', MD.render(t.slice(last, m.index))));
        const content = m[1];
        box.append(lazyDetails('pasted', `粘贴内容 · ${content.length} 字符`, b => b.append(el('div', 'md', MD.render(content)))));
        last = m.index + m[0].length;
      }
      if (last < t.length) box.append(el('div', 'md', MD.render(t.slice(last))));
    }
    for (const r of reminders) box.append(lazyDetails('meta reminder', '系统提醒', b => b.append(pre(r))));
    return box;
  }

  function toolBrief(name, inp) {
    if (!inp || typeof inp !== 'object') return '';
    if (name === 'Grep') return `${inp.pattern || ''}${inp.path ? '  ·  ' + inp.path : ''}`;
    if (name === 'TodoWrite' && Array.isArray(inp.todos)) return `${inp.todos.length} 项任务`;
    const v = inp.description || inp.command || inp.file_path || inp.notebook_path || inp.pattern ||
      inp.url || inp.query || inp.skill || inp.subject || inp.prompt || inp.path || '';
    return String(v).split('\n')[0].slice(0, 200);
  }

  function diffView(hunks) {
    const box = el('div', 'diff');
    for (const h of hunks) {
      box.append(el('div', 'hunk', esc(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`)));
      const p = el('pre', 'diff-body');
      p.innerHTML = (h.lines || []).map(l => {
        const c = l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : 'ctx';
        return `<span class="${c}">${esc(l) || ' '}</span>`;
      }).join('');
      box.append(p);
    }
    return box;
  }
  function simpleDiff(oldS, newS) {
    const lines = [...String(oldS ?? '').split('\n').map(l => '-' + l), ...String(newS ?? '').split('\n').map(l => '+' + l)];
    return diffView([{ oldStart: '?', oldLines: '', newStart: '?', newLines: '', lines }]);
  }

  function resultBody(res) {
    const box = el('div', 'result' + (res.block.is_error ? ' is-err' : ''));
    box.append(el('div', 'label', res.block.is_error ? '结果（错误）' : '结果'));
    const c = res.block.content;
    const parts = c == null ? [] : typeof c === 'string' ? [{ type: 'text', text: c }] : c;
    if (!parts.length) box.append(el('div', 'muted', '（无输出）'));
    for (const p of parts) {
      if (p.type === 'text') box.append(pre(p.text));
      else if (p.type === 'image') box.append(imageEl(p));
      else box.append(pre(JSON.stringify(p, null, 2)));
    }
    return box;
  }

  function fillTool(body, b, res, ctx) {
    const inp = b.input || {};
    const kv = (k, v) => body.append(el('div', 'kv', `<span class="k">${esc(k)}</span><span class="v">${esc(v)}</span>`));
    const tur = res?.rec?.toolUseResult;
    switch (b.name) {
      case 'Bash': case 'PowerShell':
        if (inp.description) kv('说明', inp.description);
        body.append(pre(inp.command, 'shell'));
        break;
      case 'Edit': case 'MultiEdit':
        kv('文件', inp.file_path);
        if (tur && Array.isArray(tur.structuredPatch) && tur.structuredPatch.length) body.append(diffView(tur.structuredPatch));
        else if (Array.isArray(inp.edits)) inp.edits.forEach(e => body.append(simpleDiff(e.old_string, e.new_string)));
        else body.append(simpleDiff(inp.old_string, inp.new_string));
        break;
      case 'Write':
        kv('文件', inp.file_path);
        body.append(pre(inp.content));
        break;
      case 'Read':
        kv('文件', inp.file_path);
        if (inp.offset || inp.limit) kv('范围', `offset ${inp.offset || 0}, limit ${inp.limit || '-'}`);
        break;
      case 'TodoWrite': {
        const ul = el('ul', 'todos');
        for (const t of inp.todos || []) {
          const icon = t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '◐' : '☐';
          ul.append(el('li', 'todo ' + t.status, `${icon} ${esc(t.content || t.activeForm || '')}`));
        }
        body.append(ul);
        break;
      }
      case 'Agent': case 'Task': {
        if (inp.subagent_type) kv('类型', inp.subagent_type);
        if (inp.description) kv('任务', inp.description);
        if (inp.prompt) body.append(lazyDetails('sub-prompt', '提示词', bb => bb.append(el('div', 'md', MD.render(inp.prompt)))));
        const node = ctx.subagents?.byTool.get(b.id) || (tur?.agentId && ctx.subagents?.byAgent.get(tur.agentId));
        if (node) {
          const btn = el('button', 'btn small', '▶ 查看子代理完整会话');
          const holder = el('div', 'subagent');
          btn.onclick = async () => {
            if (holder.childElementCount) { holder.hidden = !holder.hidden; return; }
            btn.disabled = true; btn.textContent = '加载中…';
            try {
              const text = await (await node.file()).text();
              holder.append(renderConversation(parseJSONL(text), { sidechain: true, subagents: null }).frag);
              btn.textContent = '子代理会话（点击收起/展开）';
            } catch (e) { holder.append(el('div', 'muted', '加载失败：' + esc(e.message))); }
            btn.disabled = false;
          };
          body.append(btn, holder);
        }
        break;
      }
      default:
        body.append(pre(JSON.stringify(inp, null, 2)));
    }
    if (res) body.append(resultBody(res));
    else body.append(el('div', 'muted', '（没有记录到结果，可能被中断）'));
  }

  function toolBlock(b, res, ctx, uuid) {
    const status = !res ? '<span class="st pend">○</span>' : res.block.is_error ? '<span class="st err">✕</span>' : '<span class="st ok">✓</span>';
    const sum = `${status}<span class="tname">${esc(b.name)}</span><span class="tbrief">${esc(toolBrief(b.name, b.input))}</span>`;
    const d = lazyDetails('tool', sum, body => fillTool(body, b, res, ctx));
    if (uuid) d.dataset.uuid = uuid;
    return d;
  }

  function userContentText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  }

  // ---- 主渲染 ----
  function renderConversation(recs, ctx = {}) {
    const frag = document.createDocumentFragment();
    const stats = { user: 0, assistant: 0, tools: 0, inTok: 0, outTok: 0, models: new Set(), cost: null, start: null, end: null, cwd: null, branch: null, version: null };
    const results = new Map();
    for (const r of recs) {
      const c = r.message?.content;
      if (r.type === 'user' && Array.isArray(c)) for (const b of c) if (b.type === 'tool_result') results.set(b.tool_use_id, { block: b, rec: r });
    }
    const seenMsg = new Set();
    let group = null, groupBody = null;
    const target = () => groupBody || frag;
    const sysLine = (cls, html, uuid) => { const d = el('div', 'sys ' + cls, html); if (uuid) d.dataset.uuid = uuid; return d; };

    for (const r of recs) {
      if (r.isSidechain && !ctx.sidechain) continue;
      if (r.timestamp) { stats.start = stats.start || r.timestamp; stats.end = r.timestamp; }
      if (r.cwd && !stats.cwd) stats.cwd = r.cwd;
      if (r.gitBranch) stats.branch = r.gitBranch;
      if (r.version) stats.version = r.version;

      if (r.type === 'user') {
        const c = r.message?.content;
        if (Array.isArray(c) && c.length && c.every(b => b.type === 'tool_result')) continue;
        group = groupBody = null;
        if (r.isCompactSummary) {
          frag.append(lazyDetails('compact', '📦 上下文压缩摘要', b => b.append(el('div', 'md', MD.render(userContentText(c))))));
          continue;
        }
        if (r.isMeta) {
          const t = userContentText(c);
          const d = lazyDetails('meta', `元信息 · ${esc(t.replace(/<[^>]+>/g, ' ').trim().slice(0, 80))}`, b => b.append(pre(t)));
          frag.append(d);
          continue;
        }
        stats.user++;
        const msg = el('div', 'msg user');
        msg.dataset.uuid = r.uuid || '';
        msg.append(el('div', 'who', `<span class="name">你</span><span class="time">${fmtTime(r.timestamp)}</span>`));
        const bubble = el('div', 'bubble');
        if (typeof c === 'string') bubble.append(userText(c));
        else if (Array.isArray(c)) for (const b of c) {
          if (b.type === 'text') bubble.append(userText(b.text));
          else if (b.type === 'image') bubble.append(imageEl(b));
          else if (b.type === 'tool_result') bubble.append(resultBody({ block: b }));
          else if (b.type === 'document') bubble.append(el('div', 'muted', '[附件文档]'));
        }
        msg.append(bubble);
        frag.append(msg);
        continue;
      }

      if (r.type === 'assistant') {
        const m = r.message || {};
        if (m.model && m.model !== '<synthetic>') stats.models.add(m.model);
        if (m.id && m.usage && !seenMsg.has(m.id)) {
          seenMsg.add(m.id);
          const u = m.usage;
          stats.inTok += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
          stats.outTok += u.output_tokens || 0;
        }
        if (!group) {
          stats.assistant++;
          group = el('div', 'msg assistant');
          group.append(el('div', 'who', `<span class="name">Claude</span><span class="model">${esc(m.model && m.model !== '<synthetic>' ? m.model : '')}</span><span class="time">${fmtTime(r.timestamp)}</span>`));
          groupBody = el('div', 'abody');
          group.append(groupBody);
          frag.append(group);
        }
        const content = Array.isArray(m.content) ? m.content : typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : [];
        for (const b of content) {
          if (b.type === 'text') {
            if (!b.text?.trim()) continue;
            const d = el('div', 'md atext' + (r.isApiErrorMessage || m.model === '<synthetic>' ? ' api-err' : ''), MD.render(b.text));
            d.dataset.uuid = r.uuid || '';
            groupBody.append(d);
          } else if (b.type === 'thinking') {
            if (!b.thinking?.trim()) continue;
            const d = lazyDetails('thinking', '💭 思考过程', bb => bb.append(el('div', 'md', MD.render(b.thinking))));
            d.dataset.uuid = r.uuid || '';
            groupBody.append(d);
          } else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
            stats.tools++;
            groupBody.append(toolBlock(b, results.get(b.id), ctx, r.uuid));
          }
        }
        continue;
      }

      if (r.type === 'system') {
        const st = r.subtype;
        if (st === 'turn_duration') {
          if (group) group.append(el('div', 'turn-foot', `⏱ 本轮耗时 ${fmtDur(r.durationMs)}`));
          group = groupBody = null;
        } else if (st === 'compact_boundary') {
          group = groupBody = null;
          frag.append(sysLine('divider', '<span>上下文已压缩</span>', r.uuid));
        } else if (st === 'away_summary') {
          frag.append(sysLine('note', '📝 ' + esc(String(r.content || '').replace(/\s*\(disable recaps.*?\)\s*$/, '')), r.uuid));
        } else if (st === 'local_command') {
          group = groupBody = null;
          const d = el('div', 'msg user');
          d.append(el('div', 'who', `<span class="name">你</span><span class="time">${fmtTime(r.timestamp)}</span>`));
          const bub = el('div', 'bubble');
          bub.append(userText(String(r.content || '')));
          d.append(bub);
          frag.append(d);
        } else {
          const text = r.content || r.message || '';
          target().append(lazyDetails('sysevt', `⚙ 系统事件 · ${esc(st || '')}${r.level === 'error' ? ' · 错误' : ''}`, b => b.append(pre(typeof text === 'string' && text ? text : JSON.stringify(r, null, 2)))));
        }
        continue;
      }

      if (r.type === 'attachment' && r.attachment) {
        const a = r.attachment;
        if (a.type === 'queued_command' && (a.prompt || a.content)) {
          const t = typeof a.prompt === 'string' ? a.prompt : userContentText(a.prompt || a.content);
          target().append(el('div', 'queued', `<span class="label">运行中追加的消息</span>${MD.render(t)}`));
          continue;
        }
        target().append(lazyDetails('attach', `📎 附件 · ${esc(a.type || '')}`, b => {
          const rendered = (r.rendered || []).map(x => x.content).filter(Boolean).join('\n\n');
          b.append(pre(rendered || JSON.stringify(a, null, 2)));
        }));
        continue;
      }

      if (r.type === 'summary' && r.summary) { frag.append(sysLine('note', '📝 ' + esc(r.summary))); continue; }
      if (r.type === 'cost-state') stats.cost = r.totalCostUSD;
    }
    return { frag, stats };
  }

  // 搜索用：提取一条记录中可搜索的文本
  function searchTexts(r) {
    if (r.isSidechain || r.isMeta) return [];
    const c = r.message?.content;
    if (r.type === 'user') {
      if (typeof c === 'string') return [{ role: '你', text: c }];
      if (Array.isArray(c)) return c.filter(b => b.type === 'text').map(b => ({ role: '你', text: b.text }));
    }
    if (r.type === 'assistant' && Array.isArray(c)) {
      return c.map(b => b.type === 'text' ? { role: 'Claude', text: b.text }
        : b.type === 'thinking' ? { role: '思考', text: b.thinking }
        : b.type === 'tool_use' ? { role: '工具 ' + b.name, text: JSON.stringify(b.input) } : null).filter(x => x && x.text);
    }
    return [];
  }

  return { renderConversation, parseJSONL, searchTexts, userContentText, fmtTime, fmtDur, fmtNum, el, pre };
})();
