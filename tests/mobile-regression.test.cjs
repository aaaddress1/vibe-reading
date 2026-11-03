'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
function event() {
  const listeners = [];
  return { addListener(fn) { listeners.push(fn); }, fire(...args) { return Promise.all(listeners.map(fn => fn(...args))); } };
}
function worker(overrides = {}) {
  const calls = { tabs: [], messages: [], scripts: [] };
  const chrome = {
    runtime: { getURL: name => 'chrome-extension://test/' + name,
      onInstalled: event(), onStartup: event(), onMessage: event(), onConnect: event() },
    action: { onClicked: event() }, contextMenus: {}, commands: {},
    storage: { local: { get: async () => ({}) } },
    tabs: { create: async tab => calls.tabs.push(tab), query: async () => [{ id: 7, url: 'https://example.com/article' }],
      sendMessage: async (id, message) => { calls.messages.push({ id, message }); return { handled: true }; } },
    scripting: { executeScript: async data => { calls.scripts.push(data); return [{ result: null }]; }, insertCSS: async () => {} },
  };
  const localMT = { planFor: () => ({ steps: [] }), isDownloaded: async () => true,
    downloadSizeMB: () => 117, prepare: async () => {}, translate: async () => '譯文', ...overrides };
  const ctx = { chrome, localMT, console, URL, AbortSignal, setInterval: () => 1, clearInterval() {},
    fetch: async () => ({ ok: false, headers: { get: () => null } }) };
  vm.createContext(ctx);
  vm.runInContext(read('pdf-source.js').replaceAll('export function', 'function') + '\n' +
    read('tab-actions.js').replace(/^import .+;\r?\n/gm, '').replaceAll('export async function', 'async function') + '\n' +
    read('background.js').replace(/^import .+;\r?\n/gm, ''), ctx);
  return { ctx, chrome, calls };
}

test('Android with missing or partial desktop APIs still registers toolbar and translation ports', async () => {
  const f = worker();
  await f.chrome.runtime.onInstalled.fire({ reason: 'update' });
  await f.chrome.action.onClicked.fire();
  assert.equal(f.calls.messages.length, 1);
  assert.equal(f.calls.messages[0].id, 7);
});

test('PDF routes preserve query/hash and unwrap native Edge/Chrome preview URLs', async () => {
  const { ctx, calls } = worker();
  const urls = ['https://example.com/a.PDF?token=a%2Fb#page=2', 'https://arxiv.org/pdf/2610.22603',
    'file:///storage/emulated/0/Download/paper.pdf', 'content://com.android.providers.downloads.documents/document/47'];
  for (const url of urls) {
    await ctx.handleTrigger({ id: 4, url });
    assert.equal(new URL(calls.tabs.at(-1).url).searchParams.get('file'), url);
  }
  await ctx.handleTrigger({ id: 4, url: 'edge://pdf/index.html?src=' + encodeURIComponent(urls[0]) });
  assert.equal(new URL(calls.tabs.at(-1).url).searchParams.get('file'), urls[0]);
  await ctx.handleTrigger({ id: 4, url: 'chrome-native://pdf/link?url=' + encodeURIComponent(urls[0]) });
  assert.equal(new URL(calls.tabs.at(-1).url).searchParams.get('file'), urls[0]);
  assert.equal(ctx.pdfSourceFromUrl('https://example.com/?url=https://other.test/a.pdf'), null);
  assert.equal(ctx.pdfSourceFromUrl('edge://pdf/?file=javascript%3Aalert(1)'), null);
});

test('extensionless PDFs are detected by document MIME and routed without toggling web translation', async () => {
  const f = worker();
  f.chrome.scripting.executeScript = async () => [{ result: 'https://example.com/download?id=5' }];
  await f.ctx.handleTrigger({ id: 1, url: 'https://example.com/download?id=5' });
  assert.equal(new URL(f.calls.tabs[0].url).searchParams.get('file'), 'https://example.com/download?id=5');
  assert.equal(f.calls.messages.length, 0);
});

