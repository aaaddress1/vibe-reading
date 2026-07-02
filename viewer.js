'use strict';

const PDFJS = window.pdfjsLib;
PDFJS.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.js');

// ─── Target-language options ────────────────────────────────────────────────────
const TARGET_LANGS = [
  { code: 'zh-Hant', name: '繁體中文' },
  { code: 'zh-Hans', name: '简体中文' },
  { code: 'en',      name: 'English' },
  { code: 'ja',      name: '日本語' },
  { code: 'ko',      name: '한국어' },
  { code: 'fr',      name: 'Français' },
  { code: 'de',      name: 'Deutsch' },
  { code: 'es',      name: 'Español' },
  { code: 'pt',      name: 'Português' },
  { code: 'ru',      name: 'Русский' },
];

function browserDefaultTarget() {
  const l = (navigator.language || 'en').toLowerCase();
  if (l.startsWith('zh')) {
    return (l.includes('cn') || l.includes('hans') || l.includes('sg')) ? 'zh-Hans' : 'zh-Hant';
  }
  const primary = l.split('-')[0];
  return TARGET_LANGS.some(t => t.code === primary) ? primary : 'zh-Hant';
}

function langName(code) {
  return (TARGET_LANGS.find(t => t.code === code) || {}).name || code;
}

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const els = {
  appVer:        document.getElementById('appVer'),
  pdfSource:     document.getElementById('pdfSource'),
  srcLangInfo:   document.getElementById('srcLangInfo'),
  zoomIn:        document.getElementById('zoomIn'),
  zoomOut:       document.getElementById('zoomOut'),
  zoomFit:       document.getElementById('zoomFit'),
  zoomLabel:     document.getElementById('zoomLabel'),
  targetLang:    document.getElementById('targetLang'),
  aiBadge:       document.getElementById('aiBadge'),
  translateBtn:  document.getElementById('translateBtn'),
  stopBtn:       document.getElementById('stopBtn'),
  fontDec:       document.getElementById('fontDec'),
  fontInc:       document.getElementById('fontInc'),
  statusText:    document.getElementById('statusText'),
  progressWrap:  document.getElementById('progressWrap'),
  progressBar:   document.getElementById('progressBar'),
  progressLabel: document.getElementById('progressLabel'),
  errorBox:      document.getElementById('errorBox'),
  pdfPane:       document.getElementById('pdfPane'),
  pdfInner:      document.getElementById('pdfInner'),
  divider:       document.getElementById('divider'),
  summary:       document.getElementById('summary'),
  results:       document.getElementById('results'),
  askFloat:      document.getElementById('askFloat'),
  askFloatAsk:   document.getElementById('askFloatAsk'),
  askFloatTrans: document.getElementById('askFloatTrans'),
  askModal:      document.getElementById('askModal'),
  askSel:        document.getElementById('askSel'),
  askInput:      document.getElementById('askInput'),
  askSend:       document.getElementById('askSend'),
  askStop:       document.getElementById('askStop'),
  askAnswer:     document.getElementById('askAnswer'),
  askClose:      document.getElementById('askClose'),
  askHead:       document.getElementById('askHead'),
};

// ─── State ────────────────────────────────────────────────────────────────────
let pdfUrl        = null;
let pdfDoc        = null;
let abortCtrl     = null;
let translatorObj = null;
let paragraphs    = [];     // { page, text, rect:{x0,y0,x1,y1} }
const pageWraps   = {};     // pageNum -> { wrap, viewport }
let renderScale   = 1;
let detectedSource = 'en';
let selectedText  = '';
let summaryDone   = false;
let summaryObj    = null;   // generated AI summary, reused as Q&A context
let segEls        = [];     // paragraph index -> right-pane segment element

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  try { els.appVer.textContent = 'v' + chrome.runtime.getManifest().version; } catch (_) {}
  populateTargetSelect();
  setupFontControl();
  setupDivider();
  setupSelectionAsk();
  setupReverseLocate();
  setupZoom();
  setupKeyboardScroll();

  els.translateBtn.addEventListener('click', () => startTranslation(true));
  els.stopBtn.addEventListener('click', () => {
    abortCtrl?.abort();
    setStatus('已停止');
    swapButtons(false);
  });
  els.targetLang.addEventListener('change', async () => {
    chrome.storage.local.set({ targetLang: els.targetLang.value });
    await checkAI();
  });

  const params = new URLSearchParams(location.search);
  pdfUrl = params.get('file');

  await checkAI();

  if (!pdfUrl) {
    setStatus('未指定 PDF。請開啟一個 PDF 分頁後點擊插件圖示或右鍵選單。');
    return;
  }

  showPdfSource();

  try {
    await loadAndRenderPdf();
    detectedSource = await detectSourceLang();
    els.srcLangInfo.textContent = `偵測來源：${detectedSource}`;
    els.translateBtn.disabled = false;
    setStatus('PDF 已載入');
    // Requirement 4 — auto start translation
    if (!els.translateBtn.disabled) startTranslation(false);
  } catch (e) {
    showError('載入 PDF 失敗：' + e.message);
    setStatus('載入失敗');
  }
});

function populateTargetSelect() {
  els.targetLang.innerHTML = TARGET_LANGS
    .map(t => `<option value="${t.code}">${t.name}</option>`).join('');
  chrome.storage.local.get('targetLang', ({ targetLang }) => {
    els.targetLang.value = targetLang || browserDefaultTarget();
  });
  // set immediate default before storage resolves
  els.targetLang.value = browserDefaultTarget();
}

// ─── Translation font-size control (persisted) ──────────────────────────────────
const FONT_MIN = 10, FONT_MAX = 26, FONT_DEFAULT = 13;
let transFont = FONT_DEFAULT;

function applyTransFont(px) {
  transFont = Math.max(FONT_MIN, Math.min(FONT_MAX, px));
  // set on the root so both the translation list (#results) and the
  // AI summary card (#summary, a sibling of #results) inherit it
  document.documentElement.style.setProperty('--trans-font', transFont + 'px');
  chrome.storage.local.set({ transFont });
}

function setupFontControl() {
  chrome.storage.local.get('transFont', ({ transFont: saved }) => {
    applyTransFont(saved || FONT_DEFAULT);
  });
  applyTransFont(transFont);
  els.fontDec.addEventListener('click', () => applyTransFont(transFont - 1));
  els.fontInc.addEventListener('click', () => applyTransFont(transFont + 1));
}

