'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// In-page immersive translator (content script).
//
// Runs in the page's document context so the Chrome built-in AI APIs are
// available (they are NOT available in the MV3 service worker). The shared
// engine lives in window.VibeTranslate (translate-core.js), injected alongside
// this file by background.js.
//
// Modes:
//   • Full page (default)  — toggle on/off; lazily translates blocks via
//     IntersectionObserver and follows new content via MutationObserver.
//   • Selection            — translate just the selected text into a popup card.
//   • Hover                — translate the block under the cursor (toolbar toggle).
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  if (window.__vibeReadingContent) return; // already injected — existing listener handles messages
  window.__vibeReadingContent = true;

  const VT = window.VibeTranslate;
  if (!VT) { console.warn('[氛圍閱讀] translate-core 未載入'); return; }

  const INLINE_CLASS    = 'vibe-inline-translation';
  const TRANSLATED_ATTR = 'data-vibe-translated';
  const TOOLBAR_ID      = '__vibe_toolbar';
  const SELCARD_ID      = '__vibe_sel_card';

  const BLOCK_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, dd, dt, figcaption, caption';
  const INNER_HOSTS    = new Set(['LI', 'TD', 'TH', 'DD', 'DT', 'CAPTION']);
  const SKIP_TAGS      = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'TEXTAREA', 'SVG', 'CANVAS', 'KBD', 'SAMP']);

  // ─── State ──────────────────────────────────────────────────────────────────
  let translator   = null;          // cached engine from VT.initTranslator (+ _target)
  let sourceLang   = null;          // detected once
  let curTarget     = VT.browserDefaultTarget();
  let pageActive    = false;
  let hoverEnabled  = false;
  let hoverModifier = 'Shift';      // Shift | Alt | Control | Meta — set in the options page
  let modDown       = false;        // configured modifier currently held
  let lastX = 0, lastY = 0;         // last cursor position (for modifier-gated hover)
  let abortCtrl     = null;
  let io = null, mo = null;
  let translatedCount = 0;

  const queue = [];
  let activeWorkers = 0;

  // Persistent floating ball, like Immersive Translate: on every page we mount a
  // small ball and turn modifier-hover ON by default. Clicking the ball runs a
  // full-page translation; hovering the ball reveals the control panel. The ball
  // can be hidden globally from the options page (showBall).
  chrome.storage.local.get(['targetLang', 'hoverModifier', 'showBall'], (cfg) => {
    if (cfg.targetLang) curTarget = cfg.targetLang;
    if (cfg.hoverModifier) hoverModifier = cfg.hoverModifier;
    const sel = document.querySelector(`#${TOOLBAR_ID} .vibe-tb-lang`);
    if (sel) sel.value = curTarget;
    if (cfg.showBall !== false) { ensureToolbar(); setHover(true); }  // default-on
    updateHoverHint();
  });

  // Live-apply options-page / cross-tab changes.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.hoverModifier) { hoverModifier = changes.hoverModifier.newValue || 'Shift'; updateHoverHint(); }
    if (changes.targetLang && changes.targetLang.newValue) {
      curTarget = changes.targetLang.newValue;
      const sel = document.querySelector(`#${TOOLBAR_ID} .vibe-tb-lang`);
      if (sel && sel.value !== curTarget) sel.value = curTarget;
    }
    if (changes.showBall) {
      if (changes.showBall.newValue === false) removeToolbar();
      else { ensureToolbar(); setHover(true); }
    }
  });

  // ─── Helpers ──────────────────────────────────────────────────────────────────
  const currentTarget = () => curTarget;
  const yieldIdle = () => new Promise((r) =>
    window.requestIdleCallback ? requestIdleCallback(() => r(), { timeout: 200 }) : setTimeout(r, 0));

  function isVisible(el) {
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }

  function shouldTranslate(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hasAttribute(TRANSLATED_ATTR)) return false;
    if (el.isContentEditable) return false;
    if (el.closest(`.${INLINE_CLASS}, #${TOOLBAR_ID}, #${SELCARD_ID}`)) return false;
    for (let p = el; p; p = p.parentElement) if (SKIP_TAGS.has(p.tagName)) return false;
    if (el.querySelector(BLOCK_SELECTOR)) return false; // only translate leaf blocks (avoid parent+child dupes)
    if (!isVisible(el)) return false;
    const text = (el.innerText || '').trim();
    if (text.length < 3) return false;
    if (!/\p{L}/u.test(text)) return false;
    return true;
  }

  function collectBlocks(root) {
    const out = [];
    if (root.nodeType === 1 && root.matches && root.matches(BLOCK_SELECTOR) && shouldTranslate(root)) out.push(root);
    if (root.querySelectorAll) for (const el of root.querySelectorAll(BLOCK_SELECTOR)) if (shouldTranslate(el)) out.push(el);
    return out;
  }

  function makeInlineNode(text, loading) {
    const node = document.createElement('div');
    node.className = INLINE_CLASS + (loading ? ' vibe-loading' : '');
    node.setAttribute('dir', 'auto');
    node.textContent = text;
    return node;
  }

  function placeInline(el, node) {
    if (INNER_HOSTS.has(el.tagName)) el.appendChild(node);
    else el.insertAdjacentElement('afterend', node);
  }

  // ─── Engine (lazy, cached; re-created when target language changes) ─────────────
  async function ensureEngine(targetLang) {
    if (translator && translator._target === targetLang) return translator;
    if (!sourceLang) {
      const sample = collectBlocks(document.body).slice(0, 8).map((el) => el.innerText).join(' ').slice(0, 1000);
      sourceLang = await VT.detectSourceLang(sample);
    }
    status('初始化翻譯引擎…');
    translator = await VT.initTranslator(sourceLang, targetLang, {
      isManual: true,
      onStatus: status,
      onProgress: () => {},
      onIndeterminate: () => {},
    });
    translator._target = targetLang;
    status(translator.type === 'translator' ? 'Translator API ✓' : 'Gemini Nano ✓');
    return translator;
  }

  async function translateEl(el, signal) {
    if (!shouldTranslate(el)) return;
    el.setAttribute(TRANSLATED_ATTR, 'pending');
    const original = (el.innerText || '').trim();
    const node = makeInlineNode('翻譯中…', true);
    placeInline(el, node);
    try {
      const out = await VT.doTranslate(translator, original);
      if (signal && signal.aborted) { node.remove(); el.removeAttribute(TRANSLATED_ATTR); return; }
      node.textContent = out;
      node.classList.remove('vibe-loading');
      el.setAttribute(TRANSLATED_ATTR, '1');
      translatedCount++;
      status(`已翻譯 ${translatedCount} 段`);
    } catch (e) {
      node.textContent = `[翻譯失敗] ${e.message || e}`;
      node.classList.remove('vibe-loading');
      node.classList.add('vibe-error');
      el.setAttribute(TRANSLATED_ATTR, 'error');
    }
  }

  // ─── Queue pump (lazy translation throttled by engine concurrency) ──────────────
  function enqueue(el) { queue.push(el); pump(); }
  function pump() {
    if (!abortCtrl || abortCtrl.signal.aborted) return;
    const max = translator && translator.type === 'lm' ? 1 : 4;
    while (activeWorkers < max && queue.length) {
      const el = queue.shift();
      activeWorkers++;
      Promise.resolve()
        .then(() => translateEl(el, abortCtrl.signal))
        .catch(() => {})
        .finally(async () => {
          activeWorkers--;
          if ((translatedCount & 7) === 0) await yieldIdle();
          pump();
        });
    }
  }

  // ─── Full-page flow ─────────────────────────────────────────────────────────────
  function observeAll(root) {
    collectBlocks(root).forEach((el) => io && io.observe(el));
  }

  function onIntersect(entries) {
    for (const e of entries) {
      if (e.isIntersecting) { io.unobserve(e.target); enqueue(e.target); }
    }
  }

  let moTimer = null;
  const pendingRoots = new Set();
  function onMutations(muts) {
    for (const m of muts) {
      if (m.addedNodes) m.addedNodes.forEach((n) => { if (n.nodeType === 1) pendingRoots.add(n); });
    }
    if (moTimer) return;
    moTimer = setTimeout(() => {
      moTimer = null;
      const roots = [...pendingRoots]; pendingRoots.clear();
      roots.forEach((r) => { if (r.isConnected) observeAll(r); });
    }, 400);
  }

  async function startTranslation() {
    abortCtrl = new AbortController();
    translatedCount = 0;
    try {
      await ensureEngine(currentTarget());
    } catch (e) {
      status('AI 不可用：' + (e.message || e));
      return;
    }
    io = new IntersectionObserver(onIntersect, { rootMargin: '600px 0px' });
    observeAll(document.body);
    mo = new MutationObserver(onMutations);
    mo.observe(document.body, { childList: true, subtree: true });
  }

  function clearTranslations() {
    if (abortCtrl) { abortCtrl.abort(); abortCtrl = null; }
    if (io) { io.disconnect(); io = null; }
    if (mo) { mo.disconnect(); mo = null; }
    queue.length = 0; activeWorkers = 0;
    document.querySelectorAll('.' + INLINE_CLASS).forEach((n) => n.remove());
    document.querySelectorAll('[' + TRANSLATED_ATTR + ']').forEach((el) => el.removeAttribute(TRANSLATED_ATTR));
  }

  function togglePage() {
    if (pageActive) {
      clearTranslations();
      pageActive = false;
      status('已切回原文');
      updateToolbarState();   // keep the ball; it is persistent
    } else {
      pageActive = true;
      ensureToolbar();
      status('翻譯中…');
      startTranslation();
      updateToolbarState();
    }
  }

  function onLangChange(val) {
    curTarget = val;
    chrome.storage.local.set({ targetLang: val });
    translator = null; // force re-init with the new language
    if (pageActive) {
      clearTranslations();
      status('翻譯中…');
      startTranslation();
    }
  }

  // ─── Hover mode — hold the configured modifier, translate the block at cursor ───
  const MOD_PROP = { Shift: 'shiftKey', Alt: 'altKey', Control: 'ctrlKey', Meta: 'metaKey' };
  const modifierActive = (e) => !!e[MOD_PROP[hoverModifier] || 'shiftKey'];
  const modLabel = () => (hoverModifier === 'Meta' ? '⌘' : hoverModifier === 'Control' ? 'Ctrl' : hoverModifier);

  let hoverThrottle = 0;
  let suppressBlock = null;   // block just toggled-off; don't auto re-translate until the cursor leaves it

  // Remove just one block's inline translation (its sibling node, or a child for li/td).
  function removeBlockTranslation(block) {
    let node = block.querySelector(':scope > .' + INLINE_CLASS);
    if (!node) {
      const sib = block.nextElementSibling;
      if (sib && sib.classList && sib.classList.contains(INLINE_CLASS)) node = sib;
    }
    if (node) node.remove();
    block.removeAttribute(TRANSLATED_ATTR);
  }

  // toggle=true → a fresh modifier press: translate the block at the cursor, or if
  // it is ALREADY translated, remove just that block's translation (press the
  // modifier again over it to hide it). toggle=false → sweeping with the modifier
  // held: only translate untranslated blocks, never auto-remove.
  function actAtCursor(toggle) {
    const el = document.elementFromPoint(lastX, lastY);
    const block = el && el.closest && el.closest(BLOCK_SELECTOR);
    if (block !== suppressBlock) suppressBlock = null;     // moved to another block → re-arm
    if (!block) return;
    if (block.hasAttribute(TRANSLATED_ATTR)) {
      if (toggle) { removeBlockTranslation(block); suppressBlock = block; }
      return;
    }
    if (block === suppressBlock) return;                   // just removed; wait until the cursor leaves it
    if (!shouldTranslate(block)) return;
    ensureEngine(currentTarget())
      .then(() => { abortCtrl = abortCtrl || new AbortController(); return translateEl(block, abortCtrl.signal); })
      .catch(() => {});
  }
  function onMouseMove(e) {
    lastX = e.clientX; lastY = e.clientY;
    if (!modDown) return;
    const now = e.timeStamp || 0;
    if (now - hoverThrottle < 60) return;   // throttle while sweeping
    hoverThrottle = now;
    actAtCursor(false);
  }
  function onKeyDown(e) { if (hoverEnabled && modifierActive(e) && !modDown) { modDown = true; actAtCursor(true); } }
  function onKeyUp(e)   { if (modDown && !modifierActive(e)) { modDown = false; suppressBlock = null; } }
  function onWinBlur()  { modDown = false; suppressBlock = null; }

  function setHover(on) {
    hoverEnabled = on;
    if (on) {
      document.addEventListener('mousemove', onMouseMove, true);
      document.addEventListener('keydown', onKeyDown, true);
      document.addEventListener('keyup', onKeyUp, true);
      window.addEventListener('blur', onWinBlur);
    } else {
      document.removeEventListener('mousemove', onMouseMove, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onWinBlur);
      modDown = false;
    }
    const cb = document.querySelector(`#${TOOLBAR_ID} .vibe-tb-hover input`);
    if (cb) cb.checked = on;
    updateHoverHint();
  }
  function updateHoverHint() {
    const lab = document.querySelector(`#${TOOLBAR_ID} .vibe-tb-hover`);
    if (lab) lab.title = `按住 ${modLabel()} 翻譯游標所指的段落（修飾鍵可在擴充設定頁更改）`;
    const txt = document.querySelector(`#${TOOLBAR_ID} .vibe-tb-hovertxt`);
    if (txt) txt.textContent = `懸停(${modLabel()})`;
  }

  // ─── Selection mode (popup card) ────────────────────────────────────────────────
  function selectionRect() {
    const s = window.getSelection();
    if (!s || s.rangeCount === 0) return null;
    const r = s.getRangeAt(0).getBoundingClientRect();
    return r && r.width ? r : null;
  }
  function showSelCard(text, rect) {
    let card = document.getElementById(SELCARD_ID);
    if (!card) {
      card = document.createElement('div');
      card.id = SELCARD_ID;
      card.className = 'vibe-sel-card';
      document.documentElement.appendChild(card);
      document.addEventListener('mousedown', (e) => { if (!card.contains(e.target)) hideSelCard(); }, true);
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideSelCard(); }, true);
    }
    card.textContent = text;
    const top  = (rect ? rect.bottom + window.scrollY + 8 : window.scrollY + 80);
    const left = (rect ? rect.left + window.scrollX : window.scrollX + 80);
    card.style.top = top + 'px';
    card.style.left = Math.max(8, left) + 'px';
    card.style.display = 'block';
  }
  function hideSelCard() { const c = document.getElementById(SELCARD_ID); if (c) c.style.display = 'none'; }

  async function translateSelection(text) {
    const sel = (text || (window.getSelection && window.getSelection().toString()) || '').trim();
    if (!sel) return;
    const rect = selectionRect();
    showSelCard('翻譯中…', rect);
    try {
      await ensureEngine(currentTarget());
      const out = await VT.doTranslate(translator, sel);
      showSelCard(out, rect);
    } catch (e) {
      showSelCard('[翻譯失敗] ' + (e.message || e), rect);
    }
  }

  // ─── Floating toolbar ───────────────────────────────────────────────────────────
  function status(msg) {
    const s = document.querySelector(`#${TOOLBAR_ID} .vibe-tb-status`);
    if (s) s.textContent = msg;
  }
  function updateToolbarState() {
    const bar = document.getElementById(TOOLBAR_ID);
    if (!bar) return;
    bar.classList.toggle('vibe-active', pageActive);
    const ball = bar.querySelector('.vibe-ball');
    if (ball) ball.title = pageActive ? '點擊切回原文（懸浮選單可調整）' : '點擊翻譯整頁（懸浮選單可調整）';
  }
  function ensureToolbar() {
    if (document.getElementById(TOOLBAR_ID)) return;
    const bar = document.createElement('div');
    bar.id = TOOLBAR_ID;
    bar.className = 'vibe-toolbar';
    const opts = VT.TARGET_LANGS.map((t) => `<option value="${t.code}">${t.name}</option>`).join('');
    bar.innerHTML =
      '<div class="vibe-ball" title="點擊翻譯整頁（懸浮選單可調整）">📖</div>' +
      '<div class="vibe-panel">' +
        `<select class="vibe-tb-lang" title="翻譯成">${opts}</select>` +
        `<label class="vibe-tb-hover"><input type="checkbox"> <span class="vibe-tb-hovertxt">懸停(${modLabel()})</span></label>` +
        '<span class="vibe-tb-status">就緒</span>' +
        '<button class="vibe-tb-settings" title="設定（修飾鍵等）">⚙</button>' +
        '<button class="vibe-tb-hide" title="隱藏懸浮球（本次瀏覽）">✕</button>' +
      '</div>';
    document.documentElement.appendChild(bar);

    const langSel = bar.querySelector('.vibe-tb-lang');
    langSel.value = curTarget;
    langSel.addEventListener('change', () => onLangChange(langSel.value));
    bar.querySelector('.vibe-tb-hover input').addEventListener('change', (e) => setHover(e.target.checked));
    bar.querySelector('.vibe-ball').addEventListener('click', togglePage);
    bar.querySelector('.vibe-tb-settings').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'VIBE_OPEN_OPTIONS' }));
    bar.querySelector('.vibe-tb-hide').addEventListener('click', removeToolbar);
    updateHoverHint();
    updateToolbarState();
  }
  function removeToolbar() {
    const bar = document.getElementById(TOOLBAR_ID);
    if (bar) bar.remove();
  }

  // ─── Message handling (single listener; guarded against re-injection) ───────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'VIBE_TOGGLE_PAGE') { ensureToolbar(); togglePage(); }
    else if (msg.type === 'VIBE_TRANSLATE_SELECTION') { translateSelection(msg.text); }
    else if (msg.type === 'VIBE_ENABLE_HOVER') {
      ensureToolbar();
      setHover(true);
      status(`懸停翻譯已開啟：按住 ${modLabel()} 翻游標所指的段落`);
    }
  });
})();