test('acknowledged website trigger is delivered exactly once; missing listener is reinjected', async () => {
  const f = worker();
  await f.ctx.handleTrigger({ id: 0, url: 'https://example.com/article' });
  assert.equal(f.calls.messages.length, 1);
  assert.equal(f.calls.tabs.length, 0);
  let messages = 0;
  f.chrome.tabs.sendMessage = async () => { if (++messages === 1) throw new Error('No receiver'); return { handled: true }; };
  await f.ctx.handleTrigger({ id: 5, url: 'https://example.com/article' });
  assert.equal(messages, 2);
  assert.ok(f.calls.scripts.some(s => s.files?.includes('content.js')));
  assert.equal(f.calls.tabs.length, 0);
});

test('native viewer that forbids injection uses PDF response headers, preserving signed source URL', async () => {
  const f = worker();
  f.chrome.scripting.executeScript = async () => { throw new Error('Native viewer'); };
  f.chrome.tabs.sendMessage = async () => { throw new Error('No receiver'); };
  f.ctx.fetch = async (url, options) => { assert.equal(options.method, 'HEAD'); return { ok: true, headers: { get: () => 'application/pdf' } }; };
  await f.ctx.handleTrigger({ id: 8, url: 'https://example.com/get?signature=123' });
  assert.equal(new URL(f.calls.tabs[0].url).searchParams.get('file'), 'https://example.com/get?signature=123');
});

test('a page open before the update is toggled once even if its old listener returns no response', async () => {
  const f = worker(); let toggles = 0;
  f.chrome.tabs.sendMessage = async () => { toggles++; };
  await f.ctx.handleTrigger({ id: 1, url: 'https://example.com/article' });
  assert.equal(toggles, 1);
  assert.equal(f.calls.tabs.length, 0);
});