// ─── AI availability ──────────────────────────────────────────────────────────
async function checkAI() {
  const badge = els.aiBadge;
  badge.textContent = '偵測中...';
  badge.className = 'badge';
  const target = els.targetLang.value;

  if ('Translator' in self) {
    try {
      const a = await Translator.availability({ sourceLanguage: 'en', targetLanguage: target });
      if (a !== 'unavailable') { badge.textContent = 'Translator API ✓'; badge.className = 'badge badge-ok'; return; }
    } catch (_) {}
  }
  if ('LanguageModel' in self) {
    try {
      const a = await LanguageModel.availability();
      if (a !== 'unavailable') { badge.textContent = 'Gemini Nano ✓'; badge.className = 'badge badge-ok'; return; }
    } catch (_) {}
  }

  badge.textContent = 'AI 不可用';
  badge.className = 'badge badge-err';
  els.translateBtn.disabled = true;
  showError(
    'Chrome 內建 AI 無法使用。請確認：\n' +
    '1. Chrome 版本 ≥ 138\n' +
    '2. chrome://flags 啟用「Prompt API」與「Translator API」\n' +
    '3. chrome://components 更新「Optimization Guide On Device Model」\n' +
    '4. 重新啟動 Chrome'
  );
}

// ─── PDF source chip + tab title ─────────────────────────────────────────────────
function showPdfSource() {
  const isFile = /^file:/i.test(pdfUrl);
  const fname  = decodeURIComponent(pdfUrl.split('/').pop().split('?')[0]) || pdfUrl;
  els.pdfSource.textContent = isFile ? `📁 本機檔案：${fname}` : `🌐 ${pdfUrl}`;
  els.pdfSource.title = pdfUrl;
  els.pdfSource.onclick = () => window.open(pdfUrl, '_blank');
  document.title = `[氛圍閱讀] ${fname}`;   // provisional; refined after metadata loads
}

// ─── Load & render PDF (canvas + selectable text layer) ─────────────────────────
let baseScale = 1;   // fit-to-width scale
let zoom      = 1;   // user zoom multiplier

async function loadAndRenderPdf() {
  setStatus('下載 PDF 檔案...');
  setIndeterminate(true);
  els.progressWrap.style.display = 'flex';

  const resp = await fetch(pdfUrl);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}（若為本機檔案，請到 chrome://extensions 開啟「允許存取檔案網址」）`);
  const buf = await resp.arrayBuffer();
  setIndeterminate(false);

  pdfDoc = await PDFJS.getDocument({ data: buf }).promise;

  // Tab title = [氛圍閱讀] <PDF metadata title, else filename>
  try {
    const meta = await pdfDoc.getMetadata();
    const docTitle = meta?.info?.Title?.trim();
    if (docTitle) document.title = `[氛圍閱讀] ${docTitle}`;
  } catch (_) {}

  // fit-to-width base scale
  const firstPage = await pdfDoc.getPage(1);
  const base = firstPage.getViewport({ scale: 1 });
  const paneW = els.pdfPane.clientWidth - 48;
  baseScale = Math.max(0.5, Math.min(2.5, paneW / base.width));
  zoom = 1;
  renderScale = baseScale * zoom;

  paragraphs = [];
  await renderPages(true);
  updateZoomLabel();
}

// Render (or re-render) every page at the current renderScale.
// Paragraphs are only extracted on the first pass (their rects are in
// scale-independent PDF coordinates, so zooming doesn't require recompute).
async function renderPages(computeParagraphs) {
  const dpr = window.devicePixelRatio || 1;
  const total = pdfDoc.numPages;
  els.pdfInner.innerHTML = '';
  for (const k in pageWraps) delete pageWraps[k];

  for (let p = 1; p <= total; p++) {
    setStatus(`渲染第 ${p} / ${total} 頁`);
    setProgress(p / total, `${p}/${total} 頁`);

    const page     = await pdfDoc.getPage(p);
    const viewport = page.getViewport({ scale: renderScale });
    const renderVp = page.getViewport({ scale: renderScale * dpr });

    const wrap = document.createElement('div');
    wrap.className = 'page-wrap';
    wrap.dataset.page = p;
    wrap.style.width  = viewport.width + 'px';
    wrap.style.height = viewport.height + 'px';

    const canvas = document.createElement('canvas');
    canvas.width  = renderVp.width;
    canvas.height = renderVp.height;
    canvas.style.width  = viewport.width + 'px';
    canvas.style.height = viewport.height + 'px';
    wrap.appendChild(canvas);
    els.pdfInner.appendChild(wrap);

    const content = await page.getTextContent();
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: renderVp }).promise;

    // Transparent text layer for native text selection (requirement 6).
    // pdf.js 3.x positions the spans via the CSS var --scale-factor; without it
    // the spans collapse to zero size and the text becomes unselectable.
    const textLayer = document.createElement('div');
    textLayer.className = 'textLayer';
    textLayer.style.width  = viewport.width + 'px';
    textLayer.style.height = viewport.height + 'px';
    textLayer.style.setProperty('--scale-factor', renderScale);
    wrap.appendChild(textLayer);
    try {
      await PDFJS.renderTextLayer({ textContentSource: content, container: textLayer, viewport, textDivs: [] }).promise;
    } catch (e) {
      console.warn('[PDF翻譯] 文字層渲染失敗（不影響翻譯）：', e);
    }

    pageWraps[p] = {
      wrap, canvas, textLayer, viewport,
      w1: viewport.width  / renderScale,   // intrinsic (scale-1) dimensions
      h1: viewport.height / renderScale,
    };

    if (computeParagraphs) {
      for (const para of extractParagraphs(content.items)) {
        paragraphs.push({ page: p, text: para.text, rect: para.rect });
      }
    }
  }
}

// ─── Zoom (independent of browser page zoom) ─────────────────────────────────────
let rerenderT = null;

function updateZoomLabel() {
  if (els.zoomLabel) els.zoomLabel.textContent = Math.round(zoom * 100) + '%';
}

