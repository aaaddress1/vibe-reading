'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { viewportBox, splitTranslation } = require('../pdf-overlay.js');
const code = fs.readFileSync(path.join(__dirname, '..', 'pdf-overlay.js'), 'utf8');

test('PDF boxes follow rotated and cropped viewports using all four corners', () => {
  assert.deepEqual(viewportBox({ x0: 20, y0: 30, x1: 120, y1: 80 },
    { convertToViewportPoint: (x, y) => [2 * (y - 10), 2 * (x - 5)] }),
  { x: 40, y: 30, width: 100, height: 200 });
});

test('joined columns/pages share one translation with no duplicated or lost text', () => {
  const text = '研究背景很重要。接著介紹實驗，最後說明結果與限制。📖👨‍👩‍👧‍👦';
  const parts = [{ text: 'a'.repeat(30) }, { text: 'b'.repeat(70) }, { text: 'c'.repeat(40) }];
  const split = splitTranslation(text, parts);
  assert.equal(split.length, 3);
  assert.equal(split.join(''), text);
  assert.equal(split.filter(p => p.includes('👨‍👩‍👧‍👦')).length, 1);
  assert.ok(split.every(p => p.length < text.length));
});

test('Latin words stay intact at physical block boundaries', () => {
  const text = 'This experiment measures translation accuracy and preserves every word across two pages.';
  const pieces = splitTranslation(text, [{ text: 'a'.repeat(50) }, { text: 'b'.repeat(50) }]);
  assert.equal(pieces.join(''), text);
  assert.ok(/\s$/.test(pieces[0]) || /^\s/.test(pieces[1]));
  assert.deepEqual(splitTranslation(text, [{}]), [text]);
});

test('short section headings and layout-detected titles are retained for PDF overlays', () => {
  const viewer = fs.readFileSync(path.join(__dirname, '..', 'viewer.js'), 'utf8');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(viewer.slice(viewer.indexOf('const LAYOUT_TEXT ='), viewer.indexOf('// ─── Translation engine')), ctx);
  const line = (text, y, fontH = 10) => ({ text, y, fontH, startX: 40, endX: 250,
    items: [{ str: text, transform: [fontH, 0, 0, fontH, 40, y], width: 210, height: fontH }] });
  const result = ctx.paragraphsFromLines([line('Introduction', 700, 13),
    line('This paragraph introduces the research.', 670), line('It continues across another visual line.', 656)]);
  assert.ok(result.some(p => p.text === 'Introduction' && p.isHeading));
  assert.equal(ctx.paragraphsFromLines([line('Methods', 700, 13)], { keepShort: true })[0].text, 'Methods');
  assert.equal(ctx.paragraphsFromLines([line('42', 700, 13)], { keepShort: true }).length, 0);
});

test('last selected reading mode is restored in a new viewer, with paragraph mode as the safe default', async () => {
  const viewer = fs.readFileSync(path.join(__dirname, '..', 'viewer.js'), 'utf8');
  const modeCode = viewer.slice(viewer.indexOf('async function setupReadingMode()'), viewer.indexOf('// ─── PDF dark mode'));
  const saved = {};
  async function openViewer() {
    const attrs = {}, clicks = {};
    const ctx = { pdfDoc: null, pageWraps: {}, pdfOverlay: null, readingMode: 'paragraphs', paragraphPaneFlex: '',
      transFont: 13, FONT_DEFAULT: 13,
      window: { VibePdfOverlay: { Reader: class { setFontRatio() {} setEnabled() {} }, captureAnchor: () => null } },
      document: { body: { classList: { toggle() {} } } },
      els: { pdfPane: { scrollTop: 0, style: {} }, transPane: {}, translatedPdfPane: {}, translatedPdfInner: {},
        pdfLayoutBtn: { setAttribute: (key, value) => { attrs[key] = value; }, addEventListener: (type, cb) => { clicks[type] = cb; } } },
      chrome: { storage: { local: { set: v => Object.assign(saved, v) } } },
      storageGet: async () => saved,
    };
    vm.createContext(ctx); vm.runInContext(modeCode, ctx);
    await ctx.setupReadingMode();
    return { ctx, attrs, clicks };
  }
  const first = await openViewer();
  assert.equal(first.ctx.readingMode, 'paragraphs');
  first.clicks.click();
  assert.equal(saved.pdfReadingMode, 'layout');
  const next = await openViewer();
  assert.equal(next.ctx.readingMode, 'layout');
  assert.equal(next.attrs['aria-pressed'], 'true');
  assert.equal(next.ctx.els.transPane.hidden, true);
  next.clicks.click();
  assert.equal(saved.pdfReadingMode, 'paragraphs');
  assert.equal((await openViewer()).ctx.readingMode, 'paragraphs');
  saved.pdfReadingMode = 'invalid';
  assert.equal((await openViewer()).ctx.readingMode, 'paragraphs');
});

