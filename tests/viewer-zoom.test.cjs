'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'viewer.js'), 'utf8');
const zoomCode = source.slice(source.indexOf('let rerenderT = null;'), source.indexOf('// Arrow keys / PageUp-Down'));
function fixture(count = 5) {
  const frames = [], timers = new Map(), events = {}, rendered = [], scratch = [];
  let timerId = 0, scrollTop = 0, scrollLeft = 0;
  const rect = { top: 0, left: 0, bottom: 800, right: 600 };
  const pane = { clientHeight: 800, clientWidth: 600, getBoundingClientRect: () => rect,
    addEventListener: (type, cb) => { events[type] = cb; },
    get scrollTop() { return scrollTop; }, set scrollTop(v) { scrollTop = v; },
    get scrollLeft() { return scrollLeft; }, set scrollLeft(v) { scrollLeft = v; } };
  function canvas(width = 600, height = 800) {
    return { width, height, style: {}, getContext: () => ({}), replaceWith(next) { this.replacedBy = next; } };
  }
  const pages = {};
  for (let i = 1; i <= count; i++) {
    const baseCanvas = canvas();
    const pg = { w1: 600, h1: 800, textScale: 1, canvas: baseCanvas, baseCanvas,
      textLayer: { style: { setProperty() { throw new Error('Text spans must not be reflowed'); } } },
      wrap: { style: {}, querySelectorAll: () => [], getBoundingClientRect: () => {
        const scale = parseFloat(pg.wrap.style.width || '600') / 600;
        const top = (i - 1) * (800 * scale + 14) - scrollTop;
        return { top, bottom: top + 800 * scale, height: 800 * scale,
          left: -scrollLeft, width: 600 * scale, right: 600 * scale - scrollLeft };
      } },
      page: { getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale, scale }),
        render() { rendered.push(i); return { promise: Promise.resolve(), cancel() {} }; } },
    };
    pg.viewport = pg.page.getViewport({ scale: 1 });
    pages[i] = pg;
  }
  const ctx = { pdfDoc: { numPages: count }, pageWraps: pages, zoom: 1, baseScale: 1, renderScale: 1,
    window: { devicePixelRatio: 1 }, console,
    requestAnimationFrame: cb => { frames.push(cb); return frames.length; },
    setTimeout: cb => { timers.set(++timerId, cb); return timerId; }, clearTimeout: id => timers.delete(id),
    document: { createElement: () => { const c = canvas(0, 0); scratch.push(c); return c; } },
    positionPdfHighlight() {},
    els: { pdfPane: pane, zoomLabel: {}, zoomIn: { addEventListener() {} },
      zoomOut: { addEventListener() {} }, zoomFit: { addEventListener() {} } },
  };
  vm.createContext(ctx);
  vm.runInContext(zoomCode, ctx);
  ctx.setupZoom();
  return { ctx, pages, frames, timers, events, rendered, scratch,
    frame() { frames.shift()(); } };
}

test('many wheel events share one frame and use their actual magnitude', () => {
  const f = fixture();
  for (let i = 0; i < 20; i++) f.events.wheel({ ctrlKey: true, deltaY: -1, deltaMode: 0, clientX: 150, clientY: 200, preventDefault() {} });
  assert.equal(f.frames.length, 1);
  assert.ok(Math.abs(f.ctx.zoom - Math.exp(0.04)) < 1e-10);
  assert.equal(f.pages[1].wrap.style.width, undefined);
  f.frame();
  assert.equal(f.pages[1].textLayer.style.transform, 'scale(' + f.ctx.zoom + ')');
  assert.equal(f.pages[1].viewport.scale, f.ctx.zoom);
});

test('a zoom preserves the point under the cursor on both axes', () => {
  const f = fixture();
  f.ctx.setZoom(2, 200, 150);
  f.frame();
  const r = f.pages[1].wrap.getBoundingClientRect();
  assert.equal(r.top + r.height * 0.25, 200);
  assert.equal(r.left + r.width * 0.25, 150);
});