// Zoom around a focal point. The anchor is captured as a specific PAGE plus a
// fraction within that page (measured from real element rects), so the constant
// inter-page gaps/padding don't distort it — after re-render the same page point
// is placed back under the focal Y. Fixes both figure drift and wrong-page jumps.
function setZoom(z, focalClientY) {
  if (!pdfDoc) return;
  const fcY = (focalClientY != null)
    ? focalClientY
    : els.pdfPane.getBoundingClientRect().top + els.pdfPane.clientHeight / 2;

  // capture which page + intra-page fraction sits at the focal Y (old layout)
  let anchorPage = null, anchorFy = 0.5;
  for (const k in pageWraps) {
    const r = pageWraps[k].wrap.getBoundingClientRect();
    if (fcY >= r.top && fcY <= r.bottom) { anchorPage = Number(k); anchorFy = (fcY - r.top) / r.height; break; }
  }
  if (anchorPage == null) {              // focal in a gap → use nearest page centre
    let bd = Infinity;
    for (const k in pageWraps) {
      const r = pageWraps[k].wrap.getBoundingClientRect();
      const d = Math.abs((r.top + r.bottom) / 2 - fcY);
      if (d < bd) { bd = d; anchorPage = Number(k); anchorFy = 0.5; }
    }
  }

  zoom = Math.max(0.4, Math.min(4, z));
  renderScale = baseScale * zoom;
  updateZoomLabel();

  // 1) Instant, smooth: stretch existing canvases via CSS and rescale the text
  //    layer through --scale-factor (its span positions are in scale-1 units,
  //    so they follow the variable). No re-rasterising → no flash, no lag.
  applyDisplayScale(renderScale);
  anchorScroll(anchorPage, anchorFy, fcY);

  // 2) After the gesture settles, re-rasterise in place to sharpen (no DOM
  //    rebuild → no flash, no scroll jump). Visible pages are sharpened first.
  clearTimeout(rerenderT);
  rerenderT = setTimeout(() => sharpenPages(), 200);
}

let sharpenGen = 0;
async function sharpenPages() {
  if (!pdfDoc) return;
  const gen = ++sharpenGen;
  const dpr = window.devicePixelRatio || 1;

  // order: pages currently in view first, then the rest
  const paneRect = els.pdfPane.getBoundingClientRect();
  const vis = [], rest = [];
  for (let p = 1; p <= pdfDoc.numPages; p++) {
    const pg = pageWraps[p]; if (!pg) continue;
    const r = pg.wrap.getBoundingClientRect();
    (r.bottom > paneRect.top && r.top < paneRect.bottom ? vis : rest).push(p);
  }

  for (const p of vis.concat(rest)) {
    if (gen !== sharpenGen) return;           // a newer zoom superseded us
    const pg = pageWraps[p]; if (!pg) continue;
    const page = await pdfDoc.getPage(p);
    if (gen !== sharpenGen) return;
    const sc = renderScale;
    const renderVp = page.getViewport({ scale: sc * dpr });
    pg.canvas.width  = renderVp.width;
    pg.canvas.height = renderVp.height;
    pg.canvas.style.width  = (pg.w1 * sc) + 'px';
    pg.canvas.style.height = (pg.h1 * sc) + 'px';
    await page.render({ canvasContext: pg.canvas.getContext('2d'), viewport: renderVp }).promise;
    pg.viewport = page.getViewport({ scale: sc });   // keep locate()/zoom anchor accurate
  }
}

// Live CSS resize of all pages (cheap; bitmap is GPU-scaled until re-rasterised)
function applyDisplayScale(scale) {
  for (const k in pageWraps) {
    const pg = pageWraps[k];
    const w = pg.w1 * scale, h = pg.h1 * scale;
    pg.wrap.style.width = w + 'px';
    pg.wrap.style.height = h + 'px';
    if (pg.canvas) { pg.canvas.style.width = w + 'px'; pg.canvas.style.height = h + 'px'; }
    if (pg.textLayer) {
      pg.textLayer.style.width = w + 'px';
      pg.textLayer.style.height = h + 'px';
      pg.textLayer.style.setProperty('--scale-factor', scale);
    }
  }
}

// Keep a given page + intra-page fraction anchored under the focal screen Y
function anchorScroll(page, fy, fcY) {
  const pg = pageWraps[page];
  if (!pg) return;
  const r = pg.wrap.getBoundingClientRect();
  els.pdfPane.scrollTop += (r.top + fy * r.height) - fcY;
}

function setupZoom() {
  els.zoomIn.addEventListener('click', () => setZoom(zoom * 1.2));
  els.zoomOut.addEventListener('click', () => setZoom(zoom / 1.2));
  els.zoomFit.addEventListener('click', () => setZoom(1));
  // Ctrl+wheel / trackpad pinch zooms ONLY the PDF pane (preventDefault stops
  // the browser from zooming the whole page), anchored at the cursor.
  els.pdfPane.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientY);
  }, { passive: false });
}

// Arrow keys / PageUp-Down / Home-End scroll the PDF pane (the div has no native
// keyboard scrolling like Chrome's built-in viewer does).
function setupKeyboardScroll() {
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (els.askModal.style.display !== 'none') return;   // modal/Esc handles its own keys

    const pane = els.pdfPane;
    const line = 90, page = pane.clientHeight * 0.9;
    switch (e.key) {
      case 'ArrowDown':  pane.scrollTop += line; break;
      case 'ArrowUp':    pane.scrollTop -= line; break;
      case 'ArrowRight': gotoPage(1);  break;   // next page
      case 'ArrowLeft':  gotoPage(-1); break;   // previous page
      case 'PageDown':   pane.scrollTop += page; break;
      case 'PageUp':     pane.scrollTop -= page; break;
      case 'Home':       pane.scrollTop  = 0; break;
      case 'End':        pane.scrollTop  = pane.scrollHeight; break;
      default: return;
    }
    e.preventDefault();
  });
}

// Jump to the previous/next page (←/→), like the native PDF viewer
function gotoPage(delta) {
  if (!pdfDoc) return;
  const paneTop = els.pdfPane.getBoundingClientRect().top;
  let curr = 1;
  for (let p = 1; p <= pdfDoc.numPages; p++) {
    const pg = pageWraps[p];
    if (pg && pg.wrap.getBoundingClientRect().bottom > paneTop + 4) { curr = p; break; }
  }
  const target = Math.max(1, Math.min(pdfDoc.numPages, curr + delta));
  const tr = pageWraps[target]?.wrap.getBoundingClientRect();
  if (tr) els.pdfPane.scrollBy({ top: (tr.top - paneTop) - 8, behavior: 'smooth' });
}

