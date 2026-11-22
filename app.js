/* ReadNote — 阅读 · 标注 · 脑图
 * 零构建纯前端应用。PDF.js 已本地化到 vendor/，离线可用。
 * v0.2：多文档书架 / PDF 目录书签 / 页码缩放 / 全文搜索 / 标注自动进脑图 / 标注编辑。
 */
(function () {
  'use strict';

  const DB_NAME = 'readnote', DB_VER = 2, STORE = 'state';
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

  const COLORS = ['#fff3a3', '#a8e6a3', '#a8d5ff', '#ffb3b3'];
  const SAMPLE_TEXT = [
    ['第一章 阅读的层次', [
      '阅读不只是获取信息，而是一种主动的心智活动。好书值得反复读，每一次重读都会有新的收获。',
      '分析的阅读，就是去理解一本书的结构。你要能说出这本书在谈什么，作者是怎么说的，以及它说得有没有道理。',
      '很多人读书只读一遍就放下，其实真正的理解发生在合上书之后的思考里。'
    ]],
    ['第二章 主题阅读', [
      '阅读的第四个层次是主题阅读，它要求你围绕同一个主题阅读多本书，并比较它们的观点。',
      '主题阅读是最费力的，也是最有价值的阅读层次。你需要自己建立框架，而不是跟随某一本书的结构。',
      '做主题阅读时，先广读，再精选，最后整合为自己的知识体系。'
    ]]
  ];

  const S = {
    library: { docs: [], currentId: null, dark: false },
    pdf: null,
    pdfName: '',
    pdfBytes: null,
    isSample: false,
    scale: 1.35,
    scaleMode: 'auto',
    pageEls: [],
    annotations: [],
    tree: null,
    bookmarks: [],
    recentPage: 1,
    outlineItems: [],
    pendingSel: null,
    editingAnnotationId: null,
    modalColor: COLORS[0],
    searchQuery: '',
    searchResults: [],
    ui: { tab: 'outline' },
  };

  const $ = (s) => document.querySelector(s);
  const el = {
    fileInput: $('#fileInput'), sampleBtn: $('#sampleBtn'), saveBtn: $('#saveBtn'),
    exportBtn: $('#exportBtn'), exportMenu: $('#exportMenu'),
    importBtn: $('#importBtn'), importInput: $('#importInput'), darkBtn: $('#darkBtn'),
    emptyState: $('#emptyState'), emptyDesc: $('#emptyDesc'), emptyOpen: $('#emptyOpen'),
    pages: $('#pages'), reader: $('#reader'),
    prevPage: $('#prevPage'), nextPage: $('#nextPage'), pageNum: $('#pageNum'), pageCount: $('#pageCount'),
    zoomOut: $('#zoomOut'), zoomIn: $('#zoomIn'), zoomFit: $('#zoomFit'), zoomLabel: $('#zoomLabel'),
    bookmarkBtn: $('#bookmarkBtn'), quickSearch: $('#quickSearch'),

    outlineWrap: $('#outlineWrap'), notesWrap: $('#notesWrap'), contentsWrap: $('#contentsWrap'),
    searchWrap: $('#searchWrap'), libraryWrap: $('#libraryWrap'),
    outlinePanel: $('#outlinePanel'), notesPanel: $('#notesPanel'), contentsPanel: $('#contentsPanel'),
    searchPanel: $('#searchPanel'), libraryPanel: $('#libraryPanel'),
    outlineFilter: $('#outlineFilter'), outlineColorFilter: $('#outlineColorFilter'), notesFilter: $('#notesFilter'),
    searchInputSide: $('#searchInputSide'),

    selToolbar: $('#selToolbar'), selNote: $('#selNote'),
    noteModal: $('#noteModal'), noteModalTitle: $('#noteModalTitle'), noteQuote: $('#noteQuote'),
    noteColors: $('#noteColors'), noteText: $('#noteText'), addToMap: $('#addToMap'),
    addToMapWrap: $('#addToMapWrap'), noteCancel: $('#noteCancel'), noteSave: $('#noteSave'),

    mindmap: $('#mindmap'), addNodeBtn: $('#addNodeBtn'), fitBtn: $('#fitBtn'), toast: $('#toast'),
  };

  const uid = () => 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const esc = (s) => (s == null ? '' : String(s)).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const baseName = () => (S.pdfName || 'readnote').replace(/\.pdf$/i, '') || 'readnote';
  const fmtDate = (t) => {
    if (!t) return '';
    const d = new Date(t), now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toTimeString().slice(0, 5);
    return (d.getMonth() + 1) + '/' + d.getDate();
  };

  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.toast.classList.add('hidden'), 2400);
  }

  function makeRoot(title) {
    return { id: 'root', title: title || '我的笔记', note: '', color: '#3a7d5d', sourceId: null, children: [] };
  }
  function curDoc() {
    return S.library.docs.find(d => d.id === S.library.currentId) || null;
  }
  function syncDoc() {
    const d = curDoc();
    if (!d) return;
    d.name = S.pdfName;
    d.pdfBytes = S.pdfBytes;
    d.annotations = S.annotations;
    d.tree = S.tree;
    d.bookmarks = S.bookmarks;
    d.recentPage = S.recentPage;
    d.pageCount = S.pdf ? S.pdf.numPages : (S.isSample ? SAMPLE_TEXT.length : 0);
    d.kind = S.isSample ? 'sample' : (S.pdfBytes ? 'pdf' : 'nopdf');
    d.updatedAt = Date.now();
  }

  // ---------- IndexedDB ----------
  function openDB() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, DB_VER);
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE);
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function persist(silent) {
    syncDoc();
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ version: 2, library: S.library }, 'main');
      tx.oncomplete = () => { if (!silent) toast('已保存'); res(); };
      tx.onerror = () => rej(tx.error);
    });
  }
  async function restore() {
    const db = await openDB();
    const data = await new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readonly');
      const rq = tx.objectStore(STORE).get('main');
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
      tx.onerror = () => rej(tx.error);
    });
    if (!data) return false;

    let docs = [];
    if (data.version >= 2 && data.library && Array.isArray(data.library.docs)) {
      docs = data.library.docs.map(d => ({
        id: d.id || uid(),
        name: d.name || d.pdfName || '未命名',
        pdfBytes: d.pdfBytes && (d.pdfBytes instanceof ArrayBuffer || ArrayBuffer.isView(d.pdfBytes)) ? d.pdfBytes : null,
        annotations: sanitizeAnnos(d.annotations),
        tree: sanitizeTree(d.tree, d.name || '我的笔记'),
        bookmarks: Array.isArray(d.bookmarks) ? d.bookmarks.filter(p => Number.isFinite(p)) : [],
        recentPage: d.recentPage || 1,
        pageCount: d.pageCount || 0,
        kind: d.kind || (d.pdfBytes ? 'pdf' : 'nopdf'),
        createdAt: d.createdAt || Date.now(),
        updatedAt: d.updatedAt || Date.now(),
      }));
      S.library = {
        docs,
        currentId: docs.some(d => d.id === data.library.currentId) ? data.library.currentId : (docs[0] && docs[0].id),
        dark: !!data.library.dark,
      };
    } else if (data.pdfBytes || (data.annotations && data.annotations.length)) {
      // 迁移 v1 单文档数据
      const id = uid();
      docs = [{
        id, name: data.pdfName || '旧版文档', pdfBytes: data.pdfBytes || null,
        annotations: data.annotations || [], tree: data.tree || makeRoot(data.pdfName || '我的笔记'),
        bookmarks: [], recentPage: 1, pageCount: 0,
        kind: data.pdfBytes ? 'pdf' : 'nopdf', createdAt: Date.now(), updatedAt: Date.now(),
      }];
      S.library = { docs, currentId: id, dark: false };
    } else {
      return false;
    }
    return docs.length > 0;
  }

  // ---------- 文档切换 / PDF 加载 ----------
  async function resolveDest(dest) {
    try {
      let d = dest;
      if (typeof d === 'string' && S.pdf.getDestination) d = await S.pdf.getDestination(d);
      if (Array.isArray(d) && d[0] && S.pdf.getPageIndex) return (await S.pdf.getPageIndex(d[0])) + 1;
    } catch (e) { /* ignore */ }
    return 1;
  }

  async function hydrateDoc(d) {
    S.library.currentId = d.id;
    S.pdfName = d.name || '未命名';
    S.pdfBytes = d.pdfBytes || null;
    S.annotations = Array.isArray(d.annotations) ? d.annotations : [];
    S.tree = d.tree || makeRoot(baseName());
    S.bookmarks = Array.isArray(d.bookmarks) ? d.bookmarks : [];
    S.recentPage = d.recentPage || 1;
    S.isSample = d.kind === 'sample';
    // 切换文档时销毁上一份 PDF.js 文档，释放 worker/内存，避免多次切换累积占用
    if (S.pdf && typeof S.pdf.destroy === 'function') {
      try { S.pdf.destroy().catch(() => {}); } catch (e) {}
    }
    S.pdf = null;
    S.outlineItems = S.isSample ? SAMPLE_TEXT.map((c, i) => ({ title: c[0], page: i + 1 })) : [];
    S.searchQuery = ''; S.searchResults = [];
    let pdfFailed = false;

    if (S.pdfBytes) {
      try {
        // PDF.js 会把传入的 buffer transfer 给 Worker，必须传副本，否则 S.pdfBytes 被 detach，
        // 后续 persist()/exportJSON() 会因无法克隆 detached ArrayBuffer 而失败。
        const workerBytes = S.pdfBytes.slice(0);
        S.pdf = await pdfjsLib.getDocument({ data: new Uint8Array(workerBytes) }).promise;
        const outline = await S.pdf.getOutline().catch(() => []) || [];
        S.outlineItems = await Promise.all(outline.map(async (o) => ({
          title: o.title || '未命名章节', page: await resolveDest(o.dest)
        })));
      } catch (err) {
        pdfFailed = true;
        toast('PDF 打开失败，标注仍保留');
        el.emptyDesc.textContent = 'PDF 打开失败：' + (err && err.message ? err.message : '文件可能损坏');
        el.emptyState.classList.remove('hidden');
        S.pdf = null;
      }
    }

    if (pdfFailed) {
      clearPages(true); // 保留上面的错误信息，不再被默认提示覆盖
    } else if (S.pdf) await renderAll();
    else if (S.isSample) renderSamplePages();
    else clearPages();
    refreshAll();
    applyDark();
  }

  async function loadPDF(bytes, name) {
    syncDoc();
    const d = {
      id: uid(), name: name || 'document.pdf', pdfBytes: bytes, annotations: [],
      tree: makeRoot((name || 'document').replace(/\.pdf$/i, '')), bookmarks: [], recentPage: 1,
      pageCount: 0, kind: 'pdf', createdAt: Date.now(), updatedAt: Date.now(),
    };
    S.library.docs.unshift(d);
    await hydrateDoc(d);
    await persist(true);
    toast(`已打开 ${d.name} · ${S.pdf ? S.pdf.numPages : 0} 页`);
  }

  async function makeSample() {
    syncDoc();
    const annotations = [
      { id: uid(), page: 1, text: '阅读不只是获取信息，而是一种主动的心智活动。', note: '主动阅读 = 带着问题读。', color: COLORS[0], rects: [{ x: 50, y: 142, w: 470, h: 26 }], createdAt: Date.now() },
      { id: uid(), page: 1, text: '分析的阅读，就是去理解一本书的结构。', note: '先读目录与前言，抓住骨架。', color: COLORS[1], rects: [{ x: 50, y: 242, w: 430, h: 26 }], createdAt: Date.now() },
      { id: uid(), page: 2, text: '主题阅读是最费力的，也是最有价值的阅读层次。', note: '围绕一个主题读多本书，再做整合。', color: COLORS[2], rects: [{ x: 50, y: 192, w: 470, h: 26 }], createdAt: Date.now() },
    ];
    const root = makeRoot('如何阅读一本书');
    root.children = [
      { id: uid(), title: '阅读的层次', note: '', color: '#fff', sourceId: null, kind: 'group', children: [] },
      { id: uid(), title: '主题阅读', note: '最高层次', color: COLORS[2], sourceId: annotations[2].id, children: [] },
    ];
    root.children[0].children = [
      { id: uid(), title: '主动阅读', note: '', color: COLORS[0], sourceId: annotations[0].id, children: [] },
      { id: uid(), title: '分析阅读', note: '', color: COLORS[1], sourceId: annotations[1].id, children: [] },
    ];
    const d = {
      id: uid(), name: '示例·如何阅读一本书', pdfBytes: null, annotations, tree: root,
      bookmarks: [1], recentPage: 1, pageCount: SAMPLE_TEXT.length, kind: 'sample',
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    S.library.docs.unshift(d);
    await hydrateDoc(d);
    await persist(true);
    toast('已加载示例（无需 PDF）');
  }

  async function switchDoc(id) {
    if (id === S.library.currentId) return;
    syncDoc();
    const d = S.library.docs.find(x => x.id === id);
    if (!d) return;
    await hydrateDoc(d);
    await persist(true);
    toast(`已切换到《${d.name}》`);
  }

  async function deleteDoc(id) {
    const d = S.library.docs.find(x => x.id === id);
    if (!d || !confirm(`删除《${d.name}》及其全部标注？此操作不可撤销。`)) return;
    S.library.docs = S.library.docs.filter(x => x.id !== id);
    if (S.library.currentId === id) {
      S.library.currentId = S.library.docs.length ? S.library.docs[0].id : null;
      const next = curDoc();
      if (next) await hydrateDoc(next); else clearAll();
    }
    refreshAll(); // 删除非当前文档时也要刷新书架列表
    await persist(true);
    toast('已删除');
  }

  function clearPages(keepDesc) {
    el.pages.innerHTML = '';
    el.pages.classList.add('hidden');
    el.emptyState.classList.remove('hidden');
    if (!keepDesc) el.emptyDesc.textContent = '当前文档没有可显示的 PDF 内容，从书架切换或重新打开 PDF。';
    S.pageEls = [];
    updateToolbar();
  }
  function clearAll() {
    S.pdf = null; S.pdfBytes = null; S.pdfName = ''; S.isSample = false;
    S.annotations = []; S.tree = makeRoot('我的笔记'); S.bookmarks = [];
    S.outlineItems = []; S.recentPage = 1; S.pageEls = [];
    el.pages.innerHTML = ''; el.pages.classList.add('hidden');
    el.emptyState.classList.remove('hidden');
    el.emptyDesc.textContent = '支持 PDF。选中文字即可高亮标注，标注会自动进入大纲和脑图。';
    refreshAll();
  }

  // ---------- PDF / 示例页渲染 ----------
  async function renderAll() {
    if (!S.pdf) return;
    el.pages.innerHTML = '';
    S.pageEls = [];
    el.emptyState.classList.add('hidden');
    el.pages.classList.remove('hidden');

    const base = (await S.pdf.getPage(1)).getViewport({ scale: 1 });
    const targetW = Math.min(el.reader.clientWidth - 80, 900);
    if (S.scaleMode === 'auto') S.scale = clamp(targetW / base.width, 0.8, 1.8);

    for (let n = 1; n <= S.pdf.numPages; n++) {
      const page = await S.pdf.getPage(n);
      const viewport = page.getViewport({ scale: S.scale });
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

      const searchLayer = document.createElement('div');
      searchLayer.className = 'search-layer';
      wrap.appendChild(searchLayer);

      const textLayer = document.createElement('div');
      textLayer.className = 'textLayer';
      wrap.appendChild(textLayer);

      el.pages.appendChild(wrap);
      const rec = { wrap, canvas, textLayer, hlLayer, searchLayer, pageNum: n, viewport, scale: S.scale };
      S.pageEls.push(rec);

      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      const tc = await page.getTextContent();
      if (pdfjsLib.TextLayer) {
        await new pdfjsLib.TextLayer({ textContentSource: tc, container: textLayer, viewport }).render();
      } else {
        await pdfjsLib.renderTextLayer({ textContent: tc, container: textLayer, viewport, textDivs: [] }).promise;
      }
      drawHighlights(rec);
      setupSelection(rec);
    }
    drawSearchHighlights();
    updateToolbar();
  }

  function renderSamplePages() {
    el.emptyState.classList.add('hidden');
    el.pages.classList.remove('hidden');
    el.pages.innerHTML = '';
    S.pageEls = [];
    S.scale = 1;

    SAMPLE_TEXT.forEach((ct, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'page-wrap sample-page';
      wrap.style.width = '640px'; wrap.style.height = '820px';
      const content = document.createElement('div');
      content.className = 'sample-content';
      content.innerHTML = `<h2>${esc(ct[0])}</h2>` + ct[1].map(p => `<p>${esc(p)}</p>`).join('') +
        `<div class="page-no">— ${i + 1} —</div>`;
      wrap.appendChild(content);
      const hlLayer = document.createElement('div');
      hlLayer.className = 'hl-layer';
      wrap.appendChild(hlLayer);
      const searchLayer = document.createElement('div');
      searchLayer.className = 'search-layer';
      wrap.appendChild(searchLayer);
      el.pages.appendChild(wrap);

      const rec = { wrap, content, hlLayer, searchLayer, pageNum: i + 1, scale: 1, isSample: true };
      S.pageEls.push(rec);
      setupSelection(rec);
      drawHighlights(rec);
    });
    drawSearchHighlights();
    updateToolbar();
  }

  // 标注坐标以逻辑坐标存储（left-top 原点），渲染时乘 rec.scale。
  function drawHighlights(rec) {
    if (!rec || !rec.hlLayer) return;
    rec.hlLayer.innerHTML = '';
    S.annotations.filter(a => a.page === rec.pageNum).forEach(a => {
      (a.rects || []).forEach(r => {
        const d = document.createElement('div');
        d.className = 'hl-rect' + (a._flash ? ' flash' : '');
        d.style.left = (r.x * rec.scale) + 'px';
        d.style.top = (r.y * rec.scale) + 'px';
        d.style.width = (r.w * rec.scale) + 'px';
        d.style.height = (r.h * rec.scale) + 'px';
        d.style.background = a.color || COLORS[0];
        rec.hlLayer.appendChild(d);
      });
      if (a._flash) setTimeout(() => { delete a._flash; }, 1300);
    });
  }
  function redrawAllHighlights() { S.pageEls.forEach(drawHighlights); }

  // ---------- 文本划选 ----------
  function setupSelection(rec) {
    const target = rec.textLayer || rec.content;
    if (!target) return;
    target.addEventListener('mouseup', () => {
      setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.toString().trim()) { hideSelToolbar(); return; }
        const range = sel.getRangeAt(0);
        if (!target.contains(range.commonAncestorContainer)) { hideSelToolbar(); return; }
        const rects = Array.from(range.getClientRects())
          .filter(r => r.width > 2 && r.height > 2)
          .map(r => ({
            x: (r.left - rec.wrap.getBoundingClientRect().left) / rec.scale,
            y: (r.top - rec.wrap.getBoundingClientRect().top) / rec.scale,
            w: r.width / rec.scale,
            h: r.height / rec.scale,
          }));
        if (!rects.length) { hideSelToolbar(); return; }
        S.pendingSel = { text: sel.toString().trim(), rects, page: rec.pageNum };
        const last = rects[rects.length - 1];
        const b = rec.wrap.getBoundingClientRect();
        showSelToolbar(b.left + last.x * rec.scale, b.top + (last.y + last.h) * rec.scale);
      }, 12);
    });
  }
  function showSelToolbar(x, y) {
    el.selToolbar.style.left = clamp(x - 40, 8, window.innerWidth - 260) + 'px';
    el.selToolbar.style.top = clamp(y + 6, 50, window.innerHeight - 60) + 'px';
    el.selToolbar.classList.remove('hidden');
  }
  function hideSelToolbar() { el.selToolbar.classList.add('hidden'); }

  function addAnnotation(color, note, addToMap) {
    const p = S.pendingSel;
    if (!p) return;
    if (S.editingAnnotationId) {
      const a = S.annotations.find(x => x.id === S.editingAnnotationId);
      if (a) { a.note = note || ''; a.color = color || COLORS[0]; }
    } else {
      S.annotations.push({
        id: uid(), page: p.page, text: p.text, note: note || '', color: color || COLORS[0],
        rects: p.rects, createdAt: Date.now(), noMap: addToMap === false,
      });
      S.annotations.sort((a, b) => a.page - b.page);
    }
    S.editingAnnotationId = null;
    S.pendingSel = null;
    window.getSelection().removeAllRanges();
    hideSelToolbar();
    redrawAllHighlights();
    refreshAll(); persist(true);
    toast('标注已保存');
  }

  function updateAnnotation(id, note, color) {
    const a = S.annotations.find(x => x.id === id);
    if (!a) return;
    a.note = note || '';
    a.color = color || COLORS[0];
    const walk = (n) => {
      if (n.sourceId === id) { n.color = a.color; n.note = a.note; n.title = a.text.slice(0, 42); }
      n.children.forEach(walk);
    };
    if (S.tree) walk(S.tree);
    refreshAll(); persist(true);
    toast('标注已更新');
  }

  function openNoteModal(a) {
    S.editingAnnotationId = a ? a.id : null;
    S.modalColor = a ? (a.color || COLORS[0]) : COLORS[0];
    if (!a && !S.pendingSel) return;
    el.noteModalTitle.textContent = a ? '编辑标注' : '标注笔记';
    el.noteQuote.textContent = ((a ? a.text : S.pendingSel.text) || '').slice(0, 240);
    el.noteText.value = a ? (a.note || '') : '';
    el.addToMapWrap.classList.toggle('hidden', !!a);
    el.addToMap.checked = true;
    el.noteColors.querySelectorAll('.color-dot').forEach(b => {
      b.classList.toggle('selected', b.dataset.color === S.modalColor);
      b.style.background = b.dataset.color;
    });
    el.noteModal.classList.remove('hidden');
    setTimeout(() => el.noteText.focus(), 20);
  }

  function deleteAnnotation(id) {
    S.annotations = S.annotations.filter(a => a.id !== id);
    const strip = (n) => {
      n.children = n.children.filter(c => c.sourceId !== id);
      n.children.forEach(strip);
    };
    if (S.tree) strip(S.tree);
    pruneEmptyGroups();
    if (mmSelected && !findNode(S.tree, mmSelected)) mmSelected = null;
    redrawAllHighlights();
    refreshAll(); persist(true); toast('标注已删除');
  }

  function jumpToAnnotation(id) {
    const a = S.annotations.find(x => x.id === id);
    if (!a) return;
    jumpToPage(a.page);
    setTimeout(() => {
      a._flash = true;
      const rec = S.pageEls[a.page - 1];
      if (rec) drawHighlights(rec);
    }, 260);
  }

  // ---------- 页码 / 缩放 / 书签 / 搜索 ----------
  function updateToolbar() {
    const total = S.pdf ? S.pdf.numPages : (S.isSample ? SAMPLE_TEXT.length : 0);
    el.pageCount.textContent = total || '—';
    el.pageNum.max = total || 1;
    S.recentPage = clamp(S.recentPage || 1, 1, total || 1);
    el.pageNum.value = S.recentPage;
    const hasPdf = !!S.pdf;
    el.zoomOut.disabled = !hasPdf;
    el.zoomIn.disabled = !hasPdf;
    el.zoomFit.disabled = !hasPdf;
    el.zoomLabel.textContent = hasPdf ? Math.round(S.scale * 100) + '%' : '—';
    updateBookmarkBtn();
  }
  function updateBookmarkBtn() {
    const on = S.bookmarks.includes(S.recentPage);
    el.bookmarkBtn.textContent = on ? '★' : '☆';
    el.bookmarkBtn.classList.toggle('active', on);
  }
  function toggleBookmark() {
    const i = S.bookmarks.indexOf(S.recentPage);
    if (i >= 0) S.bookmarks.splice(i, 1); else S.bookmarks.push(S.recentPage);
    S.bookmarks.sort((a, b) => a - b);
    updateBookmarkBtn(); refreshContents(); persist(true);
    toast(i >= 0 ? '已取消书签' : '已添加书签');
  }
  let scrollLock = false;
  function jumpToPage(n) {
    const rec = S.pageEls[clamp(n, 1, S.pageEls.length) - 1];
    if (!rec) return;
    S.recentPage = rec.pageNum;
    el.pageNum.value = rec.pageNum;
    updateBookmarkBtn();
    const delta = rec.wrap.getBoundingClientRect().top - el.reader.getBoundingClientRect().top - 46;
    scrollLock = true;
    el.reader.scrollTo({ top: el.reader.scrollTop + delta, behavior: 'smooth' });
    setTimeout(() => { scrollLock = false; }, 700);
  }
  async function setZoom(kind) {
    if (kind === 'in') { S.scale = clamp(S.scale + 0.15, 0.5, 2.6); S.scaleMode = 'custom'; }
    else if (kind === 'out') { S.scale = clamp(S.scale - 0.15, 0.5, 2.6); S.scaleMode = 'custom'; }
    else S.scaleMode = 'auto';
    if (S.pdf) {
      const page = S.recentPage;
      await renderAll();
      jumpToPage(page);
    } else {
      el.zoomLabel.textContent = Math.round(S.scale * 100) + '%';
    }
    persist(true);
  }

  function findTextRects(container, query, rec) {
    const out = [], needle = query.toLowerCase();
    if (!container || !needle) return out;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue || '';
      const lower = text.toLowerCase();
      let idx = lower.indexOf(needle);
      while (idx >= 0) {
        const range = document.createRange();
        range.setStart(node, idx); range.setEnd(node, idx + needle.length);
        Array.from(range.getClientRects()).forEach(r => {
          if (r.width > 1 && r.height > 1) out.push({
            x: (r.left - rec.wrap.getBoundingClientRect().left) / rec.scale,
            y: (r.top - rec.wrap.getBoundingClientRect().top) / rec.scale,
            w: r.width / rec.scale, h: r.height / rec.scale,
          });
        });
        idx = lower.indexOf(needle, idx + needle.length);
      }
    }
    return out;
  }
  function drawSearchHighlights() {
    S.pageEls.forEach(rec => {
      if (!rec.searchLayer) return;
      rec.searchLayer.innerHTML = '';
      if (!S.searchQuery) return;
      findTextRects(rec.textLayer || rec.content, S.searchQuery, rec).forEach(r => {
        const d = document.createElement('div');
        d.className = 'search-rect';
        d.style.left = (r.x * rec.scale) + 'px';
        d.style.top = (r.y * rec.scale) + 'px';
        d.style.width = (r.w * rec.scale) + 'px';
        d.style.height = (r.h * rec.scale) + 'px';
        rec.searchLayer.appendChild(d);
      });
    });
  }
  function setSearch(q, switchTab) {
    S.searchQuery = (q || '').trim();
    el.quickSearch.value = S.searchQuery;
    el.searchInputSide.value = S.searchQuery;
    drawSearchHighlights();
    refreshSearch();
    if (switchTab && S.searchQuery) switchTabTo('search');
  }

  // ---------- 侧栏面板 ----------
  function switchTabTo(tab) {
    S.ui.tab = tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    el.outlineWrap.classList.toggle('hidden', tab !== 'outline');
    el.notesWrap.classList.toggle('hidden', tab !== 'notes');
    el.contentsWrap.classList.toggle('hidden', tab !== 'contents');
    el.searchWrap.classList.toggle('hidden', tab !== 'search');
    el.libraryWrap.classList.toggle('hidden', tab !== 'library');
  }

  function refreshOutline() {
    const q = (el.outlineFilter.value || '').trim().toLowerCase();
    const color = el.outlineColorFilter.value;
    const list = S.annotations.filter(a => {
      if (color && a.color !== color) return false;
      if (q && !((a.text + ' ' + (a.note || '')).toLowerCase().includes(q))) return false;
      return true;
    });
    if (!list.length) {
      el.outlinePanel.innerHTML = '<div class="outline-empty">没有匹配的标注<br>选中 PDF 文字即可高亮</div>';
      return;
    }
    el.outlinePanel.innerHTML = list.map(a => `
      <div class="outline-item" data-id="${a.id}">
        <span class="dot" style="background:${esc(a.color)}"></span>
        <span class="pg">P${a.page}</span>
        <span class="txt">${esc(a.text.slice(0, 80))}${a.text.length > 80 ? '…' : ''}</span>
        <button class="item-btn" data-act="edit" title="编辑">✎</button>
        <button class="item-btn del-anno" data-act="del" title="删除">×</button>
      </div>`).join('');
    el.outlinePanel.querySelectorAll('.outline-item').forEach(it => {
      it.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-act]');
        if (btn) return;
        jumpToAnnotation(it.dataset.id);
      });
    });
    el.outlinePanel.querySelectorAll('button[data-act]').forEach(b => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const a = S.annotations.find(x => x.id === b.closest('.outline-item').dataset.id);
        if (b.dataset.act === 'del') deleteAnnotation(a.id);
        else if (a) openNoteModal(a);
      });
    });
  }

  function refreshNotes() {
    const q = (el.notesFilter.value || '').trim().toLowerCase();
    const list = S.annotations.filter(a => a.note && (!q || (a.text + a.note).toLowerCase().includes(q)));
    if (!list.length) {
      el.notesPanel.innerHTML = '<div class="notes-empty">没有匹配的笔记<br>标注时填写想法会出现在这里</div>';
      return;
    }
    el.notesPanel.innerHTML = list.map(a => `
      <div class="note-card" data-id="${a.id}">
        <div class="q">${esc(a.text.slice(0, 140))}</div>
        <div class="c">${esc(a.note)}</div>
        <div class="meta"><span class="pg">第 ${a.page} 页</span><span>
          <button data-act="edit">编辑</button>
          <button data-act="del">删除</button></span></div>
      </div>`).join('');
    el.notesPanel.querySelectorAll('.note-card').forEach(c => {
      c.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-act]');
        const a = S.annotations.find(x => x.id === c.dataset.id);
        if (!a) return;
        if (btn && btn.dataset.act === 'del') { e.stopPropagation(); deleteAnnotation(a.id); }
        else if (btn && btn.dataset.act === 'edit') { e.stopPropagation(); openNoteModal(a); }
        else jumpToAnnotation(a.id);
      });
    });
  }

  function refreshContents() {
    let html = '';
    if (S.bookmarks.length) {
      html += '<div class="section-title">书签</div>' + S.bookmarks.map(p =>
        `<div class="content-item" data-page="${p}"><span class="pg">P${p}</span><span class="title">跳转到第 ${p} 页</span></div>`
      ).join('');
    }
    if (S.outlineItems.length) {
      html += '<div class="section-title">PDF 目录</div>' + S.outlineItems.map(o =>
        `<div class="content-item" data-page="${o.page}"><span class="pg">P${o.page}</span><span class="title">${esc(o.title)}</span></div>`
      ).join('');
    }
    if (!html) html = '<div class="list-empty">这本书没有目录<br>可以用工具栏 ☆ 添加书签</div>';
    el.contentsPanel.innerHTML = html;
    el.contentsPanel.querySelectorAll('.content-item').forEach(it => {
      it.addEventListener('click', () => jumpToPage(+it.dataset.page));
    });
  }

  function refreshSearch() {
    const q = S.searchQuery;
    if (!q) {
      el.searchPanel.innerHTML = '<div class="list-empty">在上方或阅读器工具栏输入关键词<br>结果会同时高亮在页面上</div>';
      S.searchResults = [];
      return;
    }
    S.searchResults = S.pageEls.map(rec => {
      const text = ((rec.textLayer || rec.content)?.innerText || '').replace(/\s+/g, ' ');
      const i = text.toLowerCase().indexOf(q.toLowerCase());
      if (i < 0) return null;
      return { page: rec.pageNum, snippet: text.slice(Math.max(0, i - 24), i + q.length + 48) };
    }).filter(Boolean);
    el.searchPanel.innerHTML = S.searchResults.length
      ? `<div class="section-title">找到 ${S.searchResults.length} 页</div>` + S.searchResults.map(r => `
          <div class="content-item" data-page="${r.page}">
            <span class="pg">P${r.page}</span><span class="title">…${esc(r.snippet)}…</span>
          </div>`).join('')
      : '<div class="list-empty">没有找到匹配文字</div>';
    el.searchPanel.querySelectorAll('.content-item').forEach(it => {
      it.addEventListener('click', () => jumpToPage(+it.dataset.page));
    });
  }

  function refreshLibrary() {
    if (!S.library.docs.length) {
      el.libraryPanel.innerHTML = '<div class="list-empty">书架是空的<br>打开 PDF 或加载示例后会保存在这里</div>';
      return;
    }
    el.libraryPanel.innerHTML = S.library.docs.map(d => `
      <div class="library-item ${d.id === S.library.currentId ? 'active' : ''}" data-id="${d.id}">
        <span class="badge">${d.kind === 'sample' ? '示例' : ((d.pageCount || '—') + '页')}</span>
        <span class="info">
          <span class="li-name">${esc(d.name)}</span>
          <span class="li-meta">${d.annotations.length} 标注 · ${fmtDate(d.updatedAt)}</span>
        </span>
        <button class="li-del" title="删除这本书">删除</button>
      </div>`).join('');
    el.libraryPanel.querySelectorAll('.library-item').forEach(it => {
      it.addEventListener('click', (e) => {
        if (e.target.closest('.li-del')) { e.stopPropagation(); deleteDoc(it.dataset.id); }
        else switchDoc(it.dataset.id);
      });
    });
  }

  // ---------- 脑图 ----------
  function findNode(node, id) {
    if (!node) return null;
    if (node.id === id) return node;
    for (const c of node.children || []) { const r = findNode(c, id); if (r) return r; }
    return null;
  }
  function removeNode(node, id) {
    if (!node) return null;
    const i = (node.children || []).findIndex(c => c.id === id);
    if (i >= 0) return node.children.splice(i, 1)[0];
    for (const c of node.children || []) { const r = removeNode(c, id); if (r) return r; }
    return null;
  }
  function pruneEmptyGroups() {
    if (!S.tree) return;
    S.tree.children = S.tree.children.filter(n => !(n.kind === 'page' && !n.children.length));
  }
  function syncMapFromAnnotations() {
    if (!S.tree) S.tree = makeRoot(baseName());
    const known = new Set();
    const collect = (n) => { if (n.sourceId) known.add(n.sourceId); (n.children || []).forEach(collect); };
    collect(S.tree);
    S.annotations.filter(a => !a.noMap && !known.has(a.id)).forEach(a => {
      let group = S.tree.children.find(n => n.kind === 'page' && n.page === a.page);
      if (!group) {
        group = { id: uid(), title: `第 ${a.page} 页`, note: '', color: '#eef4f0', sourceId: null, kind: 'page', page: a.page, children: [] };
        S.tree.children.push(group);
      }
      group.children.push({
        id: uid(), title: a.text.slice(0, 42), note: a.note || '', color: a.color,
        sourceId: a.id, children: [],
      });
    });
    pruneEmptyGroups();
    S.tree.children.sort((a, b) => (a.page == null ? 1e9 : a.page) - (b.page == null ? 1e9 : b.page));
  }

  let mmSelected = null;
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
    return pos;
  }
  function applyMapScale(inner, maxX) {
    const availW = el.mindmap.clientWidth - 24 || 336;
    const scale = clamp(availW / maxX, 0.42, 1);
    inner.style.transformOrigin = '0 0';
    inner.style.transform = `scale(${scale})`;
    inner.dataset.baseW = maxX;
  }
  function fitMap() {
    const inner = el.mindmap.firstElementChild;
    if (inner && inner.dataset.baseW) applyMapScale(inner, +inner.dataset.baseW);
  }
  function refreshMap() {
    if (!S.tree) S.tree = makeRoot('我的笔记');
    if (!findNode(S.tree, 'root')) S.tree = makeRoot(baseName());
    const pos = layoutTree();
    const maxX = Math.max(...pos.values().map(p => p.x), 200) + 200;
    const maxY = Math.max(...pos.values().map(p => p.y), 100) + 80;
    el.mindmap.innerHTML = '';
    const inner = document.createElement('div');
    inner.style.cssText = `position:relative;width:${maxX}px;height:${maxY}px;`;

    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', maxX); svg.setAttribute('height', maxY);
    svg.style.cssText = 'position:absolute;inset:0;z-index:1;pointer-events:none;';
    const lines = (node) => {
      (node.children || []).forEach(c => {
        const a = pos.get(node.id), b = pos.get(c.id);
        if (a && b) {
          const p = document.createElementNS(ns, 'path');
          const x1 = a.x + 168, y1 = a.y + 18, x2 = b.x, y2 = b.y + 18;
          p.setAttribute('d', `M${x1},${y1} C${x1 + 35},${y1} ${x2 - 35},${y2} ${x2},${y2}`);
          p.setAttribute('fill', 'none'); p.setAttribute('stroke', '#b9c9bd'); p.setAttribute('stroke-width', '2');
          svg.appendChild(p);
        }
        lines(c);
      });
    };
    lines(S.tree); inner.appendChild(svg);

    const nodes = (node) => {
      const p = pos.get(node.id);
      const d = document.createElement('div');
      const cls = ['mm-node'];
      if (node.id === 'root') cls.push('root');
      if (node.kind === 'page') cls.push('page');
      if (node.id === mmSelected) cls.push('selected');
      d.className = cls.join(' ');
      d.style.left = p.x + 'px'; d.style.top = p.y + 'px';
      d.dataset.id = node.id; d.draggable = node.id !== 'root';
      let html = `<div class="ttl">${esc(node.title)}</div>`;
      if (node.sourceId) {
        const a = S.annotations.find(x => x.id === node.sourceId);
        if (a) html += `<span class="src">P${a.page} · ${esc(a.text.slice(0, 18))}…</span>`;
      }
      d.innerHTML = html;
      d.addEventListener('click', (e) => {
        e.stopPropagation(); mmSelected = node.id; refreshMap();
        if (node.sourceId) jumpToAnnotation(node.sourceId);
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
        const target = findNode(S.tree, node.id);
        if (moving && target) { target.children.push(moving); mmSelected = null; refreshMap(); persist(true); }
      });
      inner.appendChild(d);
      (node.children || []).forEach(nodes);
    };
    nodes(S.tree);
    el.mindmap.appendChild(inner);
    applyMapScale(inner, maxX);
  }
  function editNode(dom, node) {
    const ttl = dom.querySelector('.ttl');
    const old = node.title;
    ttl.innerHTML = `<input value="${esc(old)}">`;
    const input = ttl.querySelector('input');
    input.focus(); input.select();
    let done = false;
    const commit = (save) => {
      if (done) return; done = true;
      const v = input.value.trim();
      if (save && v) node.title = v;
      refreshMap(); persist(true);
    };
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') commit(true);
      if (e.key === 'Escape') commit(false);
    });
    input.addEventListener('blur', () => commit(true), { once: true });
  }
  function addMapNode(title, sourceId, color) {
    const node = { id: uid(), title: title || '新节点', note: '', color: color || '#fff', sourceId: sourceId || null, children: [] };
    (mmSelected ? findNode(S.tree, mmSelected) || S.tree : S.tree).children.push(node);
    refreshMap(); persist(true);
    return node;
  }
  function deleteSelectedNode() {
    if (!mmSelected || mmSelected === 'root') return;
    const node = findNode(S.tree, mmSelected);
    if (!node) return;
    // 由标注生成的节点被手动删掉后，要标记 noMap，否则下次 refreshAll 会被自动加回来
    if (node.sourceId) {
      const a = S.annotations.find(x => x.id === node.sourceId);
      if (a) a.noMap = true;
    }
    removeNode(S.tree, mmSelected);
    pruneEmptyGroups();
    mmSelected = null; refreshMap(); persist(true); toast('节点已删除');
  }

  function refreshAll() {
    syncDoc();
    syncMapFromAnnotations();
    syncDoc();
    refreshOutline(); refreshNotes(); refreshContents(); refreshLibrary(); refreshSearch(); refreshMap();
    updateToolbar();
  }

  function applyDark() {
    document.body.classList.toggle('dark', !!S.library.dark);
    el.darkBtn.textContent = S.library.dark ? '☀️' : '🌙';
  }

  // ---------- 导出 / 导入 ----------
  function download(name, content, type) {
    const blob = new Blob([content], { type: type || 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name.replace(/[\\/:*?"<>|]/g, '_');
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function exportMD() {
    let s = `# ${baseName()}\n\n`;
    const treeLines = (n, d) => {
      if (n.id !== 'root') s += '  '.repeat(d - 1) + `- ${n.title}${n.note ? '：' + n.note : ''}\n`;
      (n.children || []).forEach(c => treeLines(c, d + 1));
    };
    s += '## 脑图大纲\n\n'; treeLines(S.tree, 1);
    s += '\n## 标注与笔记\n\n';
    S.annotations.forEach((a, i) => {
      s += `### ${i + 1}. 第 ${a.page} 页\n\n> ${a.text.replace(/\n/g, ' ')}\n\n${a.note || ''}\n\n`;
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
    const walk = (n) => `<outline text="${esc(n.title)}"${n.note ? ` _note="${esc(n.note)}"` : ''}>${(n.children || []).map(walk).join('')}</outline>`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?><opml version="2.0"><head><title>${esc(baseName())}</title></head><body>${(S.tree.children || []).map(walk).join('')}</body></opml>`;
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
  function bufToB64(buf) {
    if (!buf) return null;
    const bytes = new Uint8Array(buf), CHUNK = 0x8000;
    let bin = '';
    for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    return btoa(bin);
  }
  function b64ToBuf(b64) {
    if (!b64) return null;
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }
  function exportJSON() {
    syncDoc();
    const payload = {
      app: 'ReadNote', version: 3, name: S.pdfName, pdfName: S.pdfName,
      pdfB64: bufToB64(S.pdfBytes), kind: S.isSample ? 'sample' : 'pdf',
      annotations: S.annotations, tree: S.tree, bookmarks: S.bookmarks,
    };
    download(baseName() + '_backup.json', JSON.stringify(payload), 'application/json');
  }
  function sanitizeAnnos(list) {
    if (!Array.isArray(list)) return [];
    return list.filter(a => a && typeof a === 'object').map(a => ({
      id: typeof a.id === 'string' && a.id ? a.id : uid(),
      page: Math.max(1, Number(a.page) || 1),
      text: typeof a.text === 'string' ? a.text : String(a.text == null ? '' : a.text),
      note: typeof a.note === 'string' ? a.note : '',
      color: typeof a.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(a.color) ? a.color : COLORS[0],
      rects: Array.isArray(a.rects) ? a.rects.filter(r => r && typeof r === 'object' && Number.isFinite(r.x) && Number.isFinite(r.y)) : [],
      noMap: !!a.noMap,
      createdAt: Number(a.createdAt) || Date.now(),
    }));
  }
  function sanitizeTree(tree, name) {
    const fallback = makeRoot(name || '我的笔记');
    if (!tree || typeof tree !== 'object') return fallback;
    const walk = (n, depth) => {
      if (!n || typeof n !== 'object' || depth > 40) return null;
      const kids = Array.isArray(n.children) ? n.children.map(c => walk(c, depth + 1)).filter(Boolean) : [];
      return {
        id: n.id === 'root' ? 'root' : (typeof n.id === 'string' && n.id ? n.id : uid()),
        title: typeof n.title === 'string' ? n.title : '未命名',
        note: typeof n.note === 'string' ? n.note : '',
        color: typeof n.color === 'string' ? n.color : '#3a7d5d',
        sourceId: typeof n.sourceId === 'string' ? n.sourceId : null,
        kind: n.kind,
        page: Number.isFinite(n.page) ? n.page : undefined,
        children: kids,
      };
    };
    const root = walk(tree, 0);
    if (!root || root.id !== 'root') return fallback;
    root.title = root.title || (name || '我的笔记');
    return root;
  }
  async function importJSON(file) {
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'ReadNote') throw new Error('不是 ReadNote 备份文件');
      const bytes = b64ToBuf(data.pdfB64);
      const d = {
        id: uid(), name: data.name || data.pdfName || '导入的文档',
        pdfBytes: bytes, annotations: sanitizeAnnos(data.annotations),
        tree: sanitizeTree(data.tree, data.name || data.pdfName),
        bookmarks: Array.isArray(data.bookmarks) ? data.bookmarks.filter(p => Number.isFinite(p)) : [],
        recentPage: 1, pageCount: 0, kind: bytes ? 'pdf' : (data.kind === 'sample' ? 'sample' : 'nopdf'),
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      syncDoc();
      S.library.docs.unshift(d);
      await hydrateDoc(d);
      await persist(true);
      toast(`已导入：${d.annotations.length} 条标注${bytes ? ' + PDF' : ''}`);
    } catch (err) {
      toast('导入失败：' + (err.message || '文件格式错误'));
    }
  }

  // ---------- 事件 ----------
  function bind() {
    el.emptyOpen.addEventListener('click', () => el.fileInput.click());
    el.fileInput.addEventListener('change', e => {
      const f = e.target.files[0]; if (!f) return;
      f.arrayBuffer().then(b => loadPDF(b, f.name));
      e.target.value = '';
    });
    el.sampleBtn.addEventListener('click', makeSample);
    el.saveBtn.addEventListener('click', () => persist());
    el.importBtn.addEventListener('click', () => el.importInput.click());
    el.importInput.addEventListener('change', e => {
      const f = e.target.files[0]; if (!f) return;
      importJSON(f); e.target.value = '';
    });
    el.darkBtn.addEventListener('click', () => {
      S.library.dark = !S.library.dark; applyDark(); persist(true);
    });

    document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => switchTabTo(t.dataset.tab)));
    el.outlineFilter.addEventListener('input', refreshOutline);
    el.outlineColorFilter.addEventListener('change', refreshOutline);
    el.notesFilter.addEventListener('input', refreshNotes);

    const searchDebounce = (cb) => { clearTimeout(searchDebounce._t); searchDebounce._t = setTimeout(cb, 180); };
    el.quickSearch.addEventListener('input', () => searchDebounce(() => setSearch(el.quickSearch.value, true)));
    el.searchInputSide.addEventListener('input', () => searchDebounce(() => setSearch(el.searchInputSide.value, false)));

    el.prevPage.addEventListener('click', () => jumpToPage(S.recentPage - 1));
    el.nextPage.addEventListener('click', () => jumpToPage(S.recentPage + 1));
    el.pageNum.addEventListener('change', () => jumpToPage(+el.pageNum.value || 1));
    el.zoomOut.addEventListener('click', () => setZoom('out'));
    el.zoomIn.addEventListener('click', () => setZoom('in'));
    el.zoomFit.addEventListener('click', () => setZoom('fit'));
    el.bookmarkBtn.addEventListener('click', toggleBookmark);
    el.reader.addEventListener('scroll', () => {
      if (scrollLock) return;
      const top = el.reader.getBoundingClientRect().top + 48;
      let best = 1;
      S.pageEls.forEach((r, i) => {
        if (r.wrap.getBoundingClientRect().top <= top + 12) best = i + 1;
      });
      if (best !== S.recentPage) { S.recentPage = best; el.pageNum.value = best; updateBookmarkBtn(); }
    });

    el.exportBtn.addEventListener('click', e => { e.stopPropagation(); el.exportMenu.classList.toggle('hidden'); });
    document.addEventListener('click', () => el.exportMenu.classList.add('hidden'));
    el.exportMenu.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      ({ md: exportMD, html: exportHTML, opml: exportOPML, anki: exportAnki, json: exportJSON }[b.dataset.export] || (() => {}))();
      toast('已导出 ' + b.textContent);
    }));

    el.selToolbar.querySelectorAll('.hl').forEach(b => b.addEventListener('click', () => addAnnotation(b.dataset.color, '')));
    el.selNote.addEventListener('click', () => openNoteModal(null));
    el.noteColors.querySelectorAll('.color-dot').forEach(b => b.addEventListener('click', () => {
      S.modalColor = b.dataset.color;
      el.noteColors.querySelectorAll('.color-dot').forEach(x => x.classList.toggle('selected', x === b));
    }));
    el.noteCancel.addEventListener('click', () => {
      el.noteModal.classList.add('hidden'); S.editingAnnotationId = null;
    });
    el.noteSave.addEventListener('click', () => {
      const note = el.noteText.value.trim();
      if (S.editingAnnotationId) updateAnnotation(S.editingAnnotationId, note, S.modalColor);
      else addAnnotation(S.modalColor, note, el.addToMap.checked);
      S.editingAnnotationId = null;
      el.noteModal.classList.add('hidden');
    });

    el.addNodeBtn.addEventListener('click', () => addMapNode('新节点'));
    el.fitBtn.addEventListener('click', () => { fitMap(); el.mindmap.scrollTo(0, 0); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Delete' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) deleteSelectedNode();
      if (e.key === 'Escape') {
        el.noteModal.classList.add('hidden');
        S.editingAnnotationId = null;
        hideSelToolbar();
        el.exportMenu.classList.add('hidden');
      }
    });
    document.addEventListener('click', e => {
      if (!e.target.closest('.mm-node') && !e.target.closest('.modal')) {
        if (mmSelected) { mmSelected = null; refreshMap(); }
      }
    });
  }

  async function init() {
    bind();
    const q = new URLSearchParams(location.search);
    let had = false;
    try {
      had = await restore();
      applyDark();
    } catch (err) { console.warn('restore failed', err); }

    if (q.get('sample') === '1') {
      const existing = S.library.docs.find(d => d.kind === 'sample');
      if (existing) await hydrateDoc(existing); else await makeSample();
      return;
    }
    if (had && curDoc()) await hydrateDoc(curDoc());
    const pdfUrl = q.get('pdf');
    if (pdfUrl) {
      fetch(pdfUrl).then(r => r.arrayBuffer()).then(b => loadPDF(b, pdfUrl.split('/').pop()))
        .catch(() => toast('远程 PDF 加载失败'));
    }
  }
  init();
})();