test('zero wheel delta and ordinary scrolling do not zoom', () => {
  const f = fixture();
  f.events.wheel({ ctrlKey: true, deltaY: 0, preventDefault() {} });
  f.events.wheel({ ctrlKey: false, deltaY: 50 });
  assert.equal(f.ctx.zoom, 1);
  assert.equal(f.frames.length, 0);
});

test('zoom at a scale boundary does no extra layout work', () => {
  const f = fixture();
  f.ctx.setZoom(4); f.frame();
  f.ctx.setZoom(9);
  assert.equal(f.frames.length, 0);
});

test('only visible or nearby pages are sharpened in a long PDF', async () => {
  const f = fixture(100);
  f.ctx.renderScale = 2;
  f.ctx.applyDisplayScale(2);
  await f.ctx.sharpenPages();
  assert.deepEqual(f.rendered, [1]);
  assert.equal(f.pages[100].canvas, f.pages[100].baseCanvas);
});

test('new zoom cancels old render immediately and cannot swap in stale pixels', async () => {
  const f = fixture();
  let finish, cancelled = 0;
  const oldCanvas = f.pages[1].canvas;
  f.pages[1].page.render = () => ({ promise: new Promise(resolve => { finish = resolve; }), cancel() { cancelled++; } });
  f.ctx.renderScale = 2;
  const pending = f.ctx.sharpenPages();
  assert.equal(f.pages[1].canvas, oldCanvas);
  assert.equal(oldCanvas.width, 600);
  f.ctx.setZoom(3);
  assert.equal(cancelled, 1);
  finish();
  await pending;
  assert.equal(f.pages[1].canvas, oldCanvas);
  assert.equal(f.scratch[0].width, 0);
});

test('completed offscreen rendering swaps a complete canvas without clearing the live one', async () => {
  const f = fixture();
  let finish;
  const oldCanvas = f.pages[1].canvas;
  f.pages[1].page.render = () => ({ promise: new Promise(resolve => { finish = resolve; }), cancel() {} });
  f.ctx.renderScale = 2;
  const pending = f.ctx.sharpenPages();
  assert.equal(oldCanvas.width, 600);
  assert.equal(oldCanvas.replacedBy, undefined);
  finish(); await pending;
  assert.equal(f.pages[1].canvas.width, 1200);
  assert.equal(f.pages[1].baseCanvas, oldCanvas);
});

test('leaving a zoomed page releases its large bitmap but retains a preview', async () => {
  const f = fixture();
  f.ctx.renderScale = 2;
  f.ctx.applyDisplayScale(2);
  await f.ctx.sharpenPages();
  const sharp = f.pages[1].canvas;
  f.ctx.els.pdfPane.scrollTop = 3300;
  await f.ctx.sharpenPages();
  assert.equal(f.pages[1].canvas, f.pages[1].baseCanvas);
  assert.equal(sharp.width, 0);
  assert.equal(sharp.height, 0);
});

test('HiDPI high zoom respects the canvas pixel budget', () => {
  const f = fixture();
  f.ctx.window.devicePixelRatio = 4;
  const vp = f.ctx.getRasterViewport(f.pages[1].page, 10);
  assert.ok(vp.width * vp.height <= 8 * 1024 * 1024 + 1);
  assert.ok(Math.max(vp.width, vp.height) <= 8192);
});

test('zooming back out reuses the original preview instead of rendering again', async () => {
  const f = fixture();
  f.ctx.renderScale = 2; f.ctx.applyDisplayScale(2);
  await f.ctx.sharpenPages();
  f.rendered.length = 0;
  f.ctx.renderScale = 0.8; f.ctx.applyDisplayScale(0.8);
  await f.ctx.sharpenPages();
  assert.equal(f.rendered.length, 0);
  assert.equal(f.pages[1].canvas, f.pages[1].baseCanvas);
});

test('render cancellation is handled without replacing the live page', async () => {
  const f = fixture();
  const original = f.pages[1].canvas;
  f.pages[1].page.render = () => ({ promise: Promise.reject(Object.assign(new Error('cancelled'), { name: 'RenderingCancelledException' })), cancel() {} });
  f.ctx.renderScale = 2;
  await f.ctx.sharpenPages();
  assert.equal(f.pages[1].canvas, original);
  assert.equal(f.scratch[0].width, 0);
});