function extractParagraphs(items) {
  // Keep non-empty, horizontal text only — drop rotated items such as the
  // vertical "arXiv:…" watermark, which otherwise corrupts margin/column geometry.
  const its = items.filter(it =>
    it.str.trim() &&
    Math.abs(it.transform[1]) < 2 && Math.abs(it.transform[2]) < 2);
  if (!its.length) return [];

  // Build visual line fragments first. PDF.js may emit either whole-line items
  // or word/run-level items; column detection on raw items is therefore brittle.
  const lines = buildVisualLines(its);
  if (!lines.length) return [];

  const out = [];
  for (const block of readingBlocksFromLines(lines)) out.push(...paragraphsFromLines(block));
  return out;
}

function lineCompare(a, b) {
  const dy = b.y - a.y;
  return Math.abs(dy) > 2 ? dy : a.startX - b.startX;
}

function median(nums) {
  if (!nums.length) return 0;
  const a = nums.slice().sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

function makeLine(items, fallbackY) {
  const sorted = items.slice().sort((a, b) => a.transform[4] - b.transform[4]);
  const starts  = sorted.map(it => it.transform[4]);
  const ends    = sorted.map(it => it.transform[4] + (it.width || 0));
  const heights = sorted.map(it => it.height || 10);
  return {
    y: median(sorted.map(it => it.transform[5])) || fallbackY,
    startX: Math.min(...starts),
    endX: Math.max(...ends),
    fontH: median(heights) || 10,
    items: sorted,
    text: sorted.map(it => it.str).join(' ').replace(/\s+/g, ' ').trim(),
  };
}

function buildVisualLines(its) {
  const fontH = median(its.map(it => it.height || 10)) || 10;
  const rowTolerance = Math.max(3, fontH * 0.45);
  const sorted = its.slice().sort((a, b) => {
    const dy = b.transform[5] - a.transform[5];
    return Math.abs(dy) > rowTolerance ? dy : a.transform[4] - b.transform[4];
  });

  const rows = [];
  let row = { y: sorted[0].transform[5], items: [sorted[0]] };
  for (let i = 1; i < sorted.length; i++) {
    const y = sorted[i].transform[5];
    if (Math.abs(y - row.y) <= rowTolerance) row.items.push(sorted[i]);
    else { rows.push(row); row = { y, items: [sorted[i]] }; }
  }
  rows.push(row);

  const minX = Math.min(...its.map(it => it.transform[4]));
  const maxX = Math.max(...its.map(it => it.transform[4] + (it.width || 0)));
  const pageW = maxX - minX;
  const gapThreshold = Math.max(12, fontH * 1.15, pageW * 0.022);

  const lines = [];
  for (const r of rows) {
    const rowItems = r.items.slice().sort((a, b) => a.transform[4] - b.transform[4]);
    let frag = [rowItems[0]];
    let lastEnd = rowItems[0].transform[4] + (rowItems[0].width || 0);
    for (let i = 1; i < rowItems.length; i++) {
      const it = rowItems[i];
      const x = it.transform[4];
      const end = x + (it.width || 0);
      if (x - lastEnd > gapThreshold) {
        const line = makeLine(frag, r.y);
        if (line.text) lines.push(line);
        frag = [];
      }
      frag.push(it);
      lastEnd = Math.max(lastEnd, end);
    }
    const line = makeLine(frag, r.y);
    if (line.text) lines.push(line);
  }

  return lines.sort(lineCompare);
}

function detectTwoColumnLines(lines) {
  if (lines.length < 10) return { twoColumn: false };

  const minX = Math.min(...lines.map(l => l.startX));
  const maxX = Math.max(...lines.map(l => l.endX));
  const pageW = maxX - minX;
  if (pageW < 50) return { twoColumn: false };

  const bodyLines = lines.filter(l =>
    l.text.length >= 16 &&
    (l.endX - l.startX) > pageW * 0.18);
  if (bodyLines.length < 10) return { twoColumn: false };

  const n = bodyLines.length;
  let best = null;
  for (let gx = minX + pageW * 0.35; gx <= minX + pageW * 0.65; gx += 4) {
    let cross = 0, leftN = 0, rightN = 0;
    for (const l of bodyLines) {
      if (l.startX < gx && l.endX > gx) cross++;
      else if (l.endX <= gx) leftN++;
      else rightN++;
    }
    if (leftN > n * 0.15 && rightN > n * 0.15) {
      const score = cross + Math.abs(leftN - rightN) * 0.1;
      if (!best || score < best.score) best = { x: gx, cross, leftN, rightN, score };
    }
  }

  if (!best || best.cross > Math.max(4, n * 0.30)) return { twoColumn: false };

  const leftLines = bodyLines.filter(l => l.endX <= best.x);
  const rightLines = bodyLines.filter(l => l.startX >= best.x);
  const leftCenter = median(leftLines.map(l => (l.startX + l.endX) / 2));
  const rightCenter = median(rightLines.map(l => (l.startX + l.endX) / 2));
  if (rightCenter - leftCenter < pageW * 0.25) return { twoColumn: false };

  return { twoColumn: true, splitX: best.x, pageW };
}

function classifyLine(line, splitX, tol) {
  if (line.startX < splitX - tol && line.endX > splitX + tol) return 'full';
  return (line.startX + line.endX) / 2 < splitX ? 'left' : 'right';
}

function readingBlocksFromLines(lines) {
  const layout = detectTwoColumnLines(lines);
  if (!layout.twoColumn) return [lines.slice().sort(lineCompare)];

  const tol = Math.max(6, layout.pageW * 0.015);
  const annotated = lines
    .map(l => Object.assign({}, l, { column: classifyLine(l, layout.splitX, tol) }))
    .sort(lineCompare);

  const blocks = [];
  let zone = [];

  function flushZone() {
    if (!zone.length) return;
    const left = zone.filter(l => l.column === 'left').sort(lineCompare);
    const right = zone.filter(l => l.column === 'right').sort(lineCompare);
    if (left.length && right.length) {
      blocks.push(left, right);
    } else {
      blocks.push(zone.slice().sort(lineCompare));
    }
    zone = [];
  }

  for (let i = 0; i < annotated.length; i++) {
    const line = annotated[i];
    if (line.column !== 'full') {
      zone.push(line);
      continue;
    }

    flushZone();
    const fullRun = [line];
    while (i + 1 < annotated.length && annotated[i + 1].column === 'full') {
      fullRun.push(annotated[++i]);
    }
    blocks.push(fullRun.sort(lineCompare));
  }
  flushZone();

  return blocks.filter(b => b.length);
}

function paragraphsFromLines(lines) {
  const L = lines.slice().sort(lineCompare).filter(l => l.text);
  if (!L.length) return [];

  // Dominant left margin = most common startX (robust to outliers like
  // footnotes/indents); right margin = widest line. Avoids treating every
  // body line as "indented" when a stray element sits far to the left.
  const startBins = {};
  for (const l of L) { const k = Math.round(l.startX / 3) * 3; startBins[k] = (startBins[k] || 0) + 1; }
  const leftMargin = Number(Object.entries(startBins).sort((a, b) => b[1] - a[1])[0][0]);
  const rightEdge  = Math.max(...L.map(l => l.endX));
  const colWidth   = Math.max(1, rightEdge - leftMargin);

  const indentTol = Math.max(12, colWidth * 0.025);  // first-line indent
  const shortTol  = Math.max(16, colWidth * 0.15);   // ragged last line of a paragraph

  // Is this block justified (flush right margin)? If so, a line stopping short of
  // the right edge marks a paragraph end. For ragged / left-aligned text MOST
  // lines stop short, so that test would split every single line into its own
  // paragraph — there, rely on vertical gap + indent only.
  const justified = L.filter(l => l.endX > rightEdge - shortTol).length >= L.length * 0.6;

  // Typical in-paragraph line gap for THIS block. A paragraph break is a gap
  // clearly larger than that — measured relative to the block's own leading, so
  // loosely-leaded text isn't split on every line, and not tied to the
  // (unreliable) reported glyph height.
  const gaps = [];
  for (let i = 1; i < L.length; i++) gaps.push(Math.abs(L[i - 1].y - L[i].y));
  const sortedGaps = gaps.slice().sort((a, b) => a - b);
  const medianGap = sortedGaps.length ? sortedGaps[Math.floor(sortedGaps.length / 2)] : 0;

  // Split into paragraphs. indent/short tests are guarded against centred lines
  // (titles, author blocks) which inset on both sides.
  const groups = [];
  let g = [L[0]];
  for (let i = 1; i < L.length; i++) {
    const prev = L[i - 1], cur = L[i];
    const fh = Math.max(prev.fontH, cur.fontH) || 12;

    // Paragraph break on a clear vertical gap (relative to local font size, so
    // large-font titles stay intact) or a first-line indent. The previous
    // "short last line" rule was dropped — superscript/footnote markers and
    // ragged line ends made it over-segment paragraphs into fragments.
    const bigGap       = Math.abs(prev.y - cur.y) > fh * 1.4;
    const reachesRight = cur.endX > rightEdge - shortTol;
    // First-line indent is judged against NEIGHBOURING lines, not the global
    // page margin: a real paragraph-initial line is inset relative to the line
    // below it (which returns to the block's left edge). Blocks that are inset
    // as a whole (e.g. JMLR abstracts) have equal startX on every line, so they
    // no longer split line-by-line.
    const nxt          = L[i + 1];
    const blockLeft    = Math.min(prev.startX, nxt ? nxt.startX : prev.startX);
    const indented     = cur.startX > blockLeft + indentTol && reachesRight;

    if (bigGap || indented) { groups.push(g); g = []; }
    g.push(cur);
  }
  if (g.length) groups.push(g);

  return groups.map(grp => {
    const flat = grp.flatMap(l => l.items);
    const text = grp.map(l => l.text).join(' ').replace(/\s+/g, ' ').trim();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const it of flat) {
      const x = it.transform[4], y = it.transform[5];
      const w = it.width || 0, h = it.height || 10;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h);
    }
    return { text, rect: { x0, y0, x1, y1 } };
  }).filter(p => p.text.length > 20);
}

