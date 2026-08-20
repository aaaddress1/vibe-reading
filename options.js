'use strict';

const sel      = document.getElementById('hoverModifier');
const showBall = document.getElementById('showBall');
const saved    = document.getElementById('saved');

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
