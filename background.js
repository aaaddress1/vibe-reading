import * as localMT from './local-mt.js';
import { handleTrigger, translateSelection, enableHover } from './tab-actions.js';

const MENU_PAGE      = 'vibe-translate-page';
const MENU_SELECTION = 'vibe-translate-selection';
const MENU_HOVER     = 'vibe-translate-hover';
const MENU_SHOW_BALL = 'vibe-show-ball';
const MENU_OPTIONS   = 'vibe-options';

// ─── Context menu (right-click) ────────────────────────────────────────────────
function setupMenu() {
  if (!chrome.contextMenus?.removeAll || !chrome.contextMenus?.create) return;
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
    // Once the floating ball is hidden its ⚙ button is gone too, so these two
    // entries (page + toolbar-icon menus) are the way back.
    chrome.contextMenus.create({
      id: MENU_SHOW_BALL,
      title: '氛圍閱讀：重新顯示翻譯球',
      contexts: ['page', 'action'],
    });
    chrome.contextMenus.create({
      id: MENU_OPTIONS,
      title: '氛圍閱讀：設定（翻譯球、懸停修飾鍵…）',
      contexts: ['page', 'action'],
    });
  });
}

// Undo both kinds of hiding for this tab's site: drop it from the per-site
// list and turn the global switch back on (there is no per-site allow-list).
// Open content scripts pick the change up via storage.onChanged.
async function showBallAgain(tab) {
  let host = '';
  try { host = new URL(tab?.url || '').hostname; } catch (_) {}
  const { ballHiddenSites = [] } = await chrome.storage.local.get('ballHiddenSites');
  await chrome.storage.local.set({
    showBall: true,
    ballHiddenSites: ballHiddenSites.filter(s => s !== host),
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  setupMenu();
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html?welcome=1') });
  }
});
chrome.runtime.onStartup.addListener(setupMenu);

chrome.contextMenus?.onClicked?.addListener((info, tab) => {
  if (info.menuItemId === MENU_PAGE) handleTrigger(tab);
  else if (info.menuItemId === MENU_SELECTION) translateSelection(tab, info.selectionText);
  else if (info.menuItemId === MENU_HOVER) enableHover(tab);
  else if (info.menuItemId === MENU_SHOW_BALL) showBallAgain(tab);
  else if (info.menuItemId === MENU_OPTIONS) chrome.runtime.openOptionsPage();
});

// ─── Open the options page (requested by the in-page panel's ⚙ button) ──────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'VIBE_OPEN_OPTIONS') chrome.runtime.openOptionsPage();
});

// ─── Toolbar icon click ─────────────────────────────────────────────────────────
chrome.action?.onClicked?.addListener(tab => handleTrigger(tab).catch(console.error));

// ─── Keyboard shortcuts (customizable in the browser's extension settings) ───
chrome.commands?.onCommand?.addListener(async (command) => {
  if (command !== 'translate-pdf' && command !== 'translate-selection') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  if (command === 'translate-selection') await translateSelection(tab);
  else await handleTrigger(tab);
});

// ─── Local translation engine (local-mt.js) ─────────────────────────────────────
// Pages without the built-in AI APIs (Edge for Android) translate through this
// port. Jobs run one at a time — a model's sessions can't run concurrently — and
// jobs from a page that has gone away are dropped.
let mtChain = Promise.resolve();
let mtBusy = 0;
let mtKeepAlive = null;

// An extension service worker is stopped after ~30s without extension events or
// API calls; a long download or a slow phone can exceed that mid-job.
function mtJobStarted() {
  if (mtBusy++ === 0) mtKeepAlive = setInterval(() => {
    // Storage is supported on Android, including builds without platform info.
    chrome.storage.local.get('engine').catch(() => {});
  }, 20e3);
}
function mtJobEnded() {
  if (--mtBusy === 0) clearInterval(mtKeepAlive);
}

async function runMtJob(msg, post) {
  const onProgress = progress => post({ id: msg.id, progress });
  if (msg.op === 'status') {
    const plan = localMT.planFor(msg.src, msg.tgt);
    if (!plan) return { supported: false };
    return { supported: true, downloaded: await localMT.isDownloaded(plan), sizeMB: localMT.downloadSizeMB(plan) };
  }
  if (msg.op === 'prepare') {
    await localMT.prepare(msg.src, msg.tgt, onProgress);
    return true;
  }
  if (msg.op === 'translate') return localMT.translate(msg.text, msg.src, msg.tgt, onProgress);
  throw new Error(`unknown op ${msg.op}`);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'vibe-mt') return;
  let open = true;
  port.onDisconnect.addListener(() => { open = false; });
  const post = (m) => {
    if (open) try { port.postMessage(m); } catch (_) { open = false; }
  };
  port.onMessage.addListener((msg) => {
    // Capability checks must not wait behind model loading or another tab's
    // translation. Otherwise opening a PDF appears completely unresponsive.
    if (msg.op === 'status') {
      runMtJob(msg, post).then(result => post({ id: msg.id, result }),
        e => post({ id: msg.id, error: e?.message || String(e) }));
      return;
    }
    mtChain = mtChain.then(async () => {
      if (!open) return;
      mtJobStarted();
      try {
        post({ id: msg.id, result: await runMtJob(msg, post) });
      } catch (e) {
        post({ id: msg.id, error: e?.message || String(e) });
      } finally {
        mtJobEnded();
      }
    });
  });
});