// ─── Source-language auto-detection (requirement 2) ─────────────────────────────
async function detectSourceLang() {
  const sample = paragraphs.slice(0, 5).map(p => p.text).join(' ').slice(0, 1000);
  if (!sample) return 'en';
  if ('LanguageDetector' in self) {
    try {
      const avail = await LanguageDetector.availability();
      if (avail !== 'unavailable') {
        const det = await LanguageDetector.create();
        const res = await det.detect(sample);
        if (res?.[0]?.detectedLanguage && res[0].detectedLanguage !== 'und') {
          return res[0].detectedLanguage;
        }
      }
    } catch (e) {
      console.warn('[PDF翻譯] 語言偵測失敗，預設 en：', e);
    }
  }
  return 'en';
}

// ─── Translator init ──────────────────────────────────────────────────────────
async function initTranslator(sourceLang, targetLang) {
  if (sourceLang === targetLang) sourceLang = sourceLang === 'en' ? 'fr' : 'en'; // avoid same-pair error

  if ('Translator' in self) {
    try {
      const avail = await Translator.availability({ sourceLanguage: sourceLang, targetLanguage: targetLang });
      if (avail !== 'unavailable') {
        if (avail === 'downloadable') { setStatus('首次使用：下載翻譯語言包...'); setProgress(0, '0%'); }
        const t = await Translator.create({
          sourceLanguage: sourceLang,
          targetLanguage: targetLang,
          monitor(m) {
            m.addEventListener('downloadprogress', (e) => {
              const pct = Math.round(e.loaded * 100);
              setStatus(`下載翻譯語言包 ${pct}%（僅首次）...`);
              setProgress(e.loaded, `${pct}%`);
            });
          },
        });
        return { type: 'translator', t, targetName: langName(targetLang) };
      }
    } catch (e) {
      console.warn('[PDF翻譯] Translator 初始化失敗，改用 Gemini Nano：', e);
    }
  }

  if ('LanguageModel' in self) {
    setStatus('首次使用：載入 Gemini Nano 模型（約 2.4GB）...');
    setIndeterminate(true);
    const targetName = langName(targetLang);
    const session = await LanguageModel.create({
      initialPrompts: [{ role: 'system', content: `你是專業翻譯員。請將輸入的文字翻譯成${targetName}，只輸出翻譯結果，不加任何說明文字。` }],
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          const pct = Math.round(e.loaded * 100);
          setStatus(`下載 Gemini Nano 模型 ${pct}%（僅首次）...`);
          setProgress(e.loaded, `${pct}%`);
        });
      },
    });
    setIndeterminate(false);
    return { type: 'lm', session, targetName };
  }

  throw new Error('無法初始化任何翻譯引擎。');
}

