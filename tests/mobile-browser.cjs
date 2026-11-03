// Real extension, PDF.js, ONNX Runtime and Opus-MT. Mobile viewport/touch and
// Android API fault simulation are NOT a substitute for Edge Android hardware.
// Run: PLAYWRIGHT_MODULE=<module> CHROMIUM_EXECUTABLE=<Chrome for Testing> node tests/mobile-browser.cjs
// First run downloads the pinned en-zh model (~117 MB). No cloud translation.
'use strict';
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
const extension = path.resolve(process.env.VIBE_EXTENSION_DIR || root);
const output = path.join(root, 'tmp', 'mobile-validation');
fs.mkdirSync(output, { recursive: true });

// A self-contained two-page PDF fixture, with real selectable text.
function samplePdf() {
  const stream = 'BT /F1 14 Tf 50 730 Td (The research studies machine translation.) Tj 0 -28 Td (This document contains text and figures.) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(pdf);
}
const pdf = samplePdf();
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/document') || req.url.startsWith('/download')) {
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length }); res.end(pdf);
  } else if (req.url === '/broken.pdf') {
    res.writeHead(404); res.end('Not found');
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Translation fixture</title><h1>Research</h1><p>The research studies machine translation.</p><p>This document contains text and figures.</p>');
  }
});
const results = [];
function pass(name, detail) { results.push({ name, passed: true, detail }); console.log('PASS:', name, detail || ''); }
let context;
const browserLog = [];
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  context = await chromium.launchPersistentContext(path.join(output, 'profile'), {
    executablePath: process.env.CHROMIUM_EXECUTABLE, headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width: 393, height: 851 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36 EdgA/148.0.0.0',
  });
  context.setDefaultTimeout(20000);
  await context.addInitScript(() => {
    // Android currently has no desktop Translator/Prompt API. Keep all local
    // translation code, runtime messaging and WASM execution untouched.
    for (const key of ['Translator', 'LanguageModel', 'LanguageDetector']) delete globalThis[key];
  });
  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const ext = sw.url().replace('background.js', '');
  const controller = await context.newPage();
  await controller.goto(ext + 'options.html');
  async function trigger(tabId) {
    await controller.evaluate(async id => {
      const { handleTrigger } = await import('./tab-actions.js');
      await handleTrigger(await chrome.tabs.get(id));
    }, tabId);
  }
  await sw.evaluate(() => chrome.storage.local.set({ targetLang: 'zh-Hant', engine: 'local', firstRunSetupDone: true, pdfReadingMode: 'paragraphs' }));
  const errors = [];
  function watch(page) {
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (['error', 'warning'].includes(m.type())) browserLog.push(m.text()); });
    return page;
  }
  async function viewer(suffix = '') {
    const page = watch(await context.newPage());
    await page.goto(ext + 'viewer.html' + suffix);
    return page;
  }
  const page = await viewer();
  await page.locator('.open-pdf-btn').waitFor();
  assert.equal(await page.evaluate(() => VibeTranslate.BROWSER.name), 'Edge');
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('.open-pdf-btn').tap();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name: 'mobile-local.pdf', mimeType: 'application/pdf', buffer: pdf });
  await page.waitForFunction(() => document.querySelectorAll('#pdfInner .page-wrap').length === 2 && !document.querySelector('#translateBtn').disabled);
  pass('touch file picker loads a real two-page local PDF');

  await page.waitForFunction(() => document.querySelector('#stopBtn').style.display === 'none');
  await page.locator('#translateBtn').tap();
  // Report progress without hiding the actual first-download cost.
  const progress = setInterval(async () => {
    console.log('MODEL:', await page.locator('#statusText').textContent().catch(() => 'closed'));
  }, 15000);
  try {
    await page.waitForFunction(() => [...document.querySelectorAll('.seg-trans')].some(n => /[\u4e00-\u9fff]/.test(n.textContent) && !n.classList.contains('loading')) && document.querySelector('#stopBtn').style.display === 'none', null, { timeout: 300000 });
  } finally { clearInterval(progress); }
  const translated = await page.locator('.seg-trans').allTextContents();
  assert.ok(translated.length > 0 && translated.every(t => !t.includes('翻譯失敗')));
  pass('real Opus-MT model downloads/loads and translates local PDF into Chinese', translated);
  const paragraphModeText = await page.evaluate(() => paragraphs.map(p => p.text));

  await page.locator('#pdfLayoutBtn').tap();
  await page.waitForFunction(() => document.querySelectorAll('.pdf-trans-block').length > 0);
  assert.ok(await page.locator('#translatedPdfPane').isVisible());
  await page.locator('#zoomIn').tap();
  await page.waitForFunction(() => document.querySelector('#zoomLabel').textContent === '120%');
  await page.screenshot({ path: path.join(output, 'pdf-layout-mobile.png') });
  await page.locator('#pdfLayoutBtn').tap();
  await page.locator('#targetLang').selectOption('zh-Hans');
  await page.locator('#translateBtn').tap();
  await page.waitForFunction(() => document.querySelector('#stopBtn').style.display === 'none' && document.querySelectorAll('.seg-trans:not(.loading)').length > 0);
  assert.ok((await page.locator('.seg-trans').allTextContents()).every(t => !t.includes('翻譯失敗')));
  pass('mobile PDF layout, zoom, paragraph mode and language switch');
  await page.evaluate(() => {
    const text = document.querySelector('#pdfInner .textLayer span');
    const range = document.createRange(); range.selectNodeContents(text);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  await page.locator('#askFloatTrans').waitFor({ state: 'visible' });
  await page.locator('#askFloatTrans').tap();
  await page.waitForFunction(() => /[\u4e00-\u9fff]/.test(document.querySelector('#askAnswer').textContent) && !document.querySelector('#askAnswer').textContent.includes('翻譯中'));
  assert.ok(!(await page.locator('#askAnswer').textContent()).includes('失敗'));
  pass('PDF touch selectionchange opens selection translation without mouseup');
  await page.locator('#askClose').tap();
  await page.locator('#settingsBtn').tap();
  assert.equal(await page.locator('#welcomeOpenShortcuts').isVisible(), false);
  assert.equal(await page.locator('#welcomeOpenExt').isVisible(), false);
  await page.locator('#welcomeClose').tap();
  pass('Android settings do not require desktop file permissions or shortcuts');
  await page.close();

  const remote = await viewer('?file=' + encodeURIComponent(base + '/document.pdf?token=abc'));
  await remote.waitForFunction(() => document.querySelectorAll('.seg-trans:not(.loading)').length > 0 && document.querySelector('#stopBtn').style.display === 'none');
  pass('remote PDF opens and auto-translates using downloaded model');
  await remote.close();

  const provider = await viewer('?file=' + encodeURIComponent('content://com.android.providers.downloads.documents/document/123'));
  await provider.waitForFunction(() => document.querySelector('#statusText').textContent.includes('Android'));
  assert.ok(await provider.locator('.open-pdf-btn').isVisible());
  pass('Android content URI presents an authorized system file-picker path');
  await provider.close();

  const broken = await viewer('?file=' + encodeURIComponent(base + '/broken.pdf'));
  await broken.waitForFunction(() => document.querySelector('#errorBox').textContent.includes('404'));
  const badFile = { name: 'retry.pdf', mimeType: 'application/pdf', buffer: Buffer.from('not a PDF') };
  await broken.locator('#fileInput').setInputFiles(badFile);
  await broken.waitForFunction(() => document.querySelector('#errorBox').textContent.includes('Invalid PDF'));
  await broken.locator('#fileInput').setInputFiles({ ...badFile, buffer: pdf });
  await broken.waitForFunction(() => document.querySelectorAll('.seg-trans:not(.loading)').length > 0);
  pass('HTTP error / invalid PDF recover with same-name local file import');
  await broken.close();

  const web = watch(await context.newPage());
  await web.goto(base + '/article');
  await web.locator('.vibe-ball').tap();
  await web.waitForFunction(() => [...document.querySelectorAll('.vibe-inline-translation')].filter(n => !n.classList.contains('vibe-loading') && !n.classList.contains('vibe-error')).length >= 3, null, { timeout: 60000 });
  const webText = await web.locator('.vibe-inline-translation').allTextContents();
  assert.ok(webText.some(t => /[\u4e00-\u9fff]/.test(t)));
  await web.screenshot({ path: path.join(output, 'web-mobile.png') });
  // Use the exact toolbar command handler with a real tab and scripting API.
  const tabId = await sw.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url).id, web.url());
  await trigger(tabId);
  await web.waitForFunction(() => document.querySelectorAll('.vibe-inline-translation').length === 0);
  await trigger(tabId);
  await web.waitForFunction(() => document.querySelectorAll('.vibe-inline-translation:not(.vibe-loading)').length >= 3);
  pass('website touch translation, toolbar routing, toggle off/on', webText);
  await trigger(tabId); // back to source before starting a deliberately delayed job
  await controller.evaluate(async id => {
    await chrome.scripting.executeScript({ target: { tabId: id }, func: () => {
      window.__realVibeInit = VibeTranslate.initTranslator;
      VibeTranslate.initTranslator = (...args) => new Promise(resolve => { window.__releaseVibeInit = () => resolve(window.__realVibeInit(...args)); });
    } });
  }, tabId);
  // Force a new engine by switching target, then cancel while it is preparing.
  await web.locator('.vibe-tb-lang').selectOption('zh-Hant');
  await trigger(tabId);
  await trigger(tabId);
  await controller.evaluate(async id => {
    await chrome.scripting.executeScript({ target: { tabId: id }, func: () => window.__releaseVibeInit() });
  }, tabId);
  await web.waitForTimeout(500);
  assert.equal(await web.locator('.vibe-inline-translation').count(), 0);
  pass('cancel during engine preparation does not restart page translation');
  await web.close();

  // Native MIME detection on an extensionless PDF, using the actual background
  // route. Chromium owns the native preview, not a mocked DOM response.
  const native = watch(await context.newPage());
  await native.goto(base + '/download?id=123', { waitUntil: 'domcontentloaded' });
  const nativeId = await sw.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url).id, native.url());
  const created = context.waitForEvent('page');
  await trigger(nativeId);
  const routed = watch(await created);
  await routed.waitForURL(ext + 'viewer.html?*');
  assert.equal(new URL(routed.url()).searchParams.get('file'), base + '/download?id=123');
  await routed.waitForFunction(() => document.querySelectorAll('.seg-trans:not(.loading)').length > 0);
  pass('native preview of extensionless PDF routes to translated PDF');
  await routed.close(); await native.close();

  // A silent model port must not hold the file-picker UI hostage.
  const stalled = watch(await context.newPage());
  await stalled.addInitScript(() => {
    chrome.runtime.connect = () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {} });
  });
  await stalled.goto(ext + 'viewer.html');
  await stalled.locator('.open-pdf-btn').waitFor({ timeout: 2000 });
  await stalled.locator('#fileInput').setInputFiles({ name: 'engine-offline.pdf', mimeType: 'application/pdf', buffer: pdf });
  await stalled.waitForFunction(() => document.querySelectorAll('#pdfInner .page-wrap').length === 2);
  pass('file import and PDF rendering remain available with an unresponsive model service');
  await stalled.close();

  const fallback = watch(await context.newPage());
  await fallback.addInitScript(() => { delete window.ResizeObserver; });
  await fallback.goto(ext + 'viewer.html');
  await fallback.locator('#fileInput').setInputFiles({ name: 'compatibility.pdf', mimeType: 'application/pdf', buffer: pdf });
  await fallback.waitForFunction(() => document.querySelectorAll('.seg-trans:not(.loading)').length > 0);
  await fallback.locator('#pdfLayoutBtn').tap();
  await fallback.waitForFunction(() => document.querySelectorAll('.pdf-trans-block').length > 0);
  pass('missing ResizeObserver does not disable file import or dual-page PDF');
  await fallback.close();

  await context.setOffline(true);
  const offline = await viewer();
  await offline.locator('#fileInput').setInputFiles({ name: 'offline.pdf', mimeType: 'application/pdf', buffer: pdf });
  await offline.waitForFunction(() => document.querySelectorAll('.seg-trans:not(.loading)').length > 0 && document.querySelector('#stopBtn').style.display === 'none', null, { timeout: 60000 });
  assert.ok((await offline.locator('.seg-trans').allTextContents()).every(t => !t.includes('翻譯失敗')));
  assert.deepEqual(await offline.evaluate(() => paragraphs.map(p => p.text)), paragraphModeText,
    'Saved dual-page mode must not lose source text on a phone-sized display');
  pass('downloaded model translates local PDF offline');
  pass('reopening in saved dual-page mode preserves the same PDF text as paragraph mode');
  assert.deepEqual(errors, [], 'Uncaught browser errors');
  pass('no uncaught JavaScript errors');
})().catch(error => { results.push({ passed: false, error: error.stack }); console.error(error); process.exitCode = 1; })
  .finally(async () => {
    const pages = [];
    if (process.exitCode) for (const page of context?.pages() || []) {
      pages.push(await page.evaluate(() => ({ url: location.href, status: document.querySelector('#statusText')?.textContent,
        error: document.querySelector('#errorBox')?.textContent, results: document.querySelector('#results')?.textContent })).catch(() => ({})));
    }
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ environment: 'Chrome for Testing; Android UA, touch, 393x851, DPR 3; NOT physical Edge Android', extension, results, pages, browserLog }, null, 2));
    await context?.close(); server.close();
  });
