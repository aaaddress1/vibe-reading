'use strict';

const sel      = document.getElementById('hoverModifier');
const engine   = document.getElementById('engine');
const showBall = document.getElementById('showBall');
const saved    = document.getElementById('saved');

async function refreshShortcut() {
  if (!chrome.commands) return;   // no keyboard shortcuts on mobile
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

const siteList = document.getElementById('hiddenSites');

function renderHiddenSites(sites) {
  siteList.replaceChildren();
  if (!sites.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '（目前沒有）';
    siteList.append(li);
    return;
  }
  for (const site of sites) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = site;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '恢復顯示';
    btn.addEventListener('click', () => {
      chrome.storage.local.get('ballHiddenSites', ({ ballHiddenSites = [] }) => {
        chrome.storage.local.set(
          { ballHiddenSites: ballHiddenSites.filter(s => s !== site) }, flashSaved);
      });
    });
    li.append(name, btn);
    siteList.append(li);
  }
}

chrome.storage.local.get(['hoverModifier', 'showBall', 'ballHiddenSites', 'engine'], (cfg) => {
  sel.value = cfg.hoverModifier || 'Shift';
  engine.value = cfg.engine === 'local' ? 'local' : 'auto';
  showBall.checked = cfg.showBall !== false;   // default on
  renderHiddenSites(cfg.ballHiddenSites || []);
});

// Keep in sync with changes made from the ball's ✕ menu in other tabs.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.showBall) showBall.checked = changes.showBall.newValue !== false;
  if (changes.ballHiddenSites) renderHiddenSites(changes.ballHiddenSites.newValue || []);
});

sel.addEventListener('change', () => {
  chrome.storage.local.set({ hoverModifier: sel.value }, flashSaved);
});

showBall.addEventListener('change', () => {
  chrome.storage.local.set({ showBall: showBall.checked }, flashSaved);
});

engine.addEventListener('change', () => {
  chrome.storage.local.set({ engine: engine.value }, flashSaved);
});
