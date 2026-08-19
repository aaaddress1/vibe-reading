'use strict';

const MENU_PAGE      = 'vibe-translate-page';
const MENU_SELECTION = 'vibe-translate-selection';
const MENU_HOVER     = 'vibe-translate-hover';

// ─── Open the two-pane PDF translation viewer for a given tab ──────────────────
async function openViewer(tab) {
  let viewer = chrome.runtime.getURL('viewer.html');
  if (tab?.url && isPdf(tab.url)) {
    viewer += '?file=' + encodeURIComponent(tab.url);
  }
  await chrome.tabs.create({ url: viewer });
}

function isPdf(url) {
  try {
    const path = new URL(url).pathname;
    return /\.pdf(\?.*)?$/i.test(path) || /\/pdf\/[^/]+$/i.test(path);
  } catch {
    return false;
  }
}

// Pages we can inject a content script into. chrome://, chrome-extension://,
// devtools://, about:, view-source: and the Web Store are off-limits; file://
// only works when the user enabled "Allow access to file URLs" (we still try
// and fall back on failure).
function canInject(url) {
  if (!/^(https?|file):/i.test(url)) return false;
  if (/^https?:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i.test(url)) return false;
  return true;
}

// ─── Trigger router ─────────────────────────────────────────────────────────────
// PDF → open the dedicated viewer (unchanged behaviour).
// Normal web page → inject the in-page translator and toggle it.
// Anything we can't inject into → fall back to the viewer (it shows guidance).
async function handleTrigger(tab) {
  if (!tab || !tab.id) return;
  const url = tab.url || '';
  if (isPdf(url)) return openViewer(tab);
  if (!canInject(url)) return openViewer(tab);
  // The content script is normally already present (static content_scripts), so
  // message it directly; only fall back to injecting for tabs opened before the
  // extension was installed/updated.
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'VIBE_TOGGLE_PAGE' });
  } catch (_) {
    try {
      await injectInto(tab.id);
      await chrome.tabs.sendMessage(tab.id, { type: 'VIBE_TOGGLE_PAGE' });
    } catch (e) {
      console.warn('[氛圍閱讀] 內容腳本注入失敗，改開檢視器：', e);
      openViewer(tab);
    }
  }
}

// Inject the shared engine + content script (+ styles). Idempotent: re-running
// is cheap and content.js guards against double-initialisation.
async function injectInto(tabId) {
  await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['translate-core.js', 'content.js'],
  });
}

async function translateSelection(tab, text) {
  if (!tab?.id || !canInject(tab.url || '')) return;
  try {
    await injectInto(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: 'VIBE_TRANSLATE_SELECTION', text: text || '' });
  } catch (e) {
    console.warn('[氛圍閱讀] 選取翻譯注入失敗：', e);
  }
}

// Enable hover-translate WITHOUT translating the whole page.
async function enableHover(tab) {
  if (!tab?.id || !canInject(tab.url || '')) return;
  try {
    await injectInto(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: 'VIBE_ENABLE_HOVER' });
  } catch (e) {
    console.warn('[氛圍閱讀] 懸停翻譯注入失敗：', e);
  }
}

// ─── Context menu (right-click) ────────────────────────────────────────────────
function setupMenu() {
  chrome.contextMenus.removeAll(() => {
    // contexts:['all'] so the PDF native viewer (whose frame URL is a
    // chrome-extension:// address) still surfaces the entry; handleTrigger
    // routes PDFs to the viewer regardless.
    chrome.contextMenus.create({
      id: MENU_PAGE,
      title: '氛圍閱讀：翻譯這個頁面 / 切回原文',
      contexts: ['all'],
    });
    chrome.contextMenus.create({
      id: MENU_SELECTION,
      title: '氛圍閱讀：翻譯選取的文字',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: MENU_HOVER,
      title: '氛圍閱讀：開啟懸停翻譯（按住修飾鍵翻該段）',
      contexts: ['all'],
    });
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  setupMenu();
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html?welcome=1') });
  }
});
chrome.runtime.onStartup.addListener(setupMenu);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_PAGE) handleTrigger(tab);
  else if (info.menuItemId === MENU_SELECTION) translateSelection(tab, info.selectionText);
  else if (info.menuItemId === MENU_HOVER) enableHover(tab);
});

// ─── Open the options page (requested by the in-page panel's ⚙ button) ──────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'VIBE_OPEN_OPTIONS') chrome.runtime.openOptionsPage();
});

// ─── Toolbar icon click ─────────────────────────────────────────────────────────
chrome.action.onClicked.addListener(handleTrigger);

// ─── Keyboard shortcut (Alt+T) ────────────────────────────────────────────────
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'translate-pdf') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) handleTrigger(tab);
});