test('opening a PDF initializes the translated view at the actual fit-to-width scale', async () => {
  const viewer = fs.readFileSync(path.join(__dirname, '..', 'viewer.js'), 'utf8');
  const calls = [];
  const pane = { clientWidth: 948 };
  const ctx = { pdfUrl: null, readingMode: 'layout', baseScale: 1, zoom: 1, renderScale: 1, pdfDoc: null, paragraphs: [], pageWraps: {},
    document: {}, els: { progressWrap: { style: {} }, pdfPane: pane, pdfLayoutBtn: {} },
    PDFJS: { getDocument: () => ({ promise: Promise.resolve({ getMetadata: async () => ({}),
      getPage: async () => ({ getViewport: () => ({ width: 600 }) }) }) }) },
    setStatus() {}, setIndeterminate() {}, scheduleSharpen() {}, updateZoomLabel() {},
    renderPages: async () => {}, refineParagraphs: p => p,
    pdfOverlay: { setDocument: () => calls.push('document'), setScale: s => calls.push(s), syncFrom: p => calls.push(p) },
  };
  vm.createContext(ctx);
  vm.runInContext(viewer.slice(viewer.indexOf('async function loadAndRenderPdf('), viewer.indexOf('// Render (or re-render)')), ctx);
  await ctx.loadAndRenderPdf(async () => new ArrayBuffer(0));
  assert.deepEqual(calls, ['document', 1.5, pane]);
  assert.equal(ctx.els.pdfLayoutBtn.disabled, false);
  pane.clientWidth = 180;
  await ctx.loadAndRenderPdf(async () => new ArrayBuffer(0));
  assert.equal(ctx.renderScale, 0.22, 'two narrow PDF panes must still fit their page width');
});

