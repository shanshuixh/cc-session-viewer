// 轻量 Markdown 渲染（无依赖）：代码块、标题、列表、表格、引用、行内样式
const MD = (() => {
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = s => String(s).replace(/[&<>"']/g, c => ESC[c]);

  function inline(src) {
    const codes = [];
    let s = src.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    s = esc(s);
    s = s.replace(/!?\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    s = s.replace(/(^|[\s(（])(https?:\/\/[^\s<)）]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/(^|\W)__([^_\n]+)__(?=\W|$)/g, '$1<strong>$2</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?![*\w])/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => '<code>' + esc(codes[i]) + '</code>');
    return s;
  }

  const RE_LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const RE_FENCE = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/;
  const RE_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  const isBlockStart = (l, next) =>
    RE_FENCE.test(l) || /^#{1,6}\s/.test(l) || /^\s*>/.test(l) || RE_LIST.test(l) ||
    (/^\s*\|.*\|\s*$/.test(l) && next != null && RE_TABLE_SEP.test(next));

  function buildList(items, start, indent) {
    const ordered = items[start].ordered;
    let html = ordered ? '<ol>' : '<ul>';
    let i = start;
    while (i < items.length && items[i].indent >= indent) {
      if (items[i].indent > indent) {
        const [sub, next] = buildList(items, i, items[i].indent);
        html = html.endsWith('</li>') ? html.slice(0, -5) + sub + '</li>' : html + sub;
        i = next;
        continue;
      }
      let t = items[i].text, box = '';
      const m = t.match(/^\[( |x|X)\]\s+/);
      if (m) { box = `<input type="checkbox" disabled${m[1] !== ' ' ? ' checked' : ''}> `; t = t.slice(m[0].length); }
      html += '<li>' + box + inline(t).replace(/\n/g, '<br>') + '</li>';
      i++;
    }
    return [html + (ordered ? '</ol>' : '</ul>'), i];
  }

  function render(src) {
    if (!src) return '';
    const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0, m;
    while (i < lines.length) {
      const l = lines[i];
      if ((m = l.match(RE_FENCE))) {
        const fence = m[1], buf = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence)) buf.push(lines[i++]);
        i++;
        out.push(`<pre class="code">${m[2] ? `<span class="code-lang">${esc(m[2])}</span>` : ''}<code>${esc(buf.join('\n'))}</code></pre>`);
        continue;
      }
      if (!l.trim()) { i++; continue; }
      if ((m = l.match(/^(#{1,6})\s+(.*)$/))) { const n = m[1].length; out.push(`<h${n}>${inline(m[2])}</h${n}>`); i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
      if (/^\s*>/.test(l)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push('<blockquote>' + render(buf.join('\n')) + '</blockquote>');
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1])) {
        const row = s => s.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
        const head = row(l);
        i += 2;
        let html = '<div class="table-wrap"><table><thead><tr>' + head.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
        while (i < lines.length && /^\s*\|.*\|?\s*$/.test(lines[i]) && lines[i].includes('|')) {
          html += '<tr>' + row(lines[i++]).map(c => `<td>${inline(c)}</td>`).join('') + '</tr>';
        }
        out.push(html + '</tbody></table></div>');
        continue;
      }
      if (RE_LIST.test(l)) {
        const items = [];
        while (i < lines.length) {
          const li = lines[i];
          const lm = li.match(RE_LIST);
          if (lm) {
            items.push({ indent: lm[1].replace(/\t/g, '  ').length, ordered: /\d/.test(lm[2]), text: lm[3] });
            i++;
          } else if (li.trim() && /^\s+/.test(li) && items.length) {
            items[items.length - 1].text += '\n' + li.trim();
            i++;
          } else if (!li.trim() && i + 1 < lines.length && RE_LIST.test(lines[i + 1])) {
            i++;
          } else break;
        }
        const base = Math.min(...items.map(x => x.indent));
        items.forEach(x => { if (x.indent < base) x.indent = base; });
        let pos = 0;
        while (pos < items.length) {
          const [html, next] = buildList(items, pos, items[pos].indent);
          out.push(html);
          pos = next;
        }
        continue;
      }
      const buf = [];
      while (i < lines.length && lines[i].trim() && !(buf.length && isBlockStart(lines[i], lines[i + 1]))) buf.push(lines[i++]);
      out.push('<p>' + buf.map(inline).join('<br>') + '</p>');
    }
    return out.join('\n');
  }

  return { render, inline, esc };
})();