async function doTranslate(trans, text) {
  if (trans.type === 'translator') return await trans.t.translate(text);
  return await trans.session.prompt(`翻譯成${trans.targetName}（只輸出翻譯結果）：\n${text}`);
}

// ─── Translation flow ───────────────────────────────────────────────────────────
async function startTranslation(isManual) {
  if (abortCtrl) return; // already running
  clearError();
  els.results.innerHTML = '';

  if (!paragraphs.length) { showError('沒有可翻譯的文字（可能是掃描版 PDF）。'); return; }

  abortCtrl = new AbortController();
  const { signal } = abortCtrl;
  swapButtons(true);
  els.progressWrap.style.display = 'flex';

  try {
    setStatus('初始化翻譯引擎...');
    translatorObj = await initTranslator(detectedSource, els.targetLang.value);

    const total = paragraphs.length;
    const shells = paragraphs.map((p, i) => appendSegment(p, i));
    segEls = shells;
    const concurrency = translatorObj.type === 'translator' ? 4 : 1;

    // Requirement 5 — generate AI summary with Nano.
    // If translation uses NMT (different model), run summary concurrently;
    // if translation already uses Nano, defer summary to avoid contention.
    if (!summaryDone && translatorObj.type === 'translator') generateSummary();

    let done = 0, nextIdx = 0;
    async function worker() {
      while (true) {
        if (signal.aborted) return;
        const i = nextIdx++;
        if (i >= total) return;
        try {
          const translated = await doTranslate(translatorObj, paragraphs[i].text);
          fillTranslation(shells[i], translated);
        } catch (e) {
          fillTranslation(shells[i], `[翻譯失敗: ${e.message}]`, true);
        }
        done++;
        setProgress(done / total, `${done} / ${total}`);
        setStatus(`翻譯中 ${done} / ${total} 段`);
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));

    if (!signal.aborted) {
      setProgress(1, '完成');
      setStatus(`完成！共翻譯 ${total} 段（點任一段可定位原文）`);
      if (!summaryDone) generateSummary(); // deferred case
    }
  } catch (e) {
    if (e.name !== 'AbortError') { showError(e.message); setStatus('發生錯誤'); }
  } finally {
    swapButtons(false);
    abortCtrl = null;
  }
}

// ─── AI Summary (requirement 5, Gemini Nano) ─────────────────────────────────────
async function generateSummary() {
  if (summaryDone) return;
  if (!('LanguageModel' in self)) return;
  try {
    const avail = await LanguageModel.availability();
    if (avail === 'unavailable') return;
  } catch { return; }

  summaryDone = true;
  renderSummaryShell();

  try {
    const session = await LanguageModel.create({
      initialPrompts: [{ role: 'system', content: '你是學術論文分析助理，使用繁體中文、精煉地回答。' }],
    });

    // Nano has a limited context window — cap the input text.
    const fullText = paragraphs.map(p => p.text).join('\n');
    const text = fullText.slice(0, 7000);

    const schema = {
      type: 'object',
      properties: {
        background:  { type: 'string' },
        relatedWork: { type: 'string' },
        highlights:  { type: 'string' },
        conclusion:  { type: 'string' },
      },
      required: ['background', 'relatedWork', 'highlights', 'conclusion'],
    };

    const prompt =
      '以下是一篇論文的內文。請閱讀後，用繁體中文輸出四個面向的重點，每項約 2–4 句：\n' +
      '• background：研究背景與所需背景知識\n' +
      '• relatedWork：相關研究（Related Work）\n' +
      '• highlights：此研究的突破與亮點\n' +
      '• conclusion：總結\n\n論文內文：\n' + text;

    let obj;
    try {
      const raw = await session.prompt(prompt, { responseConstraint: schema });
      obj = JSON.parse(raw);
    } catch {
      const raw = await session.prompt(prompt + '\n\n請以 JSON 物件輸出，鍵為 background, relatedWork, highlights, conclusion。');
      obj = JSON.parse(raw.replace(/^[^{]*/, '').replace(/[^}]*$/, ''));
    }

    summaryObj = obj;          // reused as global context for the ask-AI feature
    renderSummary(obj);
    session.destroy();
  } catch (e) {
    console.warn('[PDF翻譯] 摘要產生失敗：', e);
    els.summary.innerHTML = `<div class="sum-head">🧠 AI 摘要</div><div class="sum-err">摘要產生失敗：${esc(e.message)}</div>`;
  }
}

function renderSummaryShell() {
  els.summary.style.display = '';
  els.summary.innerHTML = `
    <div class="sum-head">🧠 AI 摘要 <span class="sum-by">由 Gemini Nano 生成</span></div>
    <div class="sum-loading">分析整份論文中…（地端模型，請稍候）</div>`;
}

function renderSummary(obj) {
  const sec = (icon, title, body) => `
    <div class="sum-sec">
      <div class="sum-title">${icon} ${title}</div>
      <div class="sum-body">${esc(body || '—')}</div>
    </div>`;
  els.summary.style.display = '';
  els.summary.innerHTML =
    `<div class="sum-head">🧠 AI 摘要 <span class="sum-by">由 Gemini Nano 生成</span></div>` +
    sec('📘', '背景知識 Background', obj.background) +
    sec('🔗', '相關研究 Related Work', obj.relatedWork) +
    sec('✨', '突破亮點 Highlights', obj.highlights) +
    sec('📝', '總結 Conclusion', obj.conclusion);
}

// ─── Segment UI + click-to-locate ───────────────────────────────────────────────
function appendSegment(para, idx) {
  const div = document.createElement('div');
  div.className = 'segment';
  div.dataset.idx = idx;
  div.innerHTML = `
    <div class="seg-meta">
      <span class="seg-page">第 ${para.page} 頁</span>
      <span class="seg-num">#${idx + 1}</span>
    </div>
    <div class="seg-orig">${esc(para.text)}</div>
    <div class="seg-trans loading">翻譯中…</div>`;
  div.addEventListener('click', () => locate(idx, div));
  els.results.appendChild(div);
  return div;
}

