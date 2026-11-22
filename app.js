/* ReadNote — 阅读 · 标注 · 脑图
 * 零依赖单页应用（PDF.js 已本地化到 vendor/，离线可用）。
 * 数据模型：annotations（标注）+ tree（脑图节点树），持久化到 IndexedDB。
 */
(function () {
  'use strict';

  // ---------- 常量 & 状态 ----------
  const DB_NAME = 'readnote', DB_VER = 1, STORE = 'state';
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

  const S = {
    pdf: null,          // pdfjs doc
    pdfName: '',
    pdfBytes: null,     // ArrayBuffer
    scale: 1.35,
    pageEls: [],        // {wrap, canvas, textLayer, hlLayer, pageNum, viewport}
    annotations: [],    // {id, page, text, note, color, rects:[{x,y,w,h}], createdAt}
    tree: null,         // {id, title, note, color, sourceId, children:[]}
    ui: { tab: 'outline' },
    pendingSel: null,   // 划选暂存 {text, rects, page}
  };

  // ---------- DOM ----------
  const $ = (s) => document.querySelector(s);
  const el = {
    fileInput: $('#fileInput'), sampleBtn: $('#sampleBtn'),
    exportBtn: $('#exportBtn'), exportMenu: $('#exportMenu'), saveBtn: $('#saveBtn'),
    importBtn: $('#importBtn'), importInput: $('#importInput'),
    emptyState: $('#emptyState'), emptyOpen: $('#emptyOpen'), pages: $('#pages'), reader: $('#reader'),
    outlinePanel: $('#outlinePanel'), notesPanel: $('#notesPanel'),
    selToolbar: $('#selToolbar'), noteModal: $('#noteModal'),
    noteQuote: $('#noteQuote'), noteText: $('#noteText'), addToMap: $('#addToMap'),
    noteCancel: $('#noteCancel'), noteSave: $('#noteSave'),
    mindmap: $('#mindmap'), addNodeBtn: $('#addNodeBtn'), fitBtn: $('#fitBtn'),
    toast: $('#toast'),
  };

  const uid = () => 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const esc = (s) => (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function toast(msg) {
    el.toast.textContent = msg; el.toast.classList.remove('hidden');
    clearTimeout(toast._t); toast._t = setTimeout(() => el.toast.classList.add('hidden'), 2200);
  }

  // ---------- IndexedDB ----------
  function openDB() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, DB_VER);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function persist(silent) {
    const data = {
      pdfName: S.pdfName,
      pdfBytes: S.pdfBytes,
      annotations: S.annotations,
      tree: S.tree,
    };
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(data, 'main');
      tx.oncomplete = () => { if (!silent) toast('已保存'); res(); };
      tx.onerror = () => rej(tx.error);
    });
  }
  async function restore() {
    const db = await openDB();
    const data = await new Promise((res) => {
      const tx = db.transaction(STORE, 'readonly');
      const rq = tx.objectStore(STORE).get('main');
      rq.onsuccess = () => res(rq.result);
    });
    if (!data) return false;
    S.pdfName = data.pdfName || '';
    S.pdfBytes = data.pdfBytes || null;
    S.annotations = data.annotations || [];
    S.tree = data.tree || makeRoot('我的笔记');
    return true;
  }

  function makeRoot(title) {
    return { id: 'root', title: title || '我的笔记', note: '', color: '#3a7d5d', sourceId: null, children: [] };
  }

  // ---------- PDF 加载与渲染 ----------
  async function loadPDF(bytes, name, skipPersist) {
    S.pdfBytes = bytes; S.pdfName = name || S.pdfName || 'document.pdf';
    S.pdf = await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise;
    S.annotations = []; S.tree = makeRoot(S.pdfName.replace(/\.pdf$/i, ''));
    el.emptyState.classList.add('hidden');
    el.pages.classList.remove('hidden');
    await renderAll();
    refreshAll();
    if (!skipPersist) persist(true);
    toast(`已打开 ${S.pdfName} · ${S.pdf.numPages} 页`);
  }

  async function renderAll() {
    el.pages.innerHTML = ''; S.pageEls = [];
    for (let n = 1; n <= S.pdf.numPages; n++) {
      const page = await S.pdf.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const targetW = Math.min(el.reader ? el.reader.clientWidth - 80 : 800, 900);
      const scale = Math.min(1.8, Math.max(1.0, targetW / base.width));
      S.scale = scale;
      const viewport = page.getViewport({ scale });

      const wrap = document.createElement('div');
      wrap.className = 'page-wrap';
      wrap.style.width = viewport.width + 'px';
      wrap.style.height = viewport.height + 'px';

      const canvas = document.createElement('canvas');
      canvas.width = viewport.width; canvas.height = viewport.height;
      wrap.appendChild(canvas);

      const hlLayer = document.createElement('div');
      hlLayer.className = 'hl-layer';
      wrap.appendChild(hlLayer);

      const textLayer = document.createElement('div');
      textLayer.className = 'textLayer';
      wrap.appendChild(textLayer);

      el.pages.appendChild(wrap);
      const rec = { wrap, canvas, textLayer, hlLayer, pageNum: n, viewport };
      S.pageEls.push(rec);

      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      const tc = await page.getTextContent();
      if (pdfjsLib.TextLayer) {
        const tl = new pdfjsLib.TextLayer({ textContentSource: tc, container: textLayer, viewport });
        await tl.render();
      } else {
        await pdfjsLib.renderTextLayer({ textContent: tc, container: textLayer, viewport, textDivs: [] }).promise;
      }
      drawHighlights(rec);
      setupSelection(rec);
    }
  }

  // 标注坐标以 PDF 逻辑坐标（scale=1）存储：rects = {x,y,w,h}（top-left 原点）
  function drawHighlights(rec) {
    rec.hlLayer.innerHTML = '';
    S.annotations.filter(a => a.page === rec.pageNum).forEach(a => {
      (a.rects || []).forEach(r => {
        const d = document.createElement('div');
        d.className = 'hl-rect' + (a._flash ? ' flash' : '');
        d.style.left = (r.x * S.scale) + 'px';
        d.style.top = (r.y * S.scale) + 'px';
        d.style.width = (r.w * S.scale) + 'px';
        d.style.height = (r.h * S.scale) + 'px';
        d.style.background = a.color || '#fff3a3';
        rec.hlLayer.appendChild(d);
      });
      if (a._flash) setTimeout(() => delete a._flash, 1300);
    });
  }

  // ---------- 文本划选 ----------
  function setupSelection(rec) {
    rec.textLayer.addEventListener('mouseup', () => {
      setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.toString().trim()) { hideSelToolbar(); return; }
        const range = sel.getRangeAt(0);
        const rects = Array.from(range.getClientRects())
          .filter(r => r.width > 1 && r.height > 1)
          .map(r => ({
            x: (r.left - rec.wrap.getBoundingClientRect().left) / S.scale,
            y: (r.top - rec.wrap.getBoundingClientRect().top) / S.scale,
            w: r.width / S.scale,
            h: r.height / S.scale,
          }));
        if (!rects.length) { hideSelToolbar(); return; }
        S.pendingSel = { text: sel.toString().trim(), rects, page: rec.pageNum };
        const last = rects[rects.length - 1];
        showSelToolbar(
          rec.wrap.getBoundingClientRect().left + last.x * S.scale,
          rec.wrap.getBoundingClientRect().top + (last.y + last.h) * S.scale
        );
      }, 10);
    });
  }
  function showSelToolbar(x, y) {
    el.selToolbar.style.left = Math.max(8, x - 40) + 'px';
    el.selToolbar.style.top = (y + 6) + 'px';
    el.selToolbar.classList.remove('hidden');
  }
  function hideSelToolbar() { el.selToolbar.classList.add('hidden'); }

  function addAnnotation(color, note) {
    const p = S.pendingSel;
    if (!p) return;
    const a = {
      id: uid(), page: p.page, text: p.text, note: note || '',
      color: color || '#fff3a3', rects: p.rects, createdAt: Date.now(),
    };
    S.annotations.push(a);
    S.annotations.sort((a, b) => a.page - b.page);
    const rec = S.pageEls[p.page - 1];
    if (rec) drawHighlights(rec);
    window.getSelection().removeAllRanges();
    hideSelToolbar();
    refreshAll(); persist(true);
    toast('标注已保存');
  }

  // ---------- 大纲 / 笔记面板 ----------
  function refreshOutline() {
    if (!S.annotations.length) {
      el.outlinePanel.innerHTML = '<div class="outline-empty">还没有标注<br>在左侧页面选中文字试试</div>';
      return;
    }
    el.outlinePanel.innerHTML = S.annotations.map(a => `
      <div class="outline-item" data-id="${a.id}">
        <span class="dot" style="background:${a.color}"></span>
        <span class="pg">P${a.page}</span>
        <span class="txt">${esc(a.text.slice(0, 80))}${a.text.length > 80 ? '…' : ''}</span>
        <button class="del-anno" data-id="${a.id}" title="删除标注">×</button>
      </div>`).join('');
    el.outlinePanel.querySelectorAll('.outline-item').forEach(it => {
      it.addEventListener('click', (e) => {
        if (!e.target.classList.contains('del-anno')) jumpTo(it.dataset.id);
      });
    });
    el.outlinePanel.querySelectorAll('.del-anno').forEach(b => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteAnnotation(b.dataset.id);
      });
    });
  }

  function refreshNotes() {
    const withNote = S.annotations.filter(a => a.note);
    if (!withNote.length) {
      el.notesPanel.innerHTML = '<div class="notes-empty">还没有笔记<br>标注时填写想法会出现在这里</div>';
      return;
    }
    el.notesPanel.innerHTML = withNote.map(a => `
      <div class="note-card" data-id="${a.id}">
        <div class="q">${esc(a.text.slice(0, 140))}</div>
        <div class="c">${esc(a.note)}</div>
        <div class="meta"><span class="pg">第 ${a.page} 页</span>
          <button class="del-note" data-id="${a.id}">删除</button></div>
      </div>`).join('');
    el.notesPanel.querySelectorAll('.note-card').forEach(c => {
      c.addEventListener('click', e => {
        if (!e.target.classList.contains('del-note')) jumpTo(c.dataset.id);
      });
    });
    el.notesPanel.querySelectorAll('.del-note').forEach(b => {
      b.addEventListener('click', e => {
        e.stopPropagation();
        deleteAnnotation(b.dataset.id);
      });
    });
  }

  function deleteAnnotation(id) {
    S.annotations = S.annotations.filter(a => a.id !== id);
    // 同步删除脑图中来源为该标注的节点（含其子树）
    const stripBySource = (n) => {
      n.children = n.children.filter(c => c.sourceId !== id);
      n.children.forEach(stripBySource);
    };
    stripBySource(S.tree);
    // 重绘所有页面高亮层（简单可靠，页数不多）
    S.pageEls.forEach(r => drawHighlights(r));
    if (mmSelected && !findNode(S.tree, mmSelected)) mmSelected = null;
    refreshAll(); persist(true); toast('标注已删除');
  }

  function jumpTo(id) {
    const a = S.annotations.find(x => x.id === id);
    if (!a) return;
    const rec = S.pageEls[a.page - 1];
    if (rec) {
      rec.wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
      a._flash = true; drawHighlights(rec);
    }
  }

  // ---------- 脑图树操作 ----------
  function findNode(node, id) {
    if (node.id === id) return node;
    for (const c of node.children) { const r = findNode(c, id); if (r) return r; }
    return null;
  }
  function findParent(node, id) {
    for (const c of node.children) {
      if (c.id === id) return node;
      const r = findParent(c, id); if (r) return r;
    }
    return null;
  }
  function removeNode(node, id) {
    const i = node.children.findIndex(c => c.id === id);
    if (i >= 0) return node.children.splice(i, 1)[0];
    for (const c of node.children) { const r = removeNode(c, id); if (r) return r; }
    return null;
  }
  function pruneTree() {
    const ids = new Set(S.annotations.map(a => a.id));
    const walk = (n) => { n.children = n.children.filter(c => !c.sourceId || ids.has(c.sourceId)); n.children.forEach(walk); };
    walk(S.tree);
  }

  let mmSelected = null;
  let mmScale = 1;
  function applyMapScale(inner, maxX, maxY) {
    const availW = el.mindmap.clientWidth - 24 || 336;
    const scale = Math.max(0.5, Math.min(1, availW / maxX));
    mmScale = scale;
    inner.style.transformOrigin = '0 0';
    inner.style.transform = `scale(${scale})`;
    inner.dataset.baseW = maxX; inner.dataset.baseH = maxY;
  }
  function fitMap() {
    const inner = el.mindmap.firstElementChild;
    if (inner && inner.dataset.baseW) applyMapScale(inner, +inner.dataset.baseW, +inner.dataset.baseH);
  }
  function addMapNode(title, sourceId, color) {
    const node = { id: uid(), title: title || '新节点', note: '', color: color || '#fff', sourceId: sourceId || null, children: [] };
    (mmSelected ? findNode(S.tree, mmSelected) || S.tree : S.tree).children.push(node);
    refreshMap(); persist(true);
    return node;
  }

  // 脑图布局：从左到右树
  function layoutTree() {
    const NW = 168, GAPX = 70, GAPY = 16, NH = 40;
    const pos = new Map();
    let yCursor = 20;
    function place(node, depth) {
      const x = 24 + depth * (NW + GAPX);
      const childYs = [];
      if (node.children.length) {
        node.children.forEach(c => childYs.push(place(c, depth + 1)));
        const y = (childYs[0] + childYs[childYs.length - 1]) / 2;
        pos.set(node.id, { x, y, w: NW }); return y;
      }
      const y = yCursor; yCursor += NH + GAPY;
      pos.set(node.id, { x, y, w: NW }); return y;
    }
    place(S.tree, 0);
    return { pos, NW, NH };
  }

  function refreshMap() {
    if (!S.tree) S.tree = makeRoot('我的笔记');
    const { pos } = layoutTree();
    const maxX = Math.max(...pos.values().map(p => p.x), 200) + 200;
    const maxY = Math.max(...pos.values().map(p => p.y), 100) + 60;
    el.mindmap.innerHTML = '';
    const inner = document.createElement('div');
    inner.style.cssText = `position:relative;width:${maxX}px;height:${maxY}px;`;
    // 连线
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', maxX); svg.setAttribute('height', maxY);
    svg.style.cssText = 'position:absolute;inset:0;z-index:1;pointer-events:none;';
    const walkLines = (node) => {
      node.children.forEach(c => {
        const a = pos.get(node.id), b = pos.get(c.id);
        if (a && b) {
          const p = document.createElementNS(svgNS, 'path');
          const x1 = a.x + 168, y1 = a.y + 18, x2 = b.x, y2 = b.y + 18;
          p.setAttribute('d', `M${x1},${y1} C${x1 + 35},${y1} ${x2 - 35},${y2} ${x2},${y2}`);
          p.setAttribute('fill', 'none'); p.setAttribute('stroke', '#b9c9bd');
          p.setAttribute('stroke-width', '2');
          svg.appendChild(p);
        }
        walkLines(c);
      });
    };
    walkLines(S.tree); inner.appendChild(svg);
    // 节点
    const walkNodes = (node) => {
      const p = pos.get(node.id);
      const d = document.createElement('div');
      d.className = 'mm-node' + (node.id === 'root' ? ' root' : '') + (node.id === mmSelected ? ' selected' : '');
      d.style.left = p.x + 'px'; d.style.top = p.y + 'px';
      d.dataset.id = node.id; d.draggable = node.id !== 'root';
      let html = `<div class="ttl">${esc(node.title)}</div>`;
      if (node.sourceId) {
        const a = S.annotations.find(x => x.id === node.sourceId);
        if (a) html += `<span class="src">P${a.page} · ${esc(a.text.slice(0, 18))}…</span>`;
      }
      d.innerHTML = html;
      d.addEventListener('click', (e) => {
        e.stopPropagation();
        mmSelected = node.id; refreshMap();
        if (node.sourceId) jumpTo(node.sourceId);
      });
      d.addEventListener('dblclick', (e) => { e.stopPropagation(); editNode(d, node); });
      d.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', node.id); d.classList.add('dragging'); });
      d.addEventListener('dragend', () => d.classList.remove('dragging'));
      d.addEventListener('dragover', (e) => e.preventDefault());
      d.addEventListener('drop', (e) => {
        e.preventDefault(); e.stopPropagation();
        const src = e.dataTransfer.getData('text/plain');
        if (!src || src === node.id || src === 'root') return;
        const moving = removeNode(S.tree, src);
        if (moving) { findNode(S.tree, node.id).children.push(moving); refreshMap(); persist(true); }
      });
      inner.appendChild(d);
      node.children.forEach(walkNodes);
    };
    walkNodes(S.tree);
    el.mindmap.appendChild(inner);
    applyMapScale(inner, maxX, maxY);
  }

  function editNode(dom, node) {
    const ttl = dom.querySelector('.ttl');
    const old = node.title;
    ttl.innerHTML = `<input value="${esc(old)}">`;
    const input = ttl.querySelector('input');
    input.focus(); input.select();
    const commit = (save) => {
      const v = input.value.trim();
      if (save && v) node.title = v;
      refreshMap(); persist(true);
    };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') commit(true);
      if (e.key === 'Escape') commit(false);
    });
    input.addEventListener('blur', () => commit(true), { once: true });
  }

  function deleteSelectedNode() {
    if (!mmSelected || mmSelected === 'root') return;
    removeNode(S.tree, mmSelected);
    mmSelected = null; refreshMap(); persist(true); toast('节点已删除');
  }

  function refreshAll() { refreshOutline(); refreshNotes(); refreshMap(); }

  // ---------- 导出 ----------
  function download(name, content, type) {
    const blob = new Blob([content], { type: type || 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const baseName = () => (S.pdfName || 'readnote').replace(/\.pdf$/i, '');

  function exportMD() {
    let s = `# ${baseName()}\n\n`;
    const treeLines = (n, d) => {
      if (n.id !== 'root') s += '  '.repeat(d - 1) + `- ${n.title}${n.note ? '：' + n.note : ''}\n`;
      n.children.forEach(c => treeLines(c, d + 1));
    };
    s += '## 脑图大纲\n\n'; treeLines(S.tree, 1);
    s += '\n## 标注与笔记\n\n';
    S.annotations.forEach((a, i) => {
      s += `### ${i + 1}. 第 ${a.page} 页\n\n> ${a.text.replace(/\n/g, ' ')}\n\n`;
      if (a.note) s += a.note + '\n\n';
    });
    download(baseName() + '.md', s, 'text/markdown;charset=utf-8');
  }
  function exportHTML() {
    const items = S.annotations.map(a => `<div class="item"><span class="pg">P${a.page}</span><blockquote>${esc(a.text)}</blockquote>${a.note ? '<p>' + esc(a.note) + '</p>' : ''}</div>`).join('');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(baseName())}</title>
<style>body{font-family:system-ui;max-width:760px;margin:40px auto;color:#222;line-height:1.7}
.item{border-bottom:1px solid #eee;padding:16px 0}.pg{color:#888;font-size:12px}
blockquote{border-left:3px solid #e8c94a;background:#fffbe8;margin:8px 0;padding:8px 12px}</style></head>
<body><h1>${esc(baseName())}</h1>${items}</body></html>`;
    download(baseName() + '.html', html, 'text/html;charset=utf-8');
  }
  function exportOPML() {
    const walk = (n) => `<outline text="${esc(n.title)}"${n.note ? ` _note="${esc(n.note)}"` : ''}>${n.children.map(walk).join('')}</outline>`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?><opml version="2.0"><head><title>${esc(baseName())}</title></head><body>${S.tree.children.map(walk).join('')}</body></opml>`;
    download(baseName() + '.opml', xml, 'text/x-opml;charset=utf-8');
  }
  function exportAnki() {
    const rows = S.annotations.filter(a => a.note).map(a => {
      const q = `P${a.page}：${a.text.replace(/"/g, '""').replace(/\n/g, ' ').slice(0, 120)}`;
      const ans = a.note.replace(/"/g, '""').replace(/\n/g, '<br>');
      return `"${q}","${ans}","ReadNote"`;
    });
    download(baseName() + '_anki.csv', 'Front,Back,Tags\n' + rows.join('\n'), 'text/csv;charset=utf-8');
  }
  // ArrayBuffer <-> base64（分块处理，避免大 PDF 时栈溢出）
  function bufToB64(buf) {
    if (!buf) return null;
    const bytes = new Uint8Array(buf), CHUNK = 0x8000;
    let bin = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }
  function b64ToBuf(b64) {
    if (!b64) return null;
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }
  function exportJSON() {
    const payload = {
      app: 'ReadNote', version: 2, pdfName: S.pdfName,
      pdfB64: bufToB64(S.pdfBytes),
      annotations: S.annotations, tree: S.tree,
    };
    download(baseName() + '_backup.json', JSON.stringify(payload), 'application/json');
  }

  async function importJSON(file) {
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'ReadNote') throw new Error('不是 ReadNote 备份文件');
      const bytes = b64ToBuf(data.pdfB64);
      if (bytes) {
        await loadPDF(bytes, data.pdfName || '恢复的文档.pdf', true);
      } else {
        // 旧版备份或纯数据：清掉 PDF，仅恢复标注/脑图
        S.pdf = null; S.pdfBytes = null; S.pdfName = data.pdfName || '';
        S.pageEls = [];
        el.pages.innerHTML = ''; el.pages.classList.add('hidden');
        el.emptyState.classList.remove('hidden');
      }
      S.annotations = data.annotations || [];
      S.tree = data.tree || makeRoot('我的笔记');
      refreshAll(); persist(true);
      toast(`已导入备份：${S.annotations.length} 条标注${bytes ? ' + PDF' : ''}`);
    } catch (err) {
      toast('导入失败：' + (err.message || '文件格式错误'));
    }
  }

  // ---------- 事件绑定 ----------
  function bind() {
    const pickFile = () => el.fileInput.click();
    el.emptyOpen.addEventListener('click', pickFile);
    el.fileInput.addEventListener('change', e => {
      const f = e.target.files[0]; if (!f) return;
      f.arrayBuffer().then(b => loadPDF(b, f.name));
    });
    el.sampleBtn.addEventListener('click', () => makeSample());
    el.saveBtn.addEventListener('click', () => persist());
    el.importBtn.addEventListener('click', () => el.importInput.click());
    el.importInput.addEventListener('change', e => {
      const f = e.target.files[0]; if (!f) return;
      importJSON(f);
      e.target.value = ''; // 允许重复导入同一文件
    });

    document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      const tab = t.dataset.tab;
      el.outlinePanel.classList.toggle('hidden', tab !== 'outline');
      el.notesPanel.classList.toggle('hidden', tab !== 'notes');
    }));

    el.exportBtn.addEventListener('click', e => { e.stopPropagation(); el.exportMenu.classList.toggle('hidden'); });
    document.addEventListener('click', () => el.exportMenu.classList.add('hidden'));
    el.exportMenu.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      const k = b.dataset.export;
      ({ md: exportMD, html: exportHTML, opml: exportOPML, anki: exportAnki, json: exportJSON }[k] || (() => {}))();
      toast('已导出 ' + b.textContent);
    }));

    el.selToolbar.querySelectorAll('.hl').forEach(b => b.addEventListener('click', () => addAnnotation(b.dataset.color, '')));
    $('#selNote').addEventListener('click', () => {
      const first = el.selToolbar.querySelector('.hl').dataset.color;
      S._pendingColor = first;
      const p = S.pendingSel; if (!p) return;
      el.noteQuote.textContent = p.text.slice(0, 200);
      el.noteText.value = ''; el.addToMap.checked = true;
      el.noteModal.classList.remove('hidden'); el.noteText.focus();
    });
    el.noteCancel.addEventListener('click', () => el.noteModal.classList.add('hidden'));
    el.noteSave.addEventListener('click', () => {
      const note = el.noteText.value.trim();
      const color = S._pendingColor || '#fff3a3';
      const p = S.pendingSel;
      addAnnotation(color, note);
      if (el.addToMap.checked && p) {
        const a = S.annotations[S.annotations.length - 1];
        addMapNode(p.text.slice(0, 40), a.id, color);
      }
      el.noteModal.classList.add('hidden');
    });

    el.addNodeBtn.addEventListener('click', () => addMapNode('新节点'));
    el.fitBtn.addEventListener('click', () => { fitMap(); el.mindmap.scrollTo(0, 0); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Delete' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') deleteSelectedNode();
      if (e.key === 'Escape') { el.noteModal.classList.add('hidden'); hideSelToolbar(); }
    });
    document.addEventListener('click', e => {
      if (!e.target.closest('.mm-node')) { mmSelected = null; refreshMap(); }
    });
  }

  // ---------- 示例文档（无网络可用）----------
  function makeSample() {
    S.pdfName = '示例·如何阅读一本书.pdf';
    S.annotations = [
      { id: uid(), page: 1, text: '阅读不只是获取信息，而是一种主动的心智活动。', note: '主动阅读 = 带着问题读。', color: '#fff3a3', rects: [{ x: 72, y: 180, w: 360, h: 20 }], createdAt: Date.now() },
      { id: uid(), page: 1, text: '分析的阅读，就是去理解一本书的结构。', note: '先读目录与前言，抓住骨架。', color: '#a8e6a3', rects: [{ x: 72, y: 300, w: 340, h: 20 }], createdAt: Date.now() },
      { id: uid(), page: 2, text: '主题阅读是最费力的，也是最有价值的阅读层次。', note: '围绕一个主题读多本书，再做整合。', color: '#a8d5ff', rects: [{ x: 72, y: 220, w: 380, h: 20 }], createdAt: Date.now() },
    ];
    const root = makeRoot('如何阅读一本书');
    const a0 = S.annotations[0].id, a1 = S.annotations[1].id, a2 = S.annotations[2].id;
    root.children = [
      { id: uid(), title: '阅读的层次', note: '', color: '#fff', sourceId: null, children: [
        { id: uid(), title: '主动阅读', note: '', color: '#fff3a3', sourceId: a0, children: [] },
        { id: uid(), title: '分析阅读', note: '', color: '#a8e6a3', sourceId: a1, children: [] },
      ]},
      { id: uid(), title: '主题阅读', note: '最高层次', color: '#a8d5ff', sourceId: a2, children: [] },
    ];
    S.tree = root;
    renderSamplePages();
    refreshAll(); persist(true);
    toast('已加载示例（纯演示，无需 PDF）');
  }
  function renderSamplePages() {
    el.emptyState.classList.add('hidden'); el.pages.classList.remove('hidden');
    el.pages.innerHTML = '';
    const contents = [
      ['第一章 阅读的层次', [
        '阅读不只是获取信息，而是一种主动的心智活动。好书值得反复读，每一次重读都会有新的收获。',
        '分析的阅读，就是去理解一本书的结构。你要能说出这本书在谈什么，作者是怎么说的，以及它说得有没有道理。',
        '很多人读书只读一遍就放下，其实真正的理解发生在合上书之后的思考里。',
      ]],
      ['第二章 主题阅读', [
        '阅读的第四个层次是主题阅读，它要求你围绕同一个主题阅读多本书，并比较它们的观点。',
        '主题阅读是最费力的，也是最有价值的阅读层次。你需要自己建立框架，而不是跟随某一本书的结构。',
        '做主题阅读时，先广读，再精选，最后整合为自己的知识体系。',
      ]],
    ];
    contents.forEach((ct, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'page-wrap';
      wrap.style.cssText = 'width:640px;height:820px;padding:70px;line-height:1.9;font-size:15px;';
      wrap.innerHTML = `<h2 style="margin-bottom:24px;font-size:20px;">${ct[0]}</h2>` +
        ct[1].map(p => `<p style="margin-bottom:18px;">${p}</p>`).join('') +
        `<div style="position:absolute;bottom:24px;left:0;right:0;text-align:center;color:#999;font-size:12px;">— ${i + 1} —</div>`;
      wrap.style.position = 'relative';
      el.pages.appendChild(wrap);
    });
    // 示例页不接线划选逻辑，用固定高亮展示效果
    S.annotations.forEach(a => {
      const wrap = el.pages.children[a.page - 1];
      if (!wrap) return;
      const d = document.createElement('div');
      d.className = 'hl-rect';
      d.style.cssText = `position:absolute;left:${a.rects[0].x - 70}px;top:${a.rects[0].y - 70}px;width:${a.rects[0].w}px;height:26px;background:${a.color};opacity:.45;border-radius:2px;`;
      wrap.appendChild(d);
    });
  }

  // ---------- 启动 ----------
  async function init() {
    bind();
    const q = new URLSearchParams(location.search);
    // ?sample=1 直接加载示例（便于演示/自动化验证）
    if (q.get('sample') === '1') { makeSample(); return; }
    // ?pdf=<url> 直接加载指定 PDF（便于验证真实渲染链路）
    if (q.get('pdf')) {
      fetch(q.get('pdf')).then(r => r.arrayBuffer()).then(b => loadPDF(b, q.get('pdf').split('/').pop()));
      return;
    }
    try {
      const had = await restore();
      if (had && S.pdfBytes) {
        await loadPDF(S.pdfBytes, S.pdfName, true);
      } else if (had && S.annotations.length) {
        // 只有标注数据、没有 PDF（如 JSON 恢复场景），显示脑图与大纲
        el.emptyState.classList.add('hidden');
        refreshAll();
      }
    } catch (err) { console.warn('restore failed', err); }
  }
  init();
})();