function fixture(count = 6) {
  const frames = new Map();
  const timers = new Map(), edits = [], located = [];
  let frameId = 0, timerId = 0, drawCount = 0;
  function element(tag) {
    const classes = new Set();
    const handlers = {};
    const el = { tag, style: {}, dataset: {}, children: [], textContent: '', width: 600, height: 800,
      classList: { add: n => classes.add(n), remove: n => classes.delete(n), contains: n => classes.has(n),
        toggle(n, on) { if (on) classes.add(n); else classes.delete(n); } },
      setAttribute() {}, removeAttribute() {},
      addEventListener(type, cb) { (handlers[type] ||= []).push(cb); },
      removeEventListener(type, cb) { handlers[type] = (handlers[type] || []).filter(fn => fn !== cb); },
      get innerText() { return this.textContent; }, set innerText(text) { this.textContent = text; },
      fire(type, props = {}) {
        const event = { detail: 1, relatedTarget: null, preventDefault() {}, stopPropagation() {}, ...props };
        (handlers[type] || []).forEach(cb => cb(event));
      },
      focus() {},
      contains(child) { return child === this || this.children.some(c => c.contains(child)); },
      getBoundingClientRect: () => ({ left: 200, top: 200, bottom: 300, height: 100 }),
      appendChild(child) { child.parent = this; this.children.push(child); return child; },
      prepend(child) { child.parent = this; this.children.unshift(child); },
      replaceChildren() { this.children.forEach(c => { c.parent = null; }); this.children = []; },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; },
      replaceWith(next) { const p = this.parent; const i = p.children.indexOf(this); p.children[i] = next; next.parent = p; this.parent = null; },
      querySelectorAll() { return []; },
      getContext() { return { drawImage() { drawCount++; }, getImageData() { return { data: [255, 255, 255, 255] }; } }; },
      get clientWidth() { return parseFloat(this.style.width) || 600; },
      get clientHeight() { return parseFloat(this.style.height) || 800; },
      get scrollWidth() { return this.clientWidth; },
      get scrollHeight() {
        const font = parseFloat(this.style.fontSize) || 10;
        return Math.ceil(this.textContent.length * font / Math.max(1, this.clientWidth)) * font * 1.25;
      },
    };
    return el;
  }
  function pane() {
    return { scrollTop: 0, scrollLeft: 0, clientHeight: 800, clientWidth: 640, scrollWidth: 640,
      getBoundingClientRect: () => ({ top: 0, bottom: 800 }), addEventListener() {} };
  }
  const left = pane(), right = pane(), pages = {};
  for (let p = 1; p <= count; p++) {
    const wrap = element('div');
    wrap.getBoundingClientRect = () => ({ top: (p - 1) * 814 - left.scrollTop,
      bottom: p * 814 - 14 - left.scrollTop, height: 800 });
    const canvas = element('canvas');
    pages[p] = { wrap, canvas, baseCanvas: canvas, w1: 600, h1: 800, rasterRevision: 0,
      page: { getViewport: () => ({ convertToViewportPoint: (x, y) => [x, 800 - y] }) } };
  }
  const context = { module: { exports: {} }, Intl, document: { createElement: element, body: element('body') },
    window: { getSelection: () => null, innerWidth: 1200, innerHeight: 800 }, ResizeObserver: class { observe() {} },
    setTimeout: cb => { timers.set(++timerId, cb); return timerId; }, clearTimeout: id => timers.delete(id),
    requestAnimationFrame: cb => { frames.set(++frameId, cb); return frameId; },
    cancelAnimationFrame: id => frames.delete(id),
  };
  vm.runInNewContext(code, context);
  const reader = new context.module.exports.Reader({ pane: right, inner: element('div'),
    sourcePane: left, sourcePages: () => pages, onLocate: index => located.push(index), onZoom() {},
    onEdit: (index, text) => edits.push({ index, text }) });
  const paragraphs = Array.from({ length: count }, (_, i) => ({ page: i + 1, text: 'Source paragraph',
    rect: { x0: 40, y0: 600, x1: 250, y1: 700 }, fontSize: 10 }));
  reader.setDocument(pages, paragraphs);
  for (const [number, pg] of Object.entries(reader.pages)) {
    pg.wrap.getBoundingClientRect = () => ({ top: (number - 1) * 814 - right.scrollTop,
      bottom: number * 814 - 14 - right.scrollTop, height: 800 });
  }
  return { reader, pages, paragraphs, left, right, frames, element, timers, edits, located,
    draws: () => drawCount, flush() { const pending = Array.from(frames.values()); frames.clear(); pending.forEach(cb => cb()); } };
}

test('100-page document only allocates nearby right-hand canvases and releases distant ones', () => {
  const f = fixture(100);
  assert.equal(f.draws(), 0);
  f.reader.setEnabled(true); f.flush();
  assert.equal(f.draws(), 2);
  const first = f.reader.pages[1].canvas;
  f.right.scrollTop = 814 * 50;
  f.reader.onScroll(f.right); f.flush();
  assert.equal(first.width, 0);
  assert.equal(first.height, 0);
  assert.equal(f.reader.pages[1].canvas, null);
  assert.ok(Object.values(f.reader.pages).filter(pg => pg.canvas).length <= 3);
  assert.equal(f.left.scrollTop, f.right.scrollTop);
});

test('successful results mask only their block; errors retain original PDF and text is never HTML', () => {
  const f = fixture();
  f.reader.setEnabled(true);
  f.reader.updateTranslation(0, '<img src=x onerror=alert(1)> 翻譯', false, 'zh-Hant'); f.flush();
  const block = f.reader.blocks.get(0).records[0];
  assert.equal(block.node.textContent, '<img src=x onerror=alert(1)> 翻譯');
  assert.equal(block.node.lang, 'zh-Hant');
  assert.equal(f.reader.blocks.get(1).records[0].node, null);
  f.reader.updateTranslation(0, 'Failure', true, 'zh-Hant'); f.flush();
  assert.equal(block.node, null);
});

