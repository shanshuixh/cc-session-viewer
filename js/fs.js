// 文件系统抽象：统一 File System Access 句柄 / <input webkitdirectory> / 拖拽 三种来源
// 目录节点：{ kind:'dir', name, list(): Promise<node[]> }；文件节点：{ kind:'file', name, file(): Promise<File> }
const FS = (() => {
  const supportsPicker = typeof window.showDirectoryPicker === 'function';

  function fromHandle(h) {
    if (h.kind === 'file') return { kind: 'file', name: h.name, file: () => h.getFile() };
    return {
      kind: 'dir', name: h.name,
      async list() { const out = []; for await (const c of h.values()) out.push(fromHandle(c)); return out; },
    };
  }

  function fromFileList(files) {
    const root = { kind: 'dir', name: '', children: new Map() };
    for (const f of files) {
      const parts = (f.webkitRelativePath || f.name).split('/');
      let cur = root;
      for (let i = 0; i < parts.length - 1; i++) {
        let n = cur.children.get(parts[i]);
        if (!n) { n = { kind: 'dir', name: parts[i], children: new Map() }; cur.children.set(parts[i], n); }
        cur = n;
      }
      cur.children.set(parts[parts.length - 1], { kind: 'file', name: parts[parts.length - 1], f });
    }
    const wrap = n => n.kind === 'file'
      ? { kind: 'file', name: n.name, file: async () => n.f }
      : { kind: 'dir', name: n.name, list: async () => [...n.children.values()].map(wrap) };
    const top = [...root.children.values()];
    return wrap(top.length === 1 && top[0].kind === 'dir' ? top[0] : root);
  }

  function fromEntry(e) {
    if (e.isFile) return { kind: 'file', name: e.name, file: () => new Promise((res, rej) => e.file(res, rej)) };
    return {
      kind: 'dir', name: e.name,
      async list() {
        const r = e.createReader(), all = [];
        for (;;) {
          const batch = await new Promise((res, rej) => r.readEntries(res, rej));
          if (!batch.length) break;
          all.push(...batch);
        }
        return all.map(fromEntry);
      },
    };
  }

  // 用户可能选的是 ~ 、~/.claude 或 ~/.claude/projects，自动定位到 projects
  async function resolveProjectsRoot(root) {
    if (root.name === 'projects') return root;
    const kids = await root.list();
    const p = kids.find(k => k.kind === 'dir' && k.name === 'projects');
    if (p) return p;
    const c = kids.find(k => k.kind === 'dir' && k.name === '.claude');
    if (c) return resolveProjectsRoot(c);
    return root;
  }

  // IndexedDB 保存目录句柄，下次打开免重新选择
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('cc-read', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function idbGet(k) {
    const db = await idb();
    return new Promise((res, rej) => {
      const q = db.transaction('kv').objectStore('kv').get(k);
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    });
  }
  async function idbSet(k, v) {
    const db = await idb();
    return new Promise((res, rej) => {
      const t = db.transaction('kv', 'readwrite');
      t.objectStore('kv').put(v, k);
      t.oncomplete = () => res(); t.onerror = () => rej(t.error);
    });
  }

  async function idbDel(k) {
    const db = await idb();
    return new Promise((res, rej) => {
      const t = db.transaction('kv', 'readwrite');
      t.objectStore('kv').delete(k);
      t.oncomplete = () => res(); t.onerror = () => rej(t.error);
    });
  }

  return { supportsPicker, fromHandle, fromFileList, fromEntry, resolveProjectsRoot, idbGet, idbSet, idbDel };
})();
