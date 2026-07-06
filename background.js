'use strict';

const MENU_ID = 'translate-pdf-fulltext';

// ─── Open the two-pane translation viewer for a given tab ──────────────────────
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

// ─── Context menu (right-click) ────────────────────────────────────────────────
function setupMenu() {
  chrome.contextMenus.removeAll(() => {
    // No documentUrlPatterns: the native PDF viewer's frame URL is a
    // chrome-extension:// address, not the PDF URL, so any pattern based on
    // the PDF URL would never match. Register on all pages instead; the
    // viewer simply opens empty if the tab isn't a PDF.
    chrome.contextMenus.create({
      id: MENU_ID,
      title: '用「氛圍閱讀」翻譯整份 PDF',
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
  if (info.menuItemId === MENU_ID) openViewer(tab);
});

// ─── Toolbar icon click ─────────────────────────────────────────────────────────
chrome.action.onClicked.addListener(openViewer);

// ─── Keyboard shortcut (Alt+T) ────────────────────────────────────────────────
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'translate-pdf') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) openViewer(tab);
});