function fillTranslation(el, text, isError = false) {
  const t = el.querySelector('.seg-trans');
  t.textContent = text;
  t.classList.remove('loading');
  if (isError) t.classList.add('err');
}

function locate(idx, segEl) {
  const para = paragraphs[idx];
  const pg = pageWraps[para.page];
  if (!pg) return;

  document.querySelectorAll('.seg-active').forEach(e => e.classList.remove('seg-active'));
  segEl.classList.add('seg-active');
  document.querySelectorAll('.hl').forEach(e => e.remove());

  const [ax, ay] = pg.viewport.convertToViewportPoint(para.rect.x0, para.rect.y0);
  const [bx, by] = pg.viewport.convertToViewportPoint(para.rect.x1, para.rect.y1);
  const pad = 4;
  const hl = document.createElement('div');
  hl.className = 'hl';
  hl.style.left   = (Math.min(ax, bx) - pad) + 'px';
  hl.style.top    = (Math.min(ay, by) - pad) + 'px';
  hl.style.width  = (Math.abs(bx - ax) + pad * 2) + 'px';
  hl.style.height = (Math.abs(by - ay) + pad * 2) + 'px';
  pg.wrap.appendChild(hl);
  hl.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ─── Reverse: click original text on the left → highlight translation on right ───
function setupReverseLocate() {
  els.pdfInner.addEventListener('click', (e) => {
    // If the user just made a text selection, leave it for the "ask AI" flow
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length >= 2) return;

    const wrap = e.target.closest('.page-wrap');
    if (!wrap) return;
    const pageNum = Number(wrap.dataset.page);
    const pg = pageWraps[pageNum];
    if (!pg) return;

    const box = wrap.getBoundingClientRect();
    const [px, py] = pg.viewport.convertToPdfPoint(e.clientX - box.left, e.clientY - box.top);

    const idx = findParagraphAt(pageNum, px, py);
    if (idx < 0) return;
    reverseLocate(idx, pg, paragraphs[idx]);
  });
}

function findParagraphAt(page, px, py) {
  let best = -1, bestArea = Infinity, nearest = -1, nearestDy = Infinity;
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    if (p.page !== page) continue;
    const r = p.rect;
    if (px >= r.x0 && px <= r.x1 && py >= r.y0 && py <= r.y1) {
      const area = (r.x1 - r.x0) * (r.y1 - r.y0);
      if (area < bestArea) { bestArea = area; best = i; }
    }
    const cy = (r.y0 + r.y1) / 2;
    const dy = Math.abs(cy - py);
    if (dy < nearestDy) { nearestDy = dy; nearest = i; }
  }
  // exact hit preferred; otherwise the vertically closest paragraph (within reason)
  if (best >= 0) return best;
  return nearestDy < 40 ? nearest : -1;
}

function reverseLocate(idx, pg, para) {
  const seg = segEls[idx];
  if (!seg) return;

  // highlight the segment on the right
  document.querySelectorAll('.seg-active').forEach(e => e.classList.remove('seg-active'));
  seg.classList.add('seg-active');
  seg.classList.remove('seg-flash');
  void seg.offsetWidth;            // restart CSS animation
  seg.classList.add('seg-flash');
  seg.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // also draw the highlight box on the PDF for visual confirmation
  document.querySelectorAll('.hl').forEach(e => e.remove());
  const [ax, ay] = pg.viewport.convertToViewportPoint(para.rect.x0, para.rect.y0);
  const [bx, by] = pg.viewport.convertToViewportPoint(para.rect.x1, para.rect.y1);
  const pad = 4;
  const hl = document.createElement('div');
  hl.className = 'hl';
  hl.style.left   = (Math.min(ax, bx) - pad) + 'px';
  hl.style.top    = (Math.min(ay, by) - pad) + 'px';
  hl.style.width  = (Math.abs(bx - ax) + pad * 2) + 'px';
  hl.style.height = (Math.abs(by - ay) + pad * 2) + 'px';
  pg.wrap.appendChild(hl);
}

// ─── Selection → ask Gemini Nano (requirement 6) ─────────────────────────────────
function setupSelectionAsk() {
  els.pdfPane.addEventListener('mouseup', () => {
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : '';
      if (text.length >= 2 && sel.rangeCount) {
        selectedText = text;
        const r = sel.getRangeAt(0).getBoundingClientRect();
        els.askFloat.style.display = '';
        els.askFloat.style.left = Math.min(window.innerWidth - 175, Math.max(4, r.left + r.width / 2 - 85)) + 'px';
        els.askFloat.style.top  = Math.max(8, r.top - 42) + 'px';
      } else {
        els.askFloat.style.display = 'none';
      }
    }, 10);
  });

  els.pdfPane.addEventListener('scroll', () => { els.askFloat.style.display = 'none'; });

  els.askFloatAsk.addEventListener('click', () => {
    els.askFloat.style.display = 'none';
    openAskModal(selectedText);
  });

  // Quick-translate: reuse the same panel, but skip the question flow and
  // immediately show the translation of the selected text.
  els.askFloatTrans.addEventListener('click', () => {
    els.askFloat.style.display = 'none';
    openAskModal(selectedText, 'translate');
    quickTranslateSelection(selectedText);
  });

  // Only the ✕ button or Escape close the modal — NOT clicking the backdrop,
  // which made it dismiss far too easily.
  els.askClose.addEventListener('click', closeAskModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.askModal.style.display !== 'none') closeAskModal();
  });

  els.askSend.addEventListener('click', askNano);
  els.askStop.addEventListener('click', () => askAbort?.abort());

  // Enter submits; Shift+Enter inserts a newline
  els.askInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); askNano(); }
  });

  // Drag the floating panel by its header
  let dragP = null;
  els.askHead.addEventListener('mousedown', (e) => {
    if (e.target === els.askClose) return;
    const box = els.askModal.getBoundingClientRect();
    dragP = { dx: e.clientX - box.left, dy: e.clientY - box.top };
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragP) return;
    const x = Math.max(0, Math.min(window.innerWidth  - 80, e.clientX - dragP.dx));
    const y = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - dragP.dy));
    els.askModal.style.left = x + 'px';
    els.askModal.style.top  = y + 'px';
    els.askModal.style.right = 'auto';
    els.askModal.style.bottom = 'auto';
  });
  document.addEventListener('mouseup', () => { dragP = null; });
}

