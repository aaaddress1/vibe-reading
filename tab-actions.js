import { pdfSourceFromUrl, readablePdfSource, inspectPdfDocument } from './pdf-source.js';

// ─── Open the two-pane PDF translation viewer for a given tab ──────────────────
async function openViewer(tab, source = pdfSourceFromUrl(tab?.url)) {
  let viewer = chrome.runtime.getURL('viewer.html');
  if (source && readablePdfSource(source)) {
    viewer += '?file=' + encodeURIComponent(source);
  }
  await chrome.tabs.create({ url: viewer });
}

// Pages we can inject a content script into. chrome://, edge://, chrome-extension://,
// devtools://, about:, view-source: and the extension stores are off-limits; file://
// only works when the user enabled "Allow access to file URLs" (we still try
// and fall back on failure).
function canInject(url) {
  if (!/^(https?|file):/i.test(url)) return false;
  if (/^https?:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i.test(url)) return false;
  if (/^https?:\/\/microsoftedge\.microsoft\.com\/addons/i.test(url)) return false;
  return true;
}

// ─── Trigger router ─────────────────────────────────────────────────────────────
// PDF → open the dedicated viewer (unchanged behaviour).
// Normal web page → inject the in-page translator and toggle it.
// Anything we can't inject into → fall back to the viewer (it shows guidance).
export async function handleTrigger(tab) {
  if (!Number.isInteger(tab?.id) || tab.id < 0) {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  if (!tab) return openViewer();
  const url = tab.url || '';
  if (pdfSourceFromUrl(url)) return openViewer(tab);
  if (!canInject(url)) return openViewer(tab);
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: inspectPdfDocument });
    const source = results?.map(r => readablePdfSource(r.result)).find(Boolean);
    if (source) return openViewer(tab, source);
  } catch (_) { /* Native PDF viewers may reject script injection. */ }
  // The content script is normally already present (static content_scripts), so
  // message it directly; only fall back to injecting for tabs opened before the
  // extension was installed/updated.
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'VIBE_TOGGLE_PAGE' });
    // Pre-update content scripts (1.7/2.1) handled this message without a reply.
    // A resolved undefined response must not toggle them a second time.
    if (response?.handled || response === undefined) return;
    throw new Error('No translator acknowledged the request');
  } catch (_) {
    try {
      await injectInto(tab.id);
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'VIBE_TOGGLE_PAGE' });
      if (response !== undefined && !response?.handled) throw new Error('No translator acknowledged the request');
    } catch (e) {
      console.warn('[氛圍閱讀] 內容腳本注入失敗，改開檢視器：', e);
      // Some native viewers expose an opaque download URL and deny injection.
      // Inspect only headers; do not download a second copy of the PDF here.
      try {
        const response = await fetch(url, { method: 'HEAD', credentials: 'include', signal: AbortSignal.timeout(5000) });
        if (response.ok && /application\/pdf/i.test(response.headers.get('content-type') || '')) {
          return openViewer(tab, url);
        }
      } catch (_) {}
      return openViewer(tab);
    }
  }
}

// Inject the shared engine + content script (+ styles). Idempotent: re-running
// is cheap and content.js guards against double-initialisation.
async function injectInto(tabId) {
  await chrome.scripting.insertCSS({ target: { tabId }, files: ['theme.css', 'content.css'] });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['theme.js', 'translate-core.js', 'content.js'],
  });
}

export async function translateSelection(tab, text) {
  if (!tab?.id || !canInject(tab.url || '')) return;
  try {
    await injectInto(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: 'VIBE_TRANSLATE_SELECTION', text: text || '' });
  } catch (e) {
    console.warn('[氛圍閱讀] 選取翻譯注入失敗：', e);
  }
}

// Enable hover-translate WITHOUT translating the whole page.
export async function enableHover(tab) {
  if (!tab?.id || !canInject(tab.url || '')) return;
  try {
    await injectInto(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: 'VIBE_ENABLE_HOVER' });
  } catch (e) {
    console.warn('[氛圍閱讀] 懸停翻譯注入失敗：', e);
  }
}