test('turning layout off frees bitmaps but retains translations for reopening', () => {
  const f = fixture();
  f.reader.updateTranslation(0, '保留這段翻譯', false, 'zh-Hant');
  f.reader.setEnabled(true); f.flush();
  const canvas = f.reader.pages[1].canvas;
  f.reader.setEnabled(false);
  assert.equal(canvas.width, 0);
  assert.equal(f.reader.pages[1].canvas, null);
  f.reader.setEnabled(true); f.flush();
  assert.equal(f.reader.blocks.get(0).records[0].node.textContent, '保留這段翻譯');
});

test('new language/retranslation removes all old masks including offscreen pages', () => {
  const f = fixture();
  f.reader.updateTranslation(0, '舊語言', false, 'zh-Hant');
  f.reader.updateTranslation(5, '舊語言', false, 'zh-Hant');
  f.reader.setEnabled(true); f.flush();
  f.reader.clearTranslations(); f.flush();
  assert.equal(f.reader.blocks.get(0).records[0].node, null);
  f.right.scrollTop = 814 * 5; f.reader.onScroll(f.right); f.flush();
  assert.equal(f.reader.blocks.get(5).records[0].node, null);
  assert.equal(f.reader.translations.size, 0);
});

test('zoom and sharper source canvas refresh do not run translation or modify original pixels', () => {
  const f = fixture();
  f.reader.setEnabled(true); f.flush();
  const original = f.pages[1].canvas;
  f.reader.setScale(2); f.flush();
  assert.equal(f.reader.pages[1].wrap.style.width, '1200px');
  assert.equal(f.reader.pages[1].layer.style.transform, 'scale(2)');
  assert.equal(original.width, 600);
  assert.equal(f.draws(), 2);
  f.pages[1].rasterRevision++;
  f.reader.refreshPage(1); f.flush();
  assert.equal(f.draws(), 3);
  assert.equal(f.pages[1].canvas, original);
});

test('sync scroll feedback does not bounce back and forth between panes', () => {
  const f = fixture();
  f.reader.setEnabled(true); f.flush();
  f.left.scrollTop = 925;
  f.reader.onScroll(f.left);
  assert.equal(f.right.scrollTop, 925);
  const before = f.left.scrollTop;
  f.reader.onScroll(f.right);
  assert.equal(f.left.scrollTop, before);
  assert.equal(f.reader.expectedScroll.has(f.left), false);
});

test('excess translation stays scrollable inside its bounds at the minimum font size', () => {
  const f = fixture();
  f.reader.setEnabled(true);
  f.reader.updateTranslation(0, '很長的譯文'.repeat(1000), false, 'zh-Hant'); f.flush();
  const node = f.reader.blocks.get(0).records[0].node;
  assert.equal(node.textContent.length, 5000);
  assert.equal(parseFloat(node.style.fontSize), 6.5);
  assert.equal(node.classList.contains('is-overflowing'), true);
  assert.ok(parseFloat(node.style.height) < 110);
});

test('double-click edits without the locate click scrolling the block away', () => {
  const f = fixture();
  f.reader.setEnabled(true);
  f.reader.updateTranslation(0, '原本譯文', false, 'zh-Hant'); f.flush();
  const block = f.reader.blocks.get(0).records[0];
  block.node.fire('click');
  assert.equal(f.timers.size, 1);
  block.node.fire('click', { detail: 2 });
  block.node.fire('dblclick');
  assert.equal(f.timers.size, 0);
  assert.equal(f.located.length, 0);
  assert.equal(f.reader.editing.field, block.node, 'the existing translated block must be the editor');
  assert.equal(block.node.contentEditable, 'plaintext-only');
  f.reader.editing.field.innerText = '手動修正\n保留換行與 <文字>';
  f.reader.editing.field.fire('blur'); f.flush();
  assert.equal(block.node.textContent, '手動修正\n保留換行與 <文字>');
  assert.equal(f.reader.editing, null);
  assert.equal(block.node.contentEditable, 'false');
  assert.deepEqual(f.edits, [{ index: 0, text: '手動修正\n保留換行與 <文字>' }]);
  f.reader.setEnabled(false); f.reader.setEnabled(true); f.flush();
  assert.equal(block.node.textContent, '手動修正\n保留換行與 <文字>');
});