let askAbort   = null;
let askSession = null;

function openAskModal(text, mode = 'ask') {
  els.askSel.textContent = text;
  els.askInput.value = '';
  els.askModal.style.display = 'flex';
  if (mode === 'translate') {
    // Translate mode: no typing needed — translation starts immediately.
    // The input stays available only for optional follow-up questions.
    els.askAnswer.textContent = '翻譯中…';
    els.askInput.placeholder = '想追問這段內容？輸入問題後按 Enter（直接翻譯無需輸入）';
    els.askInput.blur();
  } else {
    els.askAnswer.textContent = '';
    els.askInput.placeholder = '想問什麼？（Enter 送出，Shift+Enter 換行；留空＝請 AI 解釋這段文字）';
    els.askInput.focus();
  }
}

function closeAskModal() {
  askAbort?.abort();              // stop any in-flight answer
  els.askModal.style.display = 'none';
}

// Translate the selected snippet and show the result in the ask panel's
// answer area. Reuses the full-document translator when it's already
// initialised; otherwise initialises one on demand.
let quickTransGen = 0;
async function quickTranslateSelection(text) {
  const gen = ++quickTransGen;
  els.askAnswer.textContent = '翻譯中…';
  try {
    if (!translatorObj) {
      translatorObj = await initTranslator(detectedSource, els.targetLang.value);
    }
    const translated = await doTranslate(translatorObj, text);
    if (gen !== quickTransGen) return;                       // superseded / closed
    if (els.askModal.style.display === 'none') return;
    els.askAnswer.textContent = translated;
  } catch (e) {
    if (gen === quickTransGen) els.askAnswer.textContent = '翻譯失敗：' + e.message;
  }
}

function askSwap(running) {
  els.askSend.style.display = running ? 'none' : '';
  els.askStop.style.display = running ? '' : 'none';
}

// Locate the paragraph a selection came from, by matching its opening words
function findParagraphByText(snippet) {
  const norm = s => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const key = norm(snippet).slice(0, 40);
  if (key.length < 6) return -1;
  for (let i = 0; i < paragraphs.length; i++) {
    if (norm(paragraphs[i].text).includes(key)) return i;
  }
  return -1;
}

const clamp = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : (s || ''));

async function askNano() {
  if (askAbort) return; // already answering
  if (!('LanguageModel' in self)) { els.askAnswer.textContent = 'Gemini Nano 不可用，無法提問。'; return; }
  const question = els.askInput.value.trim() || '請用繁體中文解釋這段文字的意思與相關背景。';
  const snippet = els.askSel.textContent;

  askAbort = new AbortController();
  const { signal } = askAbort;
  askSwap(true);
  els.askAnswer.textContent = '思考中…';

  try {
    askSession = await LanguageModel.create({
      initialPrompts: [{ role: 'system', content: '你是研究助理。使用者會閱讀一篇論文並反白其中一段文字提問。請優先依據提供的「論文摘要」與「前後文」作答，用繁體中文回答；若需補充常識可適度補充並註明。' }],
    });

    // Build layered context within Nano's small context window:
    // global (AI summary) + local (neighbouring paragraphs) + the selection.
    const parts = [];
    if (summaryObj) {
      parts.push(
        '【論文摘要】\n' +
        `背景：${clamp(summaryObj.background, 220)}\n` +
        `相關研究：${clamp(summaryObj.relatedWork, 220)}\n` +
        `亮點：${clamp(summaryObj.highlights, 220)}\n` +
        `總結：${clamp(summaryObj.conclusion, 220)}`);
    }
    const idx = findParagraphByText(snippet);
    if (idx >= 0) {
      const ctx = [paragraphs[idx - 1], paragraphs[idx], paragraphs[idx + 1]]
        .filter(Boolean).map(p => p.text).join('\n');
      parts.push('【反白段落的前後文】\n' + clamp(ctx, 1500));
    }
    parts.push('【使用者反白的片段】\n' + clamp(snippet, 1000));
    parts.push('【問題】\n' + question);

    const prompt = parts.join('\n\n');
    const stream = askSession.promptStreaming(prompt, { signal });
    els.askAnswer.textContent = '';
    for await (const chunk of stream) {
      els.askAnswer.textContent += chunk;
      els.askAnswer.scrollTop = els.askAnswer.scrollHeight;
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      if (!els.askAnswer.textContent || els.askAnswer.textContent === '思考中…') els.askAnswer.textContent = '（已停止）';
      else els.askAnswer.textContent += '\n\n（已停止）';
    } else {
      els.askAnswer.textContent = '發生錯誤：' + e.message;
    }
  } finally {
    try { askSession?.destroy(); } catch (_) {}
    askSession = null;
    askAbort = null;
    askSwap(false);
  }
}

// ─── Resizable divider ──────────────────────────────────────────────────────────
function setupDivider() {
  let dragging = false;
  els.divider.addEventListener('mousedown', () => {
    dragging = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const pct = Math.min(80, Math.max(30, (e.clientX / window.innerWidth) * 100));
    els.pdfPane.style.flex = `0 0 ${pct}%`;
  });
  document.addEventListener('mouseup', () => {
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function swapButtons(translating) {
  els.translateBtn.style.display = translating ? 'none' : '';
  els.stopBtn.style.display      = translating ? '' : 'none';
}
function setStatus(msg) { els.statusText.textContent = msg; }
function setProgress(ratio, label) {
  setIndeterminate(false);
  els.progressBar.style.width = `${Math.round(ratio * 100)}%`;
  els.progressLabel.textContent = label || '';
}
function setIndeterminate(on) {
  if (on) {
    els.progressBar.classList.add('indeterminate');
    els.progressBar.style.width = '100%';
    els.progressLabel.textContent = '處理中...';
  } else {
    els.progressBar.classList.remove('indeterminate');
  }
}
function showError(msg) { els.errorBox.textContent = msg; els.errorBox.style.display = ''; }
function clearError() { els.errorBox.style.display = 'none'; }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
