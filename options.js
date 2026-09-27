'use strict';

const sel      = document.getElementById('hoverModifier');
const showBall = document.getElementById('showBall');
const saved    = document.getElementById('saved');

async function refreshShortcut() {
  const commands = await chrome.commands.getAll();
  const command = commands.find(({ name }) => name === 'translate-selection');
  document.getElementById('selectionShortcut').textContent =
    command?.shortcut || '未設定';
}

document.getElementById('configureShortcuts').addEventListener('click', () => {
  const scheme = /Edg\//.test(navigator.userAgent) ? 'edge' : 'chrome';
  chrome.tabs.create({ url: `${scheme}://extensions/shortcuts` });
});
window.addEventListener('focus', refreshShortcut);
refreshShortcut();

function flashSaved() {
  saved.textContent = '✓ 已儲存（開啟中的網頁分頁即時生效）';
  setTimeout(() => { saved.textContent = ''; }, 2000);
}

chrome.storage.local.get(['hoverModifier', 'showBall'], (cfg) => {
  sel.value = cfg.hoverModifier || 'Shift';
  showBall.checked = cfg.showBall !== false;   // default on
});

sel.addEventListener('change', () => {
  chrome.storage.local.set({ hoverModifier: sel.value }, flashSaved);
});

showBall.addEventListener('change', () => {
  chrome.storage.local.set({ showBall: showBall.checked }, flashSaved);
});