test('Escape keeps the original result; losing focus saves exactly once', () => {
  const f = fixture();
  f.reader.setEnabled(true); f.reader.updateTranslation(0, '原本譯文', false, 'zh-Hant'); f.flush();
  const block = f.reader.blocks.get(0).records[0];
  f.reader.editBlock(block);
  f.reader.editing.field.innerText = '不要儲存';
  f.reader.editing.field.fire('keydown', { key: 'Escape' }); f.flush();
  assert.equal(block.node.textContent, '原本譯文');
  assert.equal(f.edits.length, 0);
  f.reader.editBlock(block);
  const field = f.reader.editing.field;
  field.innerText = '點外面儲存';
  field.fire('blur'); field.fire('blur'); f.flush();
  assert.equal(block.node.textContent, '點外面儲存');
  assert.equal(f.edits.length, 1);
});

test('editing one cross-page piece preserves the other piece and its joining whitespace', () => {
  const f = fixture(2);
  const para = { ...f.paragraphs[0], parts: f.paragraphs.map(p => ({ page: p.page, rect: p.rect, text: p.text, fontSize: 10 })) };
  f.reader.setDocument(f.pages, [para]);
  f.reader.setEnabled(true);
  f.reader.updateTranslation(0, 'First sentence here. Second sentence here.', false, 'en'); f.flush();
  const original = f.reader.translations.get(0).pieces.slice();
  const block = f.reader.blocks.get(0).records[0];
  f.reader.editBlock(block); f.reader.editing.field.innerText = 'Corrected first.';
  f.reader.editing.field.fire('blur'); f.flush();
  const result = f.reader.translations.get(0);
  assert.equal(result.pieces[1], original[1]);
  assert.equal(result.text, result.pieces.join(''));
  assert.ok(/\s$/.test(result.pieces[0]) || /^\s/.test(result.pieces[1]));
  assert.equal(f.edits[0].text, result.text);
});

test('switching mode saves an open edit, while retranslation cancels stale drafts', () => {
  const f = fixture();
  f.reader.setEnabled(true); f.reader.updateTranslation(0, '原本譯文', false, 'zh-Hant'); f.flush();
  const block = f.reader.blocks.get(0).records[0];
  f.reader.editBlock(block); f.reader.editing.field.innerText = '切換時保留';
  f.reader.setEnabled(false);
  assert.equal(f.reader.translations.get(0).text, '切換時保留');
  assert.equal(f.reader.editing, null);
  f.reader.setEnabled(true); f.flush();
  f.reader.editBlock(block); f.reader.editing.field.innerText = '過期的修改';
  f.reader.updateTranslation(0, '新語言結果', false, 'ja'); f.flush();
  assert.equal(f.reader.editing, null);
  assert.equal(block.node.textContent, '新語言結果');
  assert.equal(f.edits.length, 1);
  f.reader.editBlock(block); f.reader.clearTranslations(); f.flush();
  assert.equal(f.reader.editing, null);
  assert.equal(f.reader.translations.size, 0);
});

test('zoom/refitting does not overwrite an inline draft and virtualization saves it before removal', () => {
  const f = fixture(100);
  f.reader.setEnabled(true); f.reader.updateTranslation(0, '原本譯文', false, 'zh-Hant'); f.flush();
  const block = f.reader.blocks.get(0).records[0];
  f.reader.editBlock(block);
  block.node.innerText = '尚未失焦的手動修改';
  f.reader.setFontRatio(1.2); f.reader.setScale(2); f.flush();
  assert.equal(block.node.innerText, '尚未失焦的手動修改');
  assert.equal(f.reader.editing.field, block.node);
  block.node.fire('keydown', { key: 'Enter' });
  assert.ok(f.reader.editing, 'plain Enter must allow a newline instead of locating the PDF');
  assert.equal(f.located.length, 0);
  f.right.scrollTop = 814 * 50; f.reader.onScroll(f.right); f.flush();
  assert.equal(f.reader.editing, null);
  assert.equal(f.reader.translations.get(0).text, '尚未失焦的手動修改');
  assert.equal(block.node, null);
});