test('engine status responds while another tab is preparing weights', async () => {
  let release;
  const f = worker({ prepare: () => new Promise(resolve => { release = resolve; }) });
  const replies = [];
  const port = { name: 'vibe-mt', onDisconnect: event(), onMessage: event(), postMessage: m => replies.push(m) };
  await f.chrome.runtime.onConnect.fire(port);
  await port.onMessage.fire({ id: 1, op: 'prepare', src: 'en', tgt: 'zh-Hant' });
  await port.onMessage.fire({ id: 2, op: 'status', src: 'en', tgt: 'zh-Hant' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(replies[0].id, 2);
  assert.equal(replies[0].result.supported, true);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(replies.some(r => r.id === 1 && r.result));
});

test('disconnect during reply cannot poison the shared model queue', async () => {
  const f = worker();
  const dead = { name: 'vibe-mt', onDisconnect: event(), onMessage: event(), postMessage() { throw new Error('Disconnected'); } };
  await f.chrome.runtime.onConnect.fire(dead);
  await dead.onMessage.fire({ id: 1, op: 'translate' });
  const replies = [];
  const live = { ...dead, onMessage: event(), postMessage: m => replies.push(m) };
  await f.chrome.runtime.onConnect.fire(live);
  await live.onMessage.fire({ id: 2, op: 'translate' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(replies[0].result, '譯文');
});

function engine(extra = {}) {
  const timers = new Map(); let timerId = 0;
  const port = { onMessage: event(), onDisconnect: event(), postMessage() {} };
  const ctx = { console, navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14) EdgA/148.0.0.0', language: 'zh-TW' },
    chrome: { runtime: { connect: () => port }, storage: { local: { get: async () => ({}) } } },
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; }, clearTimeout: id => timers.delete(id), ...extra };
  ctx.window = ctx.self = ctx;
  vm.createContext(ctx); vm.runInContext(read('translate-core.js'), ctx);
  return { ctx, port, timers, VT: ctx.VibeTranslate };
}

test('Android Edge branding and local defaults do not depend on desktop AI', () => {
  const { VT } = engine();
  assert.equal(VT.BROWSER.name, 'Edge'); assert.equal(VT.BROWSER.isAndroid, true);
  assert.equal(VT.browserDefaultTarget(), 'zh-Hant');
});

test('unresponsive local status times out instead of hanging forever, and late replies are ignored', async () => {
  const { VT, timers, port } = engine();
  const pending = VT.localStatus('en', 'zh-Hant');
  const timer = [...timers.values()].find(t => t.ms === 10000);
  assert.ok(timer); timer.fn();
  assert.equal((await pending).supported, false);
  await port.onMessage.fire({ id: 1, result: { supported: true } });
});

test('broken Prompt API falls back to the real local-engine protocol', async () => {
  const f = engine({ LanguageModel: { availability: async () => { throw new Error('Not supported on Android'); } } });
  f.port.postMessage = msg => queueMicrotask(() => f.port.onMessage.fire({ id: msg.id,
    result: msg.op === 'status' ? { supported: true, downloaded: true } : true }));
  const trans = await f.VT.initTranslator('en', 'zh-Hant', { isManual: true });
  assert.equal(trans.type, 'local');
  assert.equal(f.timers.size, 0);
});

test('reinjecting shared engine keeps pending jobs and one connection', () => {
  const f = engine();
  vm.runInContext(read('translate-core.js'), f.ctx);
  assert.equal(f.ctx.VibeTranslate, f.VT);
});

test('misclassified selectable PDF text falls back to geometric paragraphs instead of reporting a scan', () => {
  const source = read('viewer.js'), ctx = {};
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('const LAYOUT_TEXT ='), source.indexOf('// ─── Translation engine')), ctx);
  const items = [{ str: 'The research studies machine translation.', transform: [14, 0, 0, 14, 50, 700], width: 270, height: 14 }];
  const wrongLayout = [{ label: 'header', score: 0.99, x0: 0, y0: 600, x1: 600, y1: 800 }];
  const result = ctx.extractParagraphs(items, wrongLayout);
  assert.equal(result[0].text, items[0].str);
  assert.equal(ctx.extractParagraphs([], wrongLayout).length, 0);
});

test('narrow PDF analysis uses its own bounded raster and releases it after detection', async () => {
  const source = read('viewer.js'), renders = [], detected = [], scratch = [];
  const viewport = scale => ({ width: 600 * scale, height: 800 * scale,
    convertToPdfPoint: (x, y) => [x / scale, y / scale] });
  const ctx = { console, setStatus() {}, pdfDoc: { getPage: async () => ({ getViewport: ({ scale }) => viewport(scale),
    render: args => { renders.push(args.viewport); return { promise: Promise.resolve() }; } }) },
    document: { createElement: () => { const c = { getContext: () => ({}) }; scratch.push(c); return c; } },
    window: { VibeLayout: { detect: async canvas => { detected.push([canvas.width, canvas.height]); return [{ label: 'text', score: 1, x0: 60, y0: 72, x1: 120, y1: 144 }]; } } } };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('let layoutDisabled ='), source.indexOf('// ─── Zoom (')), ctx);
  for (const width of [120, 300]) {
    const result = await ctx.detectLayout({ width, height: width * 4 / 3 }, viewport(width / 600), 1, 2);
    assert.equal(result[0].x0, 50);
    assert.equal(result[0].y0, 60);
  }
  assert.deepEqual(detected, [[720, 960], [720, 960]]);
  assert.equal(renders.length, 2);
  assert.ok(scratch.every(c => c.width === 0 && c.height === 0));
});

test('a normal article that embeds a PDF remains a website translation target', () => {
  const { ctx } = worker();
  ctx.document = { contentType: 'text/html', querySelector: () => ({}) };
  ctx.location = { href: 'https://example.com/article' };
  assert.equal(ctx.inspectPdfDocument(), null);
});
