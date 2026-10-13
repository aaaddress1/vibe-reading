'use strict';

const PDFJS = window.pdfjsLib;
PDFJS.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.js');

// ─── Shared translation engine (translate-core.js) ──────────────────────────────
// TARGET_LANGS / langName / browserDefaultTarget / detectSourceLang /
// initTranslator / doTranslate now live in window.VibeTranslate so the in-page
// content script can reuse the exact same engine. The PDF viewer behaviour is
// unchanged — it just sources these from the shared module.
const {
  TARGET_LANGS,
  langName,
  browserDefaultTarget,
  detectSourceLang,
  initTranslator,
  doTranslate,
  BROWSER,
  lmAvailability,
  lmCreate,
  localStatus,
  enginePreference,
  engineLabel,
} = window.VibeTranslate;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const els = {
  appVer:        document.getElementById('appVer'),
  pdfSource:     document.getElementById('pdfSource'),
  openFileBtn:   document.getElementById('openFileBtn'),
  fileInput:     document.getElementById('fileInput'),
  srcLangInfo:   document.getElementById('srcLangInfo'),
  zoomIn:        document.getElementById('zoomIn'),
  zoomOut:       document.getElementById('zoomOut'),
  zoomFit:       document.getElementById('zoomFit'),
  zoomLabel:     document.getElementById('zoomLabel'),
  targetLang:    document.getElementById('targetLang'),
  settingsBtn:   document.getElementById('settingsBtn'),
  pdfDarkBtn:    document.getElementById('pdfDarkBtn'),
  aiBadge:       document.getElementById('aiBadge'),
  translateBtn:  document.getElementById('translateBtn'),
  stopBtn:       document.getElementById('stopBtn'),
  fontDec:       document.getElementById('fontDec'),
  fontInc:       document.getElementById('fontInc'),
  statusText:    document.getElementById('statusText'),
  progressWrap:  document.getElementById('progressWrap'),
  progressBar:   document.getElementById('progressBar'),
  progressLabel: document.getElementById('progressLabel'),
  errorBox:      document.getElementById('errorBox'),
  pdfPane:       document.getElementById('pdfPane'),
  pdfInner:      document.getElementById('pdfInner'),
  divider:       document.getElementById('divider'),
  summary:       document.getElementById('summary'),
  results:       document.getElementById('results'),
  askFloat:      document.getElementById('askFloat'),
  askFloatAsk:   document.getElementById('askFloatAsk'),
  askFloatTrans: document.getElementById('askFloatTrans'),
  askModal:      document.getElementById('askModal'),
  askSel:        document.getElementById('askSel'),
  askInput:      document.getElementById('askInput'),
  askSend:       document.getElementById('askSend'),
  askStop:       document.getElementById('askStop'),
  askAnswer:     document.getElementById('askAnswer'),
  askClose:      document.getElementById('askClose'),
  askHead:       document.getElementById('askHead'),
  welcomeModal:      document.getElementById('welcomeModal'),
  welcomeTargetLang: document.getElementById('welcomeTargetLang'),
  welcomeEngine:     document.getElementById('welcomeEngine'),
  welcomeEngineLabel: document.getElementById('welcomeEngineLabel'),
  welcomeEngineCopy:  document.getElementById('welcomeEngineCopy'),
  welcomeClose:      document.getElementById('welcomeClose'),
  welcomeOpenExt:    document.getElementById('welcomeOpenExt'),
  welcomeRecheck:    document.getElementById('welcomeRecheck'),
  welcomeOpenShortcuts: document.getElementById('welcomeOpenShortcuts'),
  welcomeDone:       document.getElementById('welcomeDone'),
  welcomeKicker:     document.getElementById('welcomeKicker'),
  welcomeTitle:      document.getElementById('welcomeTitle'),
  welcomeLangLabel:  document.getElementById('welcomeLangLabel'),
  welcomeLangCopy:   document.getElementById('welcomeLangCopy'),
  welcomeFileLabel:  document.getElementById('welcomeFileLabel'),
  welcomeFileCopy:   document.getElementById('welcomeFileCopy'),
  welcomeShortcutLabel: document.getElementById('welcomeShortcutLabel'),
  welcomeShortcutCopy:  document.getElementById('welcomeShortcutCopy'),
  fileAccessStatus:  document.getElementById('fileAccessStatus'),
  shortcutStatus:    document.getElementById('shortcutStatus'),
  welcomeAiLabel:    document.getElementById('welcomeAiLabel'),
  aiTranslateStatus: document.getElementById('aiTranslateStatus'),
  aiPromptStatus:    document.getElementById('aiPromptStatus'),
  aiGuide:           document.getElementById('aiGuide'),
  welcomeOpenFlags:  document.getElementById('welcomeOpenFlags'),
  welcomeAiRecheck:  document.getElementById('welcomeAiRecheck'),
};

// ─── State ────────────────────────────────────────────────────────────────────
let pdfUrl        = null;
let pdfDoc        = null;
let abortCtrl     = null;
let translatorObj = null;
let paragraphs    = [];     // { page, text, rect:{x0,y0,x1,y1}, parts:[{page, rect}] } — page/rect = first part
const pageWraps   = {};     // pageNum -> { wrap, viewport }
let renderScale   = 1;
let detectedSource = 'en';
let selectedText  = '';
let summaryDone   = false;
let summaryObj    = null;   // generated AI summary, reused as Q&A context
let segEls        = [];     // paragraph index -> right-pane segment element
let welcomeText   = null;

const WELCOME_TEXT = {
  'zh-TW': {
    lang: 'zh-TW',
    kicker: '初次設定',
    title: '歡迎使用氛圍閱讀',
    closeTitle: '關閉',
    settingsTitle: '設定',
    targetLabel: '預設目標語言',
    targetCopy: '之後每次開啟 PDF 都會優先翻譯成這個語言，也可以在右上角隨時改。',
    engineLabel: '翻譯引擎',
    engineAuto: '自動（預設）',
    engineLocal: '本機翻譯模型',
    engineCopy: '「自動」優先使用瀏覽器內建 AI，沒有時（例如 Android 版 Edge）才改用本機翻譯模型。「本機翻譯模型」一律在本機 CPU 執行 Opus-MT 模型：每個語言組合第一次使用時下載約 117MB，品質與速度不如內建 AI。變更後按「翻譯」重新翻譯即可套用。',
    fileLabel: '讀取本機 PDF',
    fileCopy: '若要翻譯電腦裡的 PDF，請到擴充功能管理頁，把「允許存取檔案網址」設成 enable。',
    shortcutLabel: '快捷鍵',
    shortcutCopy: `若 Alt+T 沒反應，通常是 ${BROWSER.name} 沒有把快捷鍵指派給這個擴充功能；同時安裝開發版與商城版時尤其容易發生。`,
    checkingFileAccess: '正在檢查檔案網址存取權限...',
    checkingShortcut: '正在檢查快捷鍵...',
    openExtensions: '開啟管理擴充功能',
    openShortcuts: '開啟快捷鍵設定',
    recheck: '重新檢查',
    done: '儲存並開始使用',
    openedExtensions: '管理頁已開啟；把「允許存取檔案網址」設成 enable 後，回來按「重新檢查」。',
    openedShortcuts: '快捷鍵設定頁已開啟；請確認「用氛圍閱讀翻譯目前分頁的 PDF」有設定為 Alt+T，或改成你想要的按鍵。',
    cannotCheckFileAccess: `${BROWSER.name} 無法回報目前狀態；請到管理擴充功能確認「允許存取檔案網址」已設成 enable。`,
    fileAccessAllowed: '已允許存取檔案網址，可以讀取本機 PDF。',
    fileAccessDenied: '尚未允許存取檔案網址；本機 PDF 需要開啟這個權限。',
    shortcutAssigned: shortcut => `目前快捷鍵：${shortcut}`,
    shortcutMissing: `目前沒有指派快捷鍵。請到 ${BROWSER.name} 快捷鍵設定頁手動指定 Alt+T，或先停用另一個占用 Alt+T 的擴充功能。`,
    shortcutUnknown: `${BROWSER.name} 無法回報快捷鍵狀態；請到快捷鍵設定頁確認。`,
    noPdfWelcomeStatus: '初次設定完成後，請開啟一個 PDF 分頁並點擊插件圖示或右鍵選單。',
    aiLabel: '瀏覽器內建 AI',
    checkingAiTranslate: '正在檢查翻譯功能...',
    checkingAiPrompt: '正在檢查 AI 摘要／反白問答...',
    openFlags: '開啟 flags 設定',
    aiTranslate: {
      available: '翻譯：可以使用 ✓',
      downloadable: '翻譯：可以使用，第一次翻譯時會下載語言包',
      unavailable: '翻譯：目前的目標語言或裝置不支援',
      missing: '翻譯：無法使用',
    },
    aiTranslateLocal: mb => `翻譯：使用本機翻譯模型（第一次翻譯時下載約 ${mb}MB）`,
    aiPrompt: {
      available: 'AI 摘要／反白問答：可以使用 ✓',
      downloadable: 'AI 摘要／反白問答：可以使用，第一次使用時會下載模型（數 GB）',
      unavailable: 'AI 摘要／反白問答：目前無法使用',
      missing: 'AI 摘要／反白問答：尚未啟用',
    },
    guide: {
      edge: {
        translateMissing: '請將 Edge 更新到 148 以上（edge://settings/help），翻譯功能才能使用。',
        translateUnavailable: '可以換一個目標語言試試；Edge 的翻譯模型會依語言組合下載。',
        promptMissing: 'Edge 正式版尚未提供 AI 摘要／反白問答（不影響翻譯）。若要使用：\n1. 安裝 Edge Canary 或 Dev（microsoft.com/edge/download/insider）\n2. 到 edge://flags 搜尋「Prompt API for on-device language model」，設為 Enabled\n3. 重啟 Edge 後回來按「重新檢查」',
        promptUnavailable: '不影響翻譯。可能原因有兩種：\n1. 你使用的是 Edge 正式版：這項功能目前只有 Edge Canary / Dev 提供（edge://on-device-internals 的 Device performance class 會一直顯示 Loading）\n2. 已是 Canary / Dev 但硬體不足：預設模型需要約 5.5GB 顯示記憶體；Edge 150 以上可在 edge://flags 啟用「Enable prerelease on-device language model」，改用較小、可用 CPU 執行的模型',
      },
      chrome: {
        translateMissing: '請將 Chrome 更新到 138 以上（chrome://settings/help），翻譯功能才能使用。',
        translateUnavailable: '可以換一個目標語言試試；Chrome 的翻譯模型會依語言組合下載。',
        promptMissing: 'AI 摘要／反白問答需要 Gemini Nano（不影響翻譯）。若要使用：\n1. 到 chrome://flags 搜尋「Prompt API for Gemini Nano」，設為 Enabled\n2. 重啟 Chrome\n3. 到 chrome://components 更新「Optimization Guide On Device Model」，再回來按「重新檢查」',
        promptUnavailable: 'Gemini Nano 需要 GPU 顯示記憶體超過 4GB（或 16GB RAM + 4 核 CPU）以及至少 22GB 可用磁碟空間（不影響翻譯）。可到 chrome://on-device-internals 查看詳細狀態。',
      },
    },
  },
  en: {
    lang: 'en',
    kicker: 'First-run setup',
    title: 'Welcome to Vibe Reading',
    closeTitle: 'Close',
    settingsTitle: 'Settings',
    targetLabel: 'Default target language',
    targetCopy: 'PDFs will be translated into this language by default. You can change it anytime from the top-right menu.',
    engineLabel: 'Translation engine',
    engineAuto: 'Automatic (default)',
    engineLocal: 'Local translation model',
    engineCopy: 'Automatic uses the browser’s built-in AI and falls back to the local model only when there is none (e.g. Edge for Android). Local translation model always runs Opus-MT on your CPU: each language pair downloads about 117MB on first use, and it is slower and less accurate than the built-in AI. Click "Translate" again to apply a change.',
    fileLabel: 'Read local PDFs',
    fileCopy: 'To translate PDFs from your computer, open the extension details page and enable "Allow access to file URLs".',
    shortcutLabel: 'Keyboard shortcut',
    shortcutCopy: `If Alt+T does not respond, ${BROWSER.name} probably did not assign the shortcut to this extension. This is common when both the unpacked build and store build are installed.`,
    checkingFileAccess: 'Checking file URL access...',
    checkingShortcut: 'Checking shortcut...',
    openExtensions: 'Open extension settings',
    openShortcuts: 'Open shortcut settings',
    recheck: 'Recheck',
    done: 'Save and start',
    openedExtensions: 'The extension settings page is open. Enable "Allow access to file URLs", then come back and click "Recheck".',
    openedShortcuts: 'The shortcut settings page is open. Confirm that "用氛圍閱讀翻譯目前分頁的 PDF" is set to Alt+T, or choose another shortcut.',
    cannotCheckFileAccess: `${BROWSER.name} cannot report the current state. Please confirm that "Allow access to file URLs" is enabled in extension settings.`,
    fileAccessAllowed: 'File URL access is enabled. Local PDFs can be opened.',
    fileAccessDenied: 'File URL access is not enabled yet. Local PDFs need this permission.',
    shortcutAssigned: shortcut => `Current shortcut: ${shortcut}`,
    shortcutMissing: `No shortcut is currently assigned. Open ${BROWSER.name} shortcut settings to assign Alt+T, or disable another extension that already uses Alt+T.`,
    shortcutUnknown: `${BROWSER.name} cannot report the shortcut state. Please confirm it in shortcut settings.`,
    noPdfWelcomeStatus: 'After setup, open a PDF tab, then click the extension icon or context menu.',
    aiLabel: 'Built-in browser AI',
    checkingAiTranslate: 'Checking translation...',
    checkingAiPrompt: 'Checking AI Summary / Ask AI...',
    openFlags: 'Open flags',
    aiTranslate: {
      available: 'Translation: ready ✓',
      downloadable: 'Translation: ready; a language pack downloads on first use',
      unavailable: 'Translation: not supported for this target language or device',
      missing: 'Translation: not available',
    },
    aiTranslateLocal: mb => `Translation: using the local translation model (about ${mb}MB downloads on first use)`,
    aiPrompt: {
      available: 'AI Summary / Ask AI: ready ✓',
      downloadable: 'AI Summary / Ask AI: ready; the model (several GB) downloads on first use',
      unavailable: 'AI Summary / Ask AI: currently unavailable',
      missing: 'AI Summary / Ask AI: not enabled',
    },
    guide: {
      edge: {
        translateMissing: 'Update Edge to version 148 or later (edge://settings/help) to use translation.',
        translateUnavailable: 'Try another target language; Edge downloads translation models per language pair.',
        promptMissing: 'Edge Stable does not offer AI Summary / Ask AI yet (translation is unaffected). To use them:\n1. Install Edge Canary or Dev (microsoft.com/edge/download/insider)\n2. In edge://flags, search for "Prompt API for on-device language model" and set it to Enabled\n3. Restart Edge, then come back and click "Recheck"',
        promptUnavailable: 'Translation is unaffected. There are two likely causes:\n1. You are on Edge Stable: this feature is only available in Edge Canary / Dev (Device performance class in edge://on-device-internals stays at Loading)\n2. You are on Canary / Dev but the hardware is not enough: the default model needs about 5.5GB of VRAM; on Edge 150+, enable "Enable prerelease on-device language model" in edge://flags to use a smaller model that can run on the CPU',
      },
      chrome: {
        translateMissing: 'Update Chrome to version 138 or later (chrome://settings/help) to use translation.',
        translateUnavailable: 'Try another target language; Chrome downloads translation models per language pair.',
        promptMissing: 'AI Summary / Ask AI need Gemini Nano (translation is unaffected). To use them:\n1. In chrome://flags, search for "Prompt API for Gemini Nano" and set it to Enabled\n2. Restart Chrome\n3. Update "Optimization Guide On Device Model" in chrome://components, then come back and click "Recheck"',
        promptUnavailable: 'Gemini Nano needs more than 4GB of VRAM (or 16GB RAM + 4 CPU cores) and at least 22GB of free disk space (translation is unaffected). See chrome://on-device-internals for details.',
      },
    },
  },
};

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  try { els.appVer.textContent = 'v' + chrome.runtime.getManifest().version; } catch (_) {}
  document.querySelectorAll('.llm-name').forEach(el => { el.textContent = BROWSER.llm; });
  await populateTargetSelect();
  setupFontControl();
  setupPdfDark();
  setupDivider();
  setupSelectionAsk();
  setupReverseLocate();
  setupZoom();
  setupKeyboardScroll();

  els.translateBtn.addEventListener('click', () => startTranslation(true));
  els.stopBtn.addEventListener('click', () => {
    abortCtrl?.abort();
    setStatus('已停止');
    swapButtons(false);
  });
  els.targetLang.addEventListener('change', async () => {
    chrome.storage.local.set({ targetLang: els.targetLang.value });
    await checkAI();
  });

  const params = new URLSearchParams(location.search);
  pdfUrl = params.get('file');
  const isWelcome = params.get('welcome') === '1';
  await setupFirstRunPrompt(isWelcome);

  await checkAI();

  setupOpenFile();

  if (!pdfUrl) {
    showOpenFilePrompt();
    setStatus(isWelcome
      ? welcomeText.noPdfWelcomeStatus
      : '未指定 PDF。請選擇 PDF 檔案，或開啟一個 PDF 分頁後點擊插件圖示。');
    return;
  }

  showPdfSource();
  await openPdf(async () => {
    const resp = await fetch(pdfUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}（若為本機檔案，請到 ${BROWSER.scheme}://extensions 開啟「允許存取檔案網址」）`);
    return resp.arrayBuffer();
  });
});

async function openPdf(loadBuffer) {
  try {
    await loadAndRenderPdf(loadBuffer);
    detectedSource = await detectSourceLang(paragraphs.slice(0, 5).map(p => p.text).join(' ').slice(0, 1000));
    els.srcLangInfo.textContent = `偵測來源：${detectedSource}`;
    els.translateBtn.disabled = false;
    setStatus('PDF 已載入');
    // Requirement 4 — auto start translation
    if (!els.translateBtn.disabled) startTranslation(false);
  } catch (e) {
    showError('載入 PDF 失敗：' + e.message);
    setStatus('載入失敗');
  }
}

// ─── Open a PDF file from the device ────────────────────────────────────────────
// The way in on mobile, where PDFs are downloads (content:// URIs the extension
// can't fetch), and handy on desktop without file-URL access.
function setupOpenFile() {
  els.openFileBtn.addEventListener('click', () => {
    // One PDF per viewer: a loaded viewer opens a fresh one for the next file.
    if (pdfDoc) chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') });
    else els.fileInput.click();
  });
  els.fileInput.addEventListener('change', () => {
    const file = els.fileInput.files?.[0];
    if (file) openPdfFile(file);
  });
  document.addEventListener('dragover', (e) => { if (!pdfDoc) e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    if (pdfDoc) return;
    e.preventDefault();
    const file = [...(e.dataTransfer?.files || [])].find(f => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name));
    if (file) openPdfFile(file);
  });
}

function showOpenFilePrompt() {
  els.pdfInner.innerHTML = `
    <div class="open-pdf">
      <div class="open-pdf-icon">📄</div>
      <button type="button" class="btn btn-primary open-pdf-btn">📂 選擇 PDF 檔案</button>
      <p>或把 PDF 拖曳到這裡</p>
    </div>`;
  els.pdfInner.querySelector('.open-pdf-btn').addEventListener('click', () => els.fileInput.click());
}

function openPdfFile(file) {
  if (pdfDoc) return;
  pdfUrl = null;
  clearError();
  els.pdfSource.textContent = `📁 本機檔案：${file.name}`;
  els.pdfSource.title = file.name;
  els.pdfSource.onclick = null;
  document.title = `[氛圍閱讀] ${file.name}`;
  openPdf(() => file.arrayBuffer());
}

function populateTargetSelect() {
  fillLangSelect(els.targetLang);
  els.targetLang.value = browserDefaultTarget();
  return storageGet('targetLang').then(({ targetLang }) => {
    els.targetLang.value = targetLang || browserDefaultTarget();
  });
}

function fillLangSelect(selectEl) {
  selectEl.innerHTML = TARGET_LANGS
    .map(t => `<option value="${t.code}">${t.name}</option>`).join('');
}

function storageGet(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

async function setupFirstRunPrompt(showWelcome) {
  welcomeText = getWelcomeText();
  applyWelcomeText(welcomeText);
  fillLangSelect(els.welcomeTargetLang);
  const { targetLang } = await storageGet('targetLang');
  els.welcomeTargetLang.value = targetLang || browserDefaultTarget();

  els.welcomeTargetLang.addEventListener('change', () => {
    els.targetLang.value = els.welcomeTargetLang.value;
    chrome.storage.local.set({ targetLang: els.welcomeTargetLang.value });
    checkAI();
    refreshAiStatus();
  });
  els.welcomeEngine.value = await enginePreference();
  els.welcomeEngine.addEventListener('change', async () => {
    await chrome.storage.local.set({ engine: els.welcomeEngine.value });
    translatorObj = null;   // the next translation picks the new engine
    clearError();
    checkAI();
    refreshAiStatus();
  });
  els.welcomeDone.addEventListener('click', saveWelcomeSettings);
  els.welcomeClose.addEventListener('click', saveWelcomeSettings);
  els.settingsBtn.addEventListener('click', openWelcomeSettings);
  els.welcomeRecheck.addEventListener('click', refreshFileAccessStatus);
  els.welcomeOpenShortcuts.addEventListener('click', () => {
    chrome.tabs.create({ url: `${BROWSER.scheme}://extensions/shortcuts` });
    els.shortcutStatus.textContent = welcomeText.openedShortcuts;
    els.shortcutStatus.className = 'file-access-status warn';
  });
  els.welcomeOpenExt.addEventListener('click', () => {
    chrome.tabs.create({ url: `${BROWSER.scheme}://extensions/?id=${chrome.runtime.id}` });
    els.fileAccessStatus.textContent = welcomeText.openedExtensions;
    els.fileAccessStatus.className = 'file-access-status warn';
  });
  els.welcomeAiRecheck.addEventListener('click', refreshAiStatus);
  els.welcomeOpenFlags.addEventListener('click', () => {
    // Edge's flag slug isn't documented, so open the page and let the guide
    // text name the flag to search for.
    chrome.tabs.create({ url: BROWSER.scheme === 'edge'
      ? 'edge://flags'
      : 'chrome://flags/#prompt-api-for-gemini-nano' });
  });

  if (showWelcome) {
    els.targetLang.value = els.welcomeTargetLang.value;
    els.welcomeModal.style.display = 'flex';
    refreshAiStatus();
    refreshFileAccessStatus();
    refreshShortcutStatus();
  }
}

function openWelcomeSettings() {
  els.welcomeTargetLang.value = els.targetLang.value || browserDefaultTarget();
  els.welcomeModal.style.display = 'flex';
  refreshAiStatus();
  refreshFileAccessStatus();
  refreshShortcutStatus();
}

// ─── First-run AI capability check ───────────────────────────────────────────────
// Each probe resolves to 'available' | 'downloadable' | 'unavailable' | 'missing'
// ('missing' = the API isn't exposed at all, i.e. browser too old or flag off).
async function probeTranslator(target) {
  if (!('Translator' in self)) return 'missing';
  const source = target === 'en' ? 'fr' : 'en';
  try {
    const a = await Translator.availability({ sourceLanguage: source, targetLanguage: target });
    return a === 'downloading' ? 'downloadable' : a;
  } catch (_) {
    return 'unavailable';
  }
}

async function probePrompt() {
  if (!('LanguageModel' in self)) return 'missing';
  try {
    const a = await lmAvailability();
    return a === 'downloading' ? 'downloadable' : a;
  } catch (_) {
    return 'unavailable';
  }
}

const AI_RANK = { available: 3, downloadable: 2, unavailable: 1, missing: 0 };

async function refreshAiStatus() {
  const t = welcomeText;
  els.aiTranslateStatus.textContent = t.checkingAiTranslate;
  els.aiTranslateStatus.className = 'file-access-status';
  els.aiPromptStatus.textContent = t.checkingAiPrompt;
  els.aiPromptStatus.className = 'file-access-status';

  const target = els.welcomeTargetLang.value || browserDefaultTarget();
  const [translator, prompt] = await Promise.all([probeTranslator(target), probePrompt()]);
  // Translation falls back to the Prompt API, so it works if either engine does.
  const translate = AI_RANK[translator] >= AI_RANK[prompt] ? translator : prompt;

  const okish = s => s === 'available' || s === 'downloadable';
  const forceLocal = await enginePreference() === 'local';
  const local = okish(translate) && !forceLocal ? null : await localStatus(target === 'en' ? 'fr' : 'en', target);
  if (local?.supported) {
    els.aiTranslateStatus.textContent = t.aiTranslateLocal(local.sizeMB);
    els.aiTranslateStatus.className = 'file-access-status ok';
  } else if (forceLocal) {
    els.aiTranslateStatus.textContent = t.aiTranslate.unavailable;
    els.aiTranslateStatus.className = 'file-access-status warn';
  } else {
    els.aiTranslateStatus.textContent = t.aiTranslate[translate];
    els.aiTranslateStatus.className = `file-access-status ${okish(translate) ? 'ok' : 'warn'}`;
  }
  els.aiPromptStatus.textContent = t.aiPrompt[prompt];
  els.aiPromptStatus.className = `file-access-status ${okish(prompt) ? 'ok' : 'warn'}`;

  const g = t.guide[BROWSER.scheme === 'edge' ? 'edge' : 'chrome'];
  const tips = [];
  if (local?.supported) { /* the local model covers translation */ }
  else if (translate === 'missing') tips.push(g.translateMissing);
  else if (translate === 'unavailable') tips.push(g.translateUnavailable);
  if (prompt === 'missing') tips.push(g.promptMissing);
  else if (prompt === 'unavailable') tips.push(g.promptUnavailable);

  els.aiGuide.textContent = tips.join('\n\n');
  els.aiGuide.hidden = tips.length === 0;
  els.welcomeOpenFlags.hidden = prompt !== 'missing' &&
    !(prompt === 'unavailable' && BROWSER.scheme === 'edge');
}

function saveWelcomeSettings() {
  const targetLang = els.welcomeTargetLang.value || browserDefaultTarget();
  els.targetLang.value = targetLang;
  chrome.storage.local.set({ targetLang, firstRunSetupDone: true });
  els.welcomeModal.style.display = 'none';
  checkAI();
}

function refreshFileAccessStatus() {
  if (!chrome.extension?.isAllowedFileSchemeAccess) {
    els.fileAccessStatus.textContent = welcomeText.cannotCheckFileAccess;
    els.fileAccessStatus.className = 'file-access-status warn';
    return;
  }
  chrome.extension.isAllowedFileSchemeAccess((allowed) => {
    els.fileAccessStatus.textContent = allowed
      ? welcomeText.fileAccessAllowed
      : welcomeText.fileAccessDenied;
    els.fileAccessStatus.className = `file-access-status ${allowed ? 'ok' : 'warn'}`;
  });
}

function refreshShortcutStatus() {
  if (!chrome.commands?.getAll) {
    els.shortcutStatus.textContent = welcomeText.shortcutUnknown;
    els.shortcutStatus.className = 'file-access-status warn';
    return;
  }
  chrome.commands.getAll((commands) => {
    const command = commands.find(c => c.name === 'translate-pdf');
    const shortcut = command?.shortcut || '';
    els.shortcutStatus.textContent = shortcut
      ? welcomeText.shortcutAssigned(shortcut)
      : welcomeText.shortcutMissing;
    els.shortcutStatus.className = `file-access-status ${shortcut ? 'ok' : 'warn'}`;
  });
}

function getWelcomeText() {
  const langs = (navigator.languages?.length ? navigator.languages : [navigator.language || 'en'])
    .map(l => String(l).toLowerCase());
  return langs.some(l => l.startsWith('zh')) ? WELCOME_TEXT['zh-TW'] : WELCOME_TEXT.en;
}

function applyWelcomeText(text) {
  els.welcomeModal.lang = text.lang;
  els.welcomeKicker.textContent = text.kicker;
  els.welcomeTitle.textContent = text.title;
  els.welcomeClose.title = text.closeTitle;
  els.settingsBtn.title = text.settingsTitle;
  els.welcomeLangLabel.textContent = text.targetLabel;
  els.welcomeLangCopy.textContent = text.targetCopy;
  els.welcomeEngineLabel.textContent = text.engineLabel;
  els.welcomeEngine.options[0].textContent = text.engineAuto;
  els.welcomeEngine.options[1].textContent = text.engineLocal;
  els.welcomeEngineCopy.textContent = text.engineCopy;
  els.welcomeFileLabel.textContent = text.fileLabel;
  els.welcomeFileCopy.textContent = text.fileCopy;
  els.welcomeShortcutLabel.textContent = text.shortcutLabel;
  els.welcomeShortcutCopy.textContent = text.shortcutCopy;
  els.fileAccessStatus.textContent = text.checkingFileAccess;
  els.shortcutStatus.textContent = text.checkingShortcut;
  els.welcomeOpenExt.textContent = text.openExtensions;
  els.welcomeOpenShortcuts.textContent = text.openShortcuts;
  els.welcomeRecheck.textContent = text.recheck;
  els.welcomeDone.textContent = text.done;
  els.welcomeAiLabel.textContent = text.aiLabel;
  els.aiTranslateStatus.textContent = text.checkingAiTranslate;
  els.aiPromptStatus.textContent = text.checkingAiPrompt;
  els.welcomeOpenFlags.textContent = text.openFlags;
  els.welcomeAiRecheck.textContent = text.recheck;
}

// ─── Translation font-size control (persisted) ──────────────────────────────────
const FONT_MIN = 10, FONT_MAX = 26, FONT_DEFAULT = 13;
let transFont = FONT_DEFAULT;

function applyTransFont(px) {
  transFont = Math.max(FONT_MIN, Math.min(FONT_MAX, px));
  // set on the root so both the translation list (#results) and the
  // AI summary card (#summary, a sibling of #results) inherit it
  document.documentElement.style.setProperty('--trans-font', transFont + 'px');
  chrome.storage.local.set({ transFont });
}

// ─── PDF dark mode (persisted) ──────────────────────────────────────────────────
function applyPdfDark(on) {
  document.body.classList.toggle('pdf-dark', on);
  els.pdfDarkBtn.textContent = on ? '☀️' : '🌙';
  els.pdfDarkBtn.title = on ? '關閉 PDF 暗黑模式' : 'PDF 暗黑模式';
  els.pdfDarkBtn.setAttribute('aria-pressed', String(on));
}

function setupPdfDark() {
  chrome.storage.local.get('pdfDark', ({ pdfDark }) => applyPdfDark(!!pdfDark));
  els.pdfDarkBtn.addEventListener('click', () => {
    const on = !document.body.classList.contains('pdf-dark');
    applyPdfDark(on);
    chrome.storage.local.set({ pdfDark: on });
  });
}

function setupFontControl() {
  chrome.storage.local.get('transFont', ({ transFont: saved }) => {
    applyTransFont(saved || FONT_DEFAULT);
  });
  applyTransFont(transFont);
  els.fontDec.addEventListener('click', () => applyTransFont(transFont - 1));
  els.fontInc.addEventListener('click', () => applyTransFont(transFont + 1));
}

// ─── AI availability ──────────────────────────────────────────────────────────
async function checkAI() {
  const badge = els.aiBadge;
  badge.textContent = '偵測中...';
  badge.className = 'badge';
  const target = els.targetLang.value;
  const forceLocal = await enginePreference() === 'local';

  if (!forceLocal && 'Translator' in self) {
    try {
      const a = await Translator.availability({ sourceLanguage: 'en', targetLanguage: target });
      if (a !== 'unavailable') { badge.textContent = 'Translator API ✓'; badge.className = 'badge badge-ok'; return; }
    } catch (_) {}
  }
  if (!forceLocal && 'LanguageModel' in self) {
    try {
      const a = await lmAvailability();
      if (a !== 'unavailable') { badge.textContent = `${BROWSER.llm} ✓`; badge.className = 'badge badge-ok'; return; }
    } catch (_) {}
  }

  const local = await localStatus(detectedSource, target);
  if (local.supported) {
    badge.textContent = local.downloaded ? '本機翻譯模型 ✓' : `本機翻譯模型（首次下載約 ${local.sizeMB}MB）`;
    badge.className = 'badge badge-ok';
    return;
  }
  if (forceLocal) {
    badge.textContent = '本機模型不支援此語言';
    badge.className = 'badge badge-err';
    els.translateBtn.disabled = true;
    showError(`本機翻譯模型不支援翻譯成「${langName(target)}」。可改選其他目標語言，或到設定把翻譯引擎改回「自動」。`);
    return;
  }

  badge.textContent = 'AI 不可用';
  badge.className = 'badge badge-err';
  els.translateBtn.disabled = true;
  showError(BROWSER.scheme === 'edge'
    ? 'Edge 內建 AI 無法使用。請確認：\n' +
      '1. Edge 版本 ≥ 148（翻譯與語言偵測）\n' +
      '2. AI 摘要與反白問答目前僅 Edge Canary / Dev 提供：到 edge://flags 啟用「Prompt API for on-device language model」\n' +
      '3. 重新啟動 Edge'
    : 'Chrome 內建 AI 無法使用。請確認：\n' +
      '1. Chrome 版本 ≥ 138\n' +
      '2. chrome://flags 啟用「Prompt API」與「Translator API」\n' +
      '3. chrome://components 更新「Optimization Guide On Device Model」\n' +
      '4. 重新啟動 Chrome'
  );
}

function isDownloadGestureError(err) {
  return err?.name === 'ModelDownloadNeedsUserGesture' ||
    /Requires a user gesture/i.test(err?.message || '');
}

// ─── PDF source chip + tab title ─────────────────────────────────────────────────
function showPdfSource() {
  const isFile = /^file:/i.test(pdfUrl);
  const fname  = decodeURIComponent(pdfUrl.split('/').pop().split('?')[0]) || pdfUrl;
  els.pdfSource.textContent = isFile ? `📁 本機檔案：${fname}` : `🌐 ${pdfUrl}`;
  els.pdfSource.title = pdfUrl;
  els.pdfSource.onclick = () => window.open(pdfUrl, '_blank');
  document.title = `[氛圍閱讀] ${fname}`;   // provisional; refined after metadata loads
}

// ─── Load & render PDF (canvas + selectable text layer) ─────────────────────────
let baseScale = 1;   // fit-to-width scale
let zoom      = 1;   // user zoom multiplier

async function loadAndRenderPdf(loadBuffer) {
  setStatus(pdfUrl ? '下載 PDF 檔案...' : '讀取 PDF 檔案...');
  setIndeterminate(true);
  els.progressWrap.style.display = 'flex';

  const buf = await loadBuffer();
  setIndeterminate(false);

  pdfDoc = await PDFJS.getDocument({ data: buf }).promise;

  // Tab title = [氛圍閱讀] <PDF metadata title, else filename>
  try {
    const meta = await pdfDoc.getMetadata();
    const docTitle = meta?.info?.Title?.trim();
    if (docTitle) document.title = `[氛圍閱讀] ${docTitle}`;
  } catch (_) {}

  // fit-to-width base scale
  const firstPage = await pdfDoc.getPage(1);
  const base = firstPage.getViewport({ scale: 1 });
  const paneW = els.pdfPane.clientWidth - 48;
  baseScale = Math.max(0.5, Math.min(2.5, paneW / base.width));
  zoom = 1;
  renderScale = baseScale * zoom;

  paragraphs = [];
  await renderPages(true);
  paragraphs = refineParagraphs(paragraphs);
  updateZoomLabel();
}

// Render (or re-render) every page at the current renderScale.
// Paragraphs are only extracted on the first pass (their rects are in
// scale-independent PDF coordinates, so zooming doesn't require recompute).
async function renderPages(computeParagraphs) {
  const dpr = window.devicePixelRatio || 1;
  const total = pdfDoc.numPages;
  els.pdfInner.innerHTML = '';
  for (const k in pageWraps) delete pageWraps[k];

  for (let p = 1; p <= total; p++) {
    setStatus(`渲染第 ${p} / ${total} 頁`);
    setProgress(p / total, `${p}/${total} 頁`);

    const page     = await pdfDoc.getPage(p);
    const viewport = page.getViewport({ scale: renderScale });
    const renderVp = page.getViewport({ scale: renderScale * dpr });

    const wrap = document.createElement('div');
    wrap.className = 'page-wrap';
    wrap.dataset.page = p;
    wrap.style.width  = viewport.width + 'px';
    wrap.style.height = viewport.height + 'px';

    const canvas = document.createElement('canvas');
    canvas.width  = renderVp.width;
    canvas.height = renderVp.height;
    canvas.style.width  = viewport.width + 'px';
    canvas.style.height = viewport.height + 'px';
    wrap.appendChild(canvas);
    els.pdfInner.appendChild(wrap);

    const content = await page.getTextContent();
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: renderVp }).promise;

    // Transparent text layer for native text selection (requirement 6).
    // pdf.js 3.x positions the spans via the CSS var --scale-factor; without it
    // the spans collapse to zero size and the text becomes unselectable.
    const textLayer = document.createElement('div');
    textLayer.className = 'textLayer';
    textLayer.style.width  = viewport.width + 'px';
    textLayer.style.height = viewport.height + 'px';
    textLayer.style.setProperty('--scale-factor', renderScale);
    wrap.appendChild(textLayer);
    try {
      await PDFJS.renderTextLayer({ textContentSource: content, container: textLayer, viewport, textDivs: [] }).promise;
    } catch (e) {
      console.warn('[PDF翻譯] 文字層渲染失敗（不影響翻譯）：', e);
    }

    pageWraps[p] = {
      wrap, canvas, textLayer, viewport,
      w1: viewport.width  / renderScale,   // intrinsic (scale-1) dimensions
      h1: viewport.height / renderScale,
    };

    if (computeParagraphs) {
      const regions = await detectLayout(canvas, renderVp, p, total);
      for (const para of extractParagraphs(content.items, regions)) {
        paragraphs.push({ page: p, text: para.text, rect: para.rect, kind: para.kind });
      }
    }
  }
}

// Run the layout model on a rendered page and map its boxes from canvas pixels
// to PDF coordinates. Returns null (→ geometric segmentation) if unavailable.
let layoutDisabled = false;
async function detectLayout(canvas, renderVp, p, total) {
  if (layoutDisabled || !window.VibeLayout) return null;
  setStatus(`版面分析第 ${p} / ${total} 頁`);
  try {
    const boxes = await window.VibeLayout.detect(canvas);
    if (!boxes) { layoutDisabled = true; return null; }
    return boxes.map(b => {
      const [ax, ay] = renderVp.convertToPdfPoint(b.x0, b.y0);
      const [bx, by] = renderVp.convertToPdfPoint(b.x1, b.y1);
      return { label: b.label, score: b.score,
               x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
    });
  } catch (e) {
    console.warn('[氛圍閱讀] 版面分析失敗，改用規則分段：', e);
    return null;
  }
}

// ─── Zoom (independent of browser page zoom) ─────────────────────────────────────
let rerenderT = null;

function updateZoomLabel() {
  if (els.zoomLabel) els.zoomLabel.textContent = Math.round(zoom * 100) + '%';
}

// Zoom around a focal point. The anchor is captured as a specific PAGE plus a
// fraction within that page (measured from real element rects), so the constant
// inter-page gaps/padding don't distort it — after re-render the same page point
// is placed back under the focal Y. Fixes both figure drift and wrong-page jumps.
function setZoom(z, focalClientY) {
  if (!pdfDoc) return;
  const fcY = (focalClientY != null)
    ? focalClientY
    : els.pdfPane.getBoundingClientRect().top + els.pdfPane.clientHeight / 2;

  // capture which page + intra-page fraction sits at the focal Y (old layout)
  let anchorPage = null, anchorFy = 0.5;
  for (const k in pageWraps) {
    const r = pageWraps[k].wrap.getBoundingClientRect();
    if (fcY >= r.top && fcY <= r.bottom) { anchorPage = Number(k); anchorFy = (fcY - r.top) / r.height; break; }
  }
  if (anchorPage == null) {              // focal in a gap → use nearest page centre
    let bd = Infinity;
    for (const k in pageWraps) {
      const r = pageWraps[k].wrap.getBoundingClientRect();
      const d = Math.abs((r.top + r.bottom) / 2 - fcY);
      if (d < bd) { bd = d; anchorPage = Number(k); anchorFy = 0.5; }
    }
  }

  zoom = Math.max(0.4, Math.min(4, z));
  renderScale = baseScale * zoom;
  updateZoomLabel();

  // 1) Instant, smooth: stretch existing canvases via CSS and rescale the text
  //    layer through --scale-factor (its span positions are in scale-1 units,
  //    so they follow the variable). No re-rasterising → no flash, no lag.
  applyDisplayScale(renderScale);
  anchorScroll(anchorPage, anchorFy, fcY);

  // 2) After the gesture settles, re-rasterise in place to sharpen (no DOM
  //    rebuild → no flash, no scroll jump). Visible pages are sharpened first.
  clearTimeout(rerenderT);
  rerenderT = setTimeout(() => sharpenPages(), 200);
}

let sharpenGen = 0;
async function sharpenPages() {
  if (!pdfDoc) return;
  const gen = ++sharpenGen;
  const dpr = window.devicePixelRatio || 1;

  // order: pages currently in view first, then the rest
  const paneRect = els.pdfPane.getBoundingClientRect();
  const vis = [], rest = [];
  for (let p = 1; p <= pdfDoc.numPages; p++) {
    const pg = pageWraps[p]; if (!pg) continue;
    const r = pg.wrap.getBoundingClientRect();
    (r.bottom > paneRect.top && r.top < paneRect.bottom ? vis : rest).push(p);
  }

  for (const p of vis.concat(rest)) {
    if (gen !== sharpenGen) return;           // a newer zoom superseded us
    const pg = pageWraps[p]; if (!pg) continue;
    const page = await pdfDoc.getPage(p);
    if (gen !== sharpenGen) return;
    const sc = renderScale;
    const renderVp = page.getViewport({ scale: sc * dpr });
    pg.canvas.width  = renderVp.width;
    pg.canvas.height = renderVp.height;
    pg.canvas.style.width  = (pg.w1 * sc) + 'px';
    pg.canvas.style.height = (pg.h1 * sc) + 'px';
    await page.render({ canvasContext: pg.canvas.getContext('2d'), viewport: renderVp }).promise;
    pg.viewport = page.getViewport({ scale: sc });   // keep locate()/zoom anchor accurate
  }
}

// Live CSS resize of all pages (cheap; bitmap is GPU-scaled until re-rasterised)
function applyDisplayScale(scale) {
  for (const k in pageWraps) {
    const pg = pageWraps[k];
    const w = pg.w1 * scale, h = pg.h1 * scale;
    pg.wrap.style.width = w + 'px';
    pg.wrap.style.height = h + 'px';
    if (pg.canvas) { pg.canvas.style.width = w + 'px'; pg.canvas.style.height = h + 'px'; }
    if (pg.textLayer) {
      pg.textLayer.style.width = w + 'px';
      pg.textLayer.style.height = h + 'px';
      pg.textLayer.style.setProperty('--scale-factor', scale);
    }
  }
}

// Keep a given page + intra-page fraction anchored under the focal screen Y
function anchorScroll(page, fy, fcY) {
  const pg = pageWraps[page];
  if (!pg) return;
  const r = pg.wrap.getBoundingClientRect();
  els.pdfPane.scrollTop += (r.top + fy * r.height) - fcY;
}

function setupZoom() {
  els.zoomIn.addEventListener('click', () => setZoom(zoom * 1.2));
  els.zoomOut.addEventListener('click', () => setZoom(zoom / 1.2));
  els.zoomFit.addEventListener('click', () => setZoom(1));
  // Ctrl+wheel / trackpad pinch zooms ONLY the PDF pane (preventDefault stops
  // the browser from zooming the whole page), anchored at the cursor.
  els.pdfPane.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientY);
  }, { passive: false });
}

// Arrow keys / PageUp-Down / Home-End scroll the PDF pane (the div has no native
// keyboard scrolling like Chrome's built-in viewer does).
function setupKeyboardScroll() {
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (els.askModal.style.display !== 'none') return;   // modal/Esc handles its own keys

    const pane = els.pdfPane;
    const line = 90, page = pane.clientHeight * 0.9;
    switch (e.key) {
      case 'ArrowDown':  pane.scrollTop += line; break;
      case 'ArrowUp':    pane.scrollTop -= line; break;
      case 'ArrowRight': gotoPage(1);  break;   // next page
      case 'ArrowLeft':  gotoPage(-1); break;   // previous page
      case 'PageDown':   pane.scrollTop += page; break;
      case 'PageUp':     pane.scrollTop -= page; break;
      case 'Home':       pane.scrollTop  = 0; break;
      case 'End':        pane.scrollTop  = pane.scrollHeight; break;
      default: return;
    }
    e.preventDefault();
  });
}

// Jump to the previous/next page (←/→), like the native PDF viewer
function gotoPage(delta) {
  if (!pdfDoc) return;
  const paneTop = els.pdfPane.getBoundingClientRect().top;
  let curr = 1;
  for (let p = 1; p <= pdfDoc.numPages; p++) {
    const pg = pageWraps[p];
    if (pg && pg.wrap.getBoundingClientRect().bottom > paneTop + 4) { curr = p; break; }
  }
  const target = Math.max(1, Math.min(pdfDoc.numPages, curr + delta));
  const tr = pageWraps[target]?.wrap.getBoundingClientRect();
  if (tr) els.pdfPane.scrollBy({ top: (tr.top - paneTop) - 8, behavior: 'smooth' });
}

// Layout labels (see layout.js) whose text we translate, and those whose text
// is dropped (figures, tables, formulas, running headers/footers, page numbers).
// 'content' (table of contents) is skipped: in papers the model mostly fires on
// code listings with it.
const LAYOUT_TEXT = new Set(['text', 'abstract', 'reference', 'footnote', 'paragraph_title',
  'doc_title', 'figure_title', 'table_title', 'chart_title']);
const LAYOUT_SKIP = new Set(['image', 'chart', 'table', 'formula', 'formula_number', 'header',
  'footer', 'number', 'seal', 'header_image', 'footer_image', 'algorithm', 'aside_text', 'content']);
const LAYOUT_TEXT_MIN = 0.5;   // a text box must be fairly confident to claim items
const LAYOUT_SKIP_MIN = 0.3;   // figures/tables are often scored lower; text boxes still win

// items: pdf.js text items. regions (optional): layout boxes in PDF coordinates
// { label, score, x0, y0, x1, y1 } with y0 < y1. Returns [{ text, rect, kind }].
function extractParagraphs(items, regions) {
  // Keep non-empty, horizontal text only — drop rotated items such as the
  // vertical "arXiv:…" watermark, which otherwise corrupts margin/column geometry.
  const its = items.filter(it =>
    it.str.trim() &&
    Math.abs(it.transform[1]) < 2 && Math.abs(it.transform[2]) < 2);
  if (!its.length) return [];
  if (!regions || !regions.length) return geometricParagraphs(its, 'text');

  const textBoxes = regions.filter(r => LAYOUT_TEXT.has(r.label) && r.score >= LAYOUT_TEXT_MIN);
  const skipBoxes = regions.filter(r => LAYOUT_SKIP.has(r.label) && r.score >= LAYOUT_SKIP_MIN);
  // Text boxes are padded outward to catch items on their edges; skip boxes
  // are shrunk inward, since a figure/code box often overhangs the first line
  // of the paragraph below it.
  const contains = (r, x, y, pad) => x >= r.x0 - pad && x <= r.x1 + pad && y >= r.y0 - pad && y <= r.y1 + pad;
  const area = r => (r.x1 - r.x0) * (r.y1 - r.y0);

  // Assign each item (by its centre) to the smallest text box containing it;
  // otherwise drop it if it sits in a figure/table/header box; otherwise leave
  // it for the geometric fallback.
  const byBox = new Map();
  const loose = [];
  const skipped = [];
  for (const it of its) {
    const cx = it.transform[4] + (it.width || 0) / 2;
    const cy = it.transform[5] + (it.height || 0) / 2;
    let best = null;
    for (const r of textBoxes) if (contains(r, cx, cy, 2) && (!best || area(r) < area(best))) best = r;
    if (best) {
      if (!byBox.has(best)) byBox.set(best, []);
      byBox.get(best).push(it);
    } else if (skipBoxes.some(r => contains(r, cx, cy, -3))) {
      skipped.push(it);
    } else {
      loose.push(it);
    }
  }
  // Losing real text is worse than letting a table row through: a line inside
  // a figure/table box that reads like running prose is kept (low-confidence
  // figure boxes sometimes overhang captions or body paragraphs).
  if (skipped.length) {
    for (const line of buildVisualLines(skipped)) if (isProseLine(line.text)) loose.push(...line.items);
  }

  // Reading units: each text box (its paragraphs in order), plus each
  // paragraph built from loose items. Then order the units by column.
  const textMinX = Math.min(...its.map(it => it.transform[4]));
  const textMaxX = Math.max(...its.map(it => it.transform[4] + (it.width || 0)));
  const units = [];
  for (const [box, boxItems] of byBox) {
    // A box no wider than ~a column can't contain a gutter, so wide gaps in it
    // are justified spacing, not a column break.
    const columnWide = (box.x1 - box.x0) < (textMaxX - textMinX) * 0.6;
    const lines = buildVisualLines(boxItems, !columnWide).sort(lineCompare);
    const paras = paragraphsFromLines(lines, { references: box.label === 'reference' })
      .map(p => ({ ...p, kind: box.label }));
    if (paras.length) units.push({ x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1, paras });
  }
  for (const p of loose.length ? geometricParagraphs(loose, 'text') : []) {
    units.push({ ...p.rect, paras: [p] });
  }
  // Figures/tables take part in ordering as empty units, so a full-width
  // figure separates the column text above it from its caption below.
  for (const r of skipBoxes) {
    if (['image', 'chart', 'table', 'algorithm'].includes(r.label)) units.push({ ...r, paras: [] });
  }
  return orderUnits(units, its).flatMap(u => u.paras).map(markCaption);
}

// Sentence-like text: 8+ tokens that are mostly words and few code symbols, or
// a run of 15+ CJK characters. Figure labels and table cells are short or numeric.
function isProseLine(text) {
  const cjk = (text.match(/[㐀-鿿぀-ヿ가-힯]/g) || []).length;
  if (cjk >= 15) return true;
  const toks = text.split(/\s+/).filter(Boolean);
  if (toks.length < 8) return false;
  const wordy = toks.filter(t => /^[(“"‘']?[A-Za-z][A-Za-z'’-]*[.,;:)”"’]*$/.test(t)).length;
  const codey = (text.match(/[=<>{}$\\|`]|::|->|=>|\w_\w|"\s*:/g) || []).length;
  return wordy / toks.length >= 0.7 && codey <= 1;
}

// The model sometimes labels a caption as plain text; recognise the usual
// "Figure 2." / "Table 1:" prefixes so captions never block paragraph joins.
function markCaption(p) {
  return p.kind === 'text' && /^(Fig\.|Figure|Table|Algorithm|Listing)\s*[A-Z]?\d+[.:]/.test(p.text)
    ? { ...p, kind: 'figure_title' } : p;
}

// Pure geometric segmentation (no layout model): lines → column blocks → paragraphs.
function geometricParagraphs(its, kind) {
  // Build visual line fragments first. PDF.js may emit either whole-line items
  // or word/run-level items; column detection on raw items is therefore brittle.
  const lines = buildVisualLines(its);
  if (!lines.length) return [];

  const out = [];
  for (const block of readingBlocksFromLines(lines)) out.push(...paragraphsFromLines(block));
  return out.map(p => markCaption({ ...p, kind }));
}

// Reading order for layout units ({ x0, y0, x1, y1 } in PDF coordinates, y up):
// full-width units split the page into zones; inside a zone the left column is
// read top-to-bottom before the right column.
function orderUnits(units, its) {
  const minX = Math.min(...its.map(it => it.transform[4]));
  const maxX = Math.max(...its.map(it => it.transform[4] + (it.width || 0)));
  const mid = (minX + maxX) / 2;
  const tol = (maxX - minX) * 0.03;
  const col = u => (u.x0 < mid - tol && u.x1 > mid + tol) ? 'full'
    : ((u.x0 + u.x1) / 2 < mid ? 'left' : 'right');
  const byTop = (a, b) => b.y1 - a.y1;

  const out = [];
  let zone = [];
  const flush = () => {
    out.push(...zone.filter(u => col(u) === 'left').sort(byTop),
             ...zone.filter(u => col(u) === 'right').sort(byTop));
    zone = [];
  };
  for (const u of units.slice().sort(byTop)) {
    if (col(u) === 'full') { flush(); out.push(u); }
    else zone.push(u);
  }
  flush();
  return out;
}

function lineCompare(a, b) {
  const dy = b.y - a.y;
  return Math.abs(dy) > 2 ? dy : a.startX - b.startX;
}

function median(nums) {
  if (!nums.length) return 0;
  const a = nums.slice().sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

// Median of [value, weight] pairs.
function weightedMedian(pairs) {
  const a = pairs.filter(p => p[1] > 0).sort((x, y) => x[0] - y[0]);
  const total = a.reduce((s, p) => s + p[1], 0);
  let acc = 0;
  for (const [v, w] of a) { acc += w; if (acc >= total / 2) return v; }
  return a.length ? a[a.length - 1][0] : 0;
}

function makeLine(items, fallbackY) {
  const sorted = items.slice().sort((a, b) => a.transform[4] - b.transform[4]);
  const starts  = sorted.map(it => it.transform[4]);
  const ends    = sorted.map(it => it.transform[4] + (it.width || 0));
  // Weight baseline and glyph height by character count: a superscript like
  // "day⁻¹" arrives as several tiny items and, with a plain median, drags the
  // line's y up and its fontH down — which then reads as a paragraph break.
  const weight = it => Math.max(1, it.str.trim().length);
  return {
    y: weightedMedian(sorted.map(it => [it.transform[5], weight(it)])) || fallbackY,
    startX: Math.min(...starts),
    endX: Math.max(...ends),
    fontH: weightedMedian(sorted.map(it => [it.height || 10, weight(it)])) || 10,
    items: sorted,
    text: sorted.map(it => it.str).join(' ').replace(/\s+/g, ' ').trim(),
  };
}

// Join wrapped lines; a line ending in a hyphenated word fragment ("pre-")
// continues the word without a space.
function joinLines(texts) {
  let out = '';
  for (const t of texts) {
    if (!out) out = t;
    else if (/[a-z]-$/.test(out) && /^[a-z]/.test(t)) out += t;
    else out += ' ' + t;
  }
  return out.replace(/\s+/g, ' ').trim();
}

// splitGaps: cut a row into separate line fragments at wide horizontal gaps
// (column gutters). Off for text inside a single-column layout box, where a
// wide gap is just justified spacing (e.g. after "tasks.  However,").
function buildVisualLines(its, splitGaps = true) {
  const fontH = median(its.map(it => it.height || 10)) || 10;
  const rowTolerance = Math.max(3, fontH * 0.45);
  const sorted = its.slice().sort((a, b) => {
    const dy = b.transform[5] - a.transform[5];
    return Math.abs(dy) > rowTolerance ? dy : a.transform[4] - b.transform[4];
  });

  const rows = [];
  let row = { y: sorted[0].transform[5], items: [sorted[0]] };
  for (let i = 1; i < sorted.length; i++) {
    const y = sorted[i].transform[5];
    if (Math.abs(y - row.y) <= rowTolerance) row.items.push(sorted[i]);
    else { rows.push(row); row = { y, items: [sorted[i]] }; }
  }
  rows.push(row);

  const minX = Math.min(...its.map(it => it.transform[4]));
  const maxX = Math.max(...its.map(it => it.transform[4] + (it.width || 0)));
  const pageW = maxX - minX;
  const gapThreshold = splitGaps ? Math.max(12, fontH * 1.15, pageW * 0.022) : Infinity;

  const lines = [];
  for (const r of rows) {
    const rowItems = r.items.slice().sort((a, b) => a.transform[4] - b.transform[4]);
    let frag = [rowItems[0]];
    let lastEnd = rowItems[0].transform[4] + (rowItems[0].width || 0);
    for (let i = 1; i < rowItems.length; i++) {
      const it = rowItems[i];
      const x = it.transform[4];
      const end = x + (it.width || 0);
      if (x - lastEnd > gapThreshold) {
        const line = makeLine(frag, r.y);
        if (line.text) lines.push(line);
        frag = [];
      }
      frag.push(it);
      lastEnd = Math.max(lastEnd, end);
    }
    const line = makeLine(frag, r.y);
    if (line.text) lines.push(line);
  }

  return lines.sort(lineCompare);
}

function detectTwoColumnLines(lines) {
  if (lines.length < 10) return { twoColumn: false };

  const minX = Math.min(...lines.map(l => l.startX));
  const maxX = Math.max(...lines.map(l => l.endX));
  const pageW = maxX - minX;
  if (pageW < 50) return { twoColumn: false };

  const bodyLines = lines.filter(l =>
    l.text.length >= 16 &&
    (l.endX - l.startX) > pageW * 0.18);
  if (bodyLines.length < 10) return { twoColumn: false };

  const n = bodyLines.length;
  let best = null;
  for (let gx = minX + pageW * 0.35; gx <= minX + pageW * 0.65; gx += 4) {
    let cross = 0, leftN = 0, rightN = 0;
    for (const l of bodyLines) {
      if (l.startX < gx && l.endX > gx) cross++;
      else if (l.endX <= gx) leftN++;
      else rightN++;
    }
    if (leftN > n * 0.15 && rightN > n * 0.15) {
      const score = cross + Math.abs(leftN - rightN) * 0.1;
      if (!best || score < best.score) best = { x: gx, cross, leftN, rightN, score };
    }
  }

  if (!best || best.cross > Math.max(4, n * 0.30)) return { twoColumn: false };

  const leftLines = bodyLines.filter(l => l.endX <= best.x);
  const rightLines = bodyLines.filter(l => l.startX >= best.x);
  const leftCenter = median(leftLines.map(l => (l.startX + l.endX) / 2));
  const rightCenter = median(rightLines.map(l => (l.startX + l.endX) / 2));
  if (rightCenter - leftCenter < pageW * 0.25) return { twoColumn: false };

  return { twoColumn: true, splitX: best.x, pageW };
}

function classifyLine(line, splitX, tol) {
  if (line.startX < splitX - tol && line.endX > splitX + tol) return 'full';
  return (line.startX + line.endX) / 2 < splitX ? 'left' : 'right';
}

function readingBlocksFromLines(lines) {
  const layout = detectTwoColumnLines(lines);
  if (!layout.twoColumn) return [lines.slice().sort(lineCompare)];

  const tol = Math.max(6, layout.pageW * 0.015);
  const annotated = lines
    .map(l => Object.assign({}, l, { column: classifyLine(l, layout.splitX, tol) }))
    .sort(lineCompare);

  const blocks = [];
  let zone = [];

  function flushZone() {
    if (!zone.length) return;
    const left = zone.filter(l => l.column === 'left').sort(lineCompare);
    const right = zone.filter(l => l.column === 'right').sort(lineCompare);
    if (left.length && right.length) {
      blocks.push(left, right);
    } else {
      blocks.push(zone.slice().sort(lineCompare));
    }
    zone = [];
  }

  for (let i = 0; i < annotated.length; i++) {
    const line = annotated[i];
    if (line.column !== 'full') {
      zone.push(line);
      continue;
    }

    flushZone();
    const fullRun = [line];
    while (i + 1 < annotated.length && annotated[i + 1].column === 'full') {
      fullRun.push(annotated[++i]);
    }
    blocks.push(fullRun.sort(lineCompare));
  }
  flushZone();

  return blocks.filter(b => b.length);
}

function paragraphsFromLines(lines, opts = {}) {
  const L = lines.slice().sort(lineCompare).filter(l => l.text);
  if (!L.length) return [];

  // Dominant left margin = most common startX (robust to outliers like
  // footnotes/indents); right margin = widest line. Avoids treating every
  // body line as "indented" when a stray element sits far to the left.
  const startBins = {};
  for (const l of L) { const k = Math.round(l.startX / 3) * 3; startBins[k] = (startBins[k] || 0) + 1; }
  const leftMargin = Number(Object.entries(startBins).sort((a, b) => b[1] - a[1])[0][0]);
  const rightEdge  = Math.max(...L.map(l => l.endX));
  const colWidth   = Math.max(1, rightEdge - leftMargin);

  // First-line indent threshold, relative to the body font: journals commonly
  // indent ~1em (e.g. 10pt at 10.5pt type), which a fixed 12pt floor missed.
  const bodyFontH = median(L.map(l => l.fontH)) || 10;
  const indentTol = Math.max(5, bodyFontH * 0.6);
  const shortTol  = Math.max(16, colWidth * 0.15);   // ragged last line of a paragraph

  // Is this block justified (flush right margin)? If so, a line stopping short of
  // the right edge marks a paragraph end. For ragged / left-aligned text MOST
  // lines stop short, so that test would split every single line into its own
  // paragraph — there, rely on vertical gap + indent only.
  const justified = L.filter(l => l.endX > rightEdge - shortTol).length >= L.length * 0.6;

  // Typical in-paragraph line gap for THIS block. A paragraph break is a gap
  // clearly larger than that — measured relative to the block's own leading, so
  // loosely-leaded text isn't split on every line, and not tied to the
  // (unreliable) reported glyph height.
  const gaps = [];
  for (let i = 1; i < L.length; i++) gaps.push(Math.abs(L[i - 1].y - L[i].y));
  const sortedGaps = gaps.slice().sort((a, b) => a - b);
  const medianGap = sortedGaps.length ? sortedGaps[Math.floor(sortedGaps.length / 2)] : 0;

  // Hanging-indent block (reference lists): each entry's first line touches the
  // left edge and its continuation lines are inset. There, every line back at
  // the left edge starts a new entry and the first-line-indent rule is off —
  // a 2-line entry's continuation line looks exactly like a first-line indent.
  // `references` is the layout model's hint; without it, require most lines to
  // be inset and the block to open at the left edge.
  const hangTol  = Math.max(4, bodyFontH * 0.4);
  // Left edge = the leftmost x shared by at least two lines, so one stray line
  // (e.g. a footer fragment caught by a coarse box edge) can't move it.
  const starts   = L.map(l => l.startX).sort((a, b) => a - b);
  const minStart = starts.find(x => starts.filter(s => Math.abs(s - x) <= hangTol).length >= 2) ?? starts[0];
  const atLeft   = L.filter(l => l.startX <= minStart + hangTol).length;
  const inset    = L.filter(l => l.startX > minStart + hangTol && l.startX <= minStart + bodyFontH * 2.5).length;
  const hangingBlock = opts.references
    ? atLeft >= 1 && inset >= 1
    : L.length >= 4 && L[0].startX <= minStart + hangTol && atLeft >= 2 && inset >= atLeft * 1.2;

  // Split into paragraphs. indent/short tests are guarded against centred lines
  // (titles, author blocks) which inset on both sides.
  const groups = [];
  let g = [L[0]];
  for (let i = 1; i < L.length; i++) {
    const prev = L[i - 1], cur = L[i];
    const fh = Math.max(prev.fontH, cur.fontH) || 12;

    // Paragraph break on a clear vertical gap (relative to local font size, so
    // large-font titles stay intact) or a first-line indent. The previous
    // "short last line" rule was dropped — superscript/footnote markers and
    // ragged line ends made it over-segment paragraphs into fragments.
    const bigGap       = Math.abs(prev.y - cur.y) > fh * 1.4;
    const reachesRight = cur.endX > rightEdge - shortTol;
    // First-line indent is judged against NEIGHBOURING lines, not the global
    // page margin: a real paragraph-initial line is inset relative to BOTH the
    // line above and the line below (which returns to the block's left edge).
    // Blocks inset as a whole (e.g. JMLR abstracts) have equal startX on every
    // line, and a hanging-indent continuation line (reference lists) is no
    // further in than the line after it — neither reads as an indent.
    const nxt          = L[i + 1];
    const below        = nxt ? nxt.startX : prev.startX;
    const indented     = !hangingBlock &&
      cur.startX > Math.max(prev.startX, below) + indentTol && reachesRight;
    const newEntry     = hangingBlock && cur.startX <= minStart + hangTol;
    // Reference lists without any indent (e.g. AAAI) separate entries only by
    // slightly looser leading (≈13.6pt vs 11pt): compare against this block's
    // own typical gap. Body text is left out — its leading jitters with
    // inline math.
    const refGap       = opts.references && !hangingBlock &&
      Math.abs(prev.y - cur.y) > medianGap + Math.max(1.5, medianGap * 0.1);

    if (bigGap || indented || newEntry || refGap) { groups.push(g); g = []; }
    g.push(cur);
  }
  if (g.length) groups.push(g);

  return groups.map(grp => {
    const flat = grp.flatMap(l => l.items);
    const text = joinLines(grp.map(l => l.text));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const it of flat) {
      const x = it.transform[4], y = it.transform[5];
      const w = it.width || 0, h = it.height || 10;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h);
    }
    return { text, rect: { x0, y0, x1, y1 } };
  }).filter(p => p.text.length > 20);
}

// Document-level cleanup over all pages' paragraphs ({ page, text, rect }):
//  1. drop running headers/footers — short text repeated on 3+ pages (digits
//     normalised, so "pp 5529–5545"-style page ranges still match);
//  2. re-join a paragraph that a column or page break cut mid-sentence: the
//     previous one ends without terminal punctuation and the next starts
//     lowercase. A joined paragraph keeps every piece's location in `parts`
//     so locate / reverse-locate can highlight across columns and pages.
function refineParagraphs(paras) {
  const norm = t => t.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  const pagesByText = new Map();
  for (const p of paras) {
    if (p.text.length > 150) continue;
    const k = norm(p.text);
    if (!pagesByText.has(k)) pagesByText.set(k, new Set());
    pagesByText.get(k).add(p.page);
  }
  // Page 1 is exempt: running headers usually repeat the paper's own title,
  // which we still want translated once.
  const isRunning = p => p.page > 1 && p.kind !== 'doc_title' &&
    p.text.length <= 150 && pagesByText.get(norm(p.text)).size >= 3;

  // Only flowing text joins; a figure/table caption may sit between the two
  // halves of a paragraph (the figure interrupts the column), a heading may not.
  const JOINABLE = new Set(['text', 'abstract', 'reference', 'footnote']);
  const CAPTION  = new Set(['figure_title', 'table_title', 'chart_title']);

  const ENDS_SENTENCE = /[.!?:;。！？：；]["'”’)\]]*$/;
  // Abstract / reference boxes sometimes stop a line short, leaving the rest
  // as plain text, so those kinds may join plain text. (A new reference entry
  // starts with an uppercase author, so body text never attaches to it.)
  const family = x => (x === 'abstract' || x === 'footnote' ? 'text' : x);
  const compatible = (a, b) => a === b || (a === 'reference' && b === 'text') || (a === 'text' && b === 'reference');

  const out = [];
  for (const p of paras) {
    if (isRunning(p)) continue;
    const kind = p.kind || 'text';
    let prev = null;
    if (JOINABLE.has(kind)) {
      for (let k = out.length - 1; k >= 0; k--) {
        if (CAPTION.has(out[k].kind)) continue;
        // A finished footnote sits between a page's last body paragraph and
        // its continuation on the next page — look past it. An unfinished
        // "footnote" is usually body text the model mislabelled; it may join.
        if (out[k].kind === 'footnote' && ENDS_SENTENCE.test(out[k].text)) continue;
        if (compatible(family(out[k].kind), family(kind))) prev = out[k];
        break;
      }
    }
    const continues = prev &&
      p.page - prev.parts[prev.parts.length - 1].page <= 1 &&
      prev.text.length >= 40 &&
      !ENDS_SENTENCE.test(prev.text) &&
      /^[a-z(]/.test(p.text);
    if (continues) {
      prev.text = joinLines([prev.text, p.text]);
      prev.parts.push({ page: p.page, rect: p.rect });
    } else {
      out.push({ page: p.page, text: p.text, rect: p.rect, kind,
                 parts: [{ page: p.page, rect: p.rect }] });
    }
  }
  return out;
}

// ─── Translation engine ─────────────────────────────────────────────────────────
// detectSourceLang / initTranslator / doTranslate are provided by translate-core.js
// (window.VibeTranslate) and shared with the in-page content script (content.js).

// ─── Translation flow ───────────────────────────────────────────────────────────
async function startTranslation(isManual) {
  if (abortCtrl) return; // already running
  clearError();
  els.results.innerHTML = '';

  if (!paragraphs.length) { showError('沒有可翻譯的文字（可能是掃描版 PDF）。'); return; }

  abortCtrl = new AbortController();
  const { signal } = abortCtrl;
  swapButtons(true);
  els.progressWrap.style.display = 'flex';

  try {
    setStatus('初始化翻譯引擎...');
    translatorObj = await initTranslator(detectedSource, els.targetLang.value, {
      isManual,
      onStatus: setStatus, onProgress: setProgress, onIndeterminate: setIndeterminate,
    });

    const total = paragraphs.length;
    const shells = paragraphs.map((p, i) => appendSegment(p, i));
    segEls = shells;
    const concurrency = translatorObj.type === 'translator' ? 4 : 1;
    els.aiBadge.textContent = `${engineLabel(translatorObj)} ✓`;
    els.aiBadge.className = 'badge badge-ok';

    // Requirement 5 — generate AI summary with Nano.
    // If translation uses NMT (different model), run summary concurrently;
    // if translation already uses Nano, defer summary to avoid contention.
    if (!summaryDone && translatorObj.type === 'translator') generateSummary();

    let done = 0, nextIdx = 0;
    async function worker() {
      while (true) {
        if (signal.aborted) return;
        const i = nextIdx++;
        if (i >= total) return;
        try {
          const translated = await doTranslate(translatorObj, paragraphs[i].text);
          fillTranslation(shells[i], translated);
        } catch (e) {
          fillTranslation(shells[i], `[翻譯失敗: ${e.message}]`, true);
        }
        done++;
        setProgress(done / total, `${done} / ${total}`);
        setStatus(`翻譯中 ${done} / ${total} 段`);
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));

    if (!signal.aborted) {
      setProgress(1, '完成');
      setStatus(`完成！共翻譯 ${total} 段（點任一段可定位原文）`);
      if (!summaryDone) generateSummary(); // deferred case
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      if (!isManual && isDownloadGestureError(e)) {
        clearError();
        els.progressWrap.style.display = 'none';
        setStatus(`PDF 已載入；${e.message.replace(/。.*$/, '')}，請點擊「翻譯」開始。`);
      } else {
        showError(e.message);
        setStatus('發生錯誤');
      }
    }
  } finally {
    swapButtons(false);
    abortCtrl = null;
  }
}

// ─── AI Summary (requirement 5, Gemini Nano) ─────────────────────────────────────
function validateSummaryObject(obj) {
  const keys = ['background', 'relatedWork', 'highlights', 'conclusion'];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) ||
      keys.some(key => typeof obj[key] !== 'string' || !obj[key].trim())) {
    throw new Error(`${BROWSER.llm} returned an incomplete summary payload.`);
  }
  return obj;
}

async function generateSummary() {
  if (summaryDone) return;
  if (!('LanguageModel' in self)) return;
  try {
    const avail = await lmAvailability();
    if (avail !== 'available') return;
  } catch { return; }

  summaryDone = true;
  renderSummaryShell();

  let session;
  try {
    session = await lmCreate({
      initialPrompts: [{ role: 'system', content: '你是學術論文分析助理，使用繁體中文、精煉地回答。' }],
    });

    // Nano has a limited context window — cap the input text.
    const fullText = paragraphs.map(p => p.text).join('\n');
    const text = fullText.slice(0, 7000);

    const schema = {
      type: 'object',
      properties: {
        background:  { type: 'string' },
        relatedWork: { type: 'string' },
        highlights:  { type: 'string' },
        conclusion:  { type: 'string' },
      },
      required: ['background', 'relatedWork', 'highlights', 'conclusion'],
    };

    const prompt =
      '以下是一篇論文的內文。請閱讀後，用繁體中文輸出四個面向的重點，每項約 2–4 句：\n' +
      '• background：研究背景與所需背景知識\n' +
      '• relatedWork：相關研究（Related Work）\n' +
      '• highlights：此研究的突破與亮點\n' +
      '• conclusion：總結\n\n論文內文：\n' + text;

    let obj;
    try {
      const raw = await session.prompt(prompt, { responseConstraint: schema });
      obj = validateSummaryObject(JSON.parse(raw));
    } catch (constraintError) {
      console.info('[PDF翻譯] constrained summary unavailable; falling back to plain JSON output:', constraintError);
      const raw = await session.prompt(prompt + '\n\n請只輸出 JSON 物件，不要加入其他文字。鍵必須完整包含 background, relatedWork, highlights, conclusion，且四個值都必須是非空字串。');
      obj = validateSummaryObject(JSON.parse(raw.replace(/^[^{]*/, '').replace(/[^}]*$/, '')));
    }

    summaryObj = obj;          // reused as global context for the ask-AI feature
    renderSummary(obj);
  } catch (e) {
    console.warn('[PDF翻譯] 摘要產生失敗：', e);
    summaryDone = false;
    if (isDownloadGestureError(e)) {
      els.summary.style.display = 'none';
      return;
    }
    els.summary.innerHTML = `<div class="sum-head">🧠 AI 摘要</div><div class="sum-err">摘要產生失敗：${esc(e.message)}</div>`;
  } finally {
    try { session?.destroy(); } catch (_) {}
  }
}

function renderSummaryShell() {
  els.summary.style.display = '';
  els.summary.innerHTML = `
    <div class="sum-head">🧠 AI 摘要 <span class="sum-by">由 ${esc(BROWSER.llm)} 生成</span></div>
    <div class="sum-loading">分析整份論文中…（地端模型，請稍候）</div>`;
}

function renderSummary(obj) {
  const sec = (icon, title, body) => `
    <div class="sum-sec">
      <div class="sum-title">${icon} ${title}</div>
      <div class="sum-body">${esc(body || '—')}</div>
    </div>`;
  els.summary.style.display = '';
  els.summary.innerHTML =
    `<div class="sum-head">🧠 AI 摘要 <span class="sum-by">由 ${esc(BROWSER.llm)} 生成</span></div>` +
    sec('📘', '背景知識 Background', obj.background) +
    sec('🔗', '相關研究 Related Work', obj.relatedWork) +
    sec('✨', '突破亮點 Highlights', obj.highlights) +
    sec('📝', '總結 Conclusion', obj.conclusion);
}

// ─── Segment UI + click-to-locate ───────────────────────────────────────────────
function appendSegment(para, idx) {
  const div = document.createElement('div');
  div.className = 'segment';
  div.dataset.idx = idx;
  div.innerHTML = `
    <div class="seg-meta">
      <span class="seg-page">第 ${para.page} 頁</span>
      <span class="seg-num">#${idx + 1}</span>
    </div>
    <div class="seg-orig">${esc(para.text)}</div>
    <div class="seg-trans loading">翻譯中…</div>`;
  div.addEventListener('click', (e) => {
    if (e.target.closest('.seg-edit')) return;   // don't locate while editing
    locate(idx, div);
  });
  // Double-click the translation → inline edit mode (fix wording, re-paragraph
  // with Enter). Blur or Ctrl+Enter saves; Esc cancels.
  div.addEventListener('dblclick', (e) => {
    const t = e.target.closest('.seg-trans');
    if (t && !t.classList.contains('loading')) enterEditMode(t);
  });
  els.results.appendChild(div);
  return div;
}

function enterEditMode(transEl) {
  if (transEl.querySelector('.seg-edit')) return;   // already editing
  const original = transEl.textContent;

  const ta = document.createElement('textarea');
  ta.className = 'seg-edit';
  ta.value = original;
  transEl.textContent = '';
  transEl.appendChild(ta);
  // size to content
  ta.style.height = 'auto';
  ta.style.height = Math.min(400, ta.scrollHeight + 4) + 'px';
  ta.focus();
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(400, ta.scrollHeight + 4) + 'px';
  });

  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const text = save ? ta.value : original;
    ta.remove();
    transEl.textContent = text;
  };
  ta.addEventListener('blur', () => finish(true));
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();                             // keep panel hotkeys out
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ta.blur(); }
    else if (e.key === 'Escape') finish(false);
  });
  // keep clicks inside the editor from bubbling to the locate handler
  ['click', 'mouseup', 'mousedown', 'dblclick'].forEach(ev =>
    ta.addEventListener(ev, (e) => e.stopPropagation()));
}

function fillTranslation(el, text, isError = false) {
  const t = el.querySelector('.seg-trans');
  t.textContent = text;
  t.classList.remove('loading');
  if (isError) t.classList.add('err');
}

// Draw highlight boxes over every piece of a paragraph (a paragraph re-joined
// across a column or page break has several). Returns the first box.
function highlightParagraph(para) {
  document.querySelectorAll('.hl').forEach(e => e.remove());
  let first = null;
  for (const { page, rect } of para.parts || [{ page: para.page, rect: para.rect }]) {
    const pg = pageWraps[page];
    if (!pg) continue;
    const [ax, ay] = pg.viewport.convertToViewportPoint(rect.x0, rect.y0);
    const [bx, by] = pg.viewport.convertToViewportPoint(rect.x1, rect.y1);
    const pad = 4;
    const hl = document.createElement('div');
    hl.className = 'hl';
    hl.style.left   = (Math.min(ax, bx) - pad) + 'px';
    hl.style.top    = (Math.min(ay, by) - pad) + 'px';
    hl.style.width  = (Math.abs(bx - ax) + pad * 2) + 'px';
    hl.style.height = (Math.abs(by - ay) + pad * 2) + 'px';
    pg.wrap.appendChild(hl);
    first = first || hl;
  }
  return first;
}

function locate(idx, segEl) {
  const para = paragraphs[idx];
  if (!pageWraps[para.page]) return;

  document.querySelectorAll('.seg-active').forEach(e => e.classList.remove('seg-active'));
  segEl.classList.add('seg-active');
  highlightParagraph(para)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ─── Reverse: click original text on the left → highlight translation on right ───
function setupReverseLocate() {
  els.pdfInner.addEventListener('click', (e) => {
    // If the user just made a text selection, leave it for the "ask AI" flow
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length >= 2) return;

    const wrap = e.target.closest('.page-wrap');
    if (!wrap) return;
    const pageNum = Number(wrap.dataset.page);
    const pg = pageWraps[pageNum];
    if (!pg) return;

    const box = wrap.getBoundingClientRect();
    const [px, py] = pg.viewport.convertToPdfPoint(e.clientX - box.left, e.clientY - box.top);

    const idx = findParagraphAt(pageNum, px, py);
    if (idx < 0) return;
    reverseLocate(idx, paragraphs[idx]);
  });
}

function findParagraphAt(page, px, py) {
  let best = -1, bestArea = Infinity, nearest = -1, nearestDy = Infinity;
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    for (const { page: pPage, rect: r } of p.parts || [{ page: p.page, rect: p.rect }]) {
      if (pPage !== page) continue;
      if (px >= r.x0 && px <= r.x1 && py >= r.y0 && py <= r.y1) {
        const area = (r.x1 - r.x0) * (r.y1 - r.y0);
        if (area < bestArea) { bestArea = area; best = i; }
      }
      const cy = (r.y0 + r.y1) / 2;
      const dy = Math.abs(cy - py);
      if (dy < nearestDy) { nearestDy = dy; nearest = i; }
    }
  }
  // exact hit preferred; otherwise the vertically closest paragraph (within reason)
  if (best >= 0) return best;
  return nearestDy < 40 ? nearest : -1;
}

function reverseLocate(idx, para) {
  const seg = segEls[idx];
  if (!seg) return;

  // highlight the segment on the right
  document.querySelectorAll('.seg-active').forEach(e => e.classList.remove('seg-active'));
  seg.classList.add('seg-active');
  seg.classList.remove('seg-flash');
  void seg.offsetWidth;            // restart CSS animation
  seg.classList.add('seg-flash');
  seg.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // also draw the highlight box(es) on the PDF for visual confirmation
  highlightParagraph(para);
}

// ─── Selection → ask Gemini Nano (requirement 6) ─────────────────────────────────
function setupSelectionAsk() {
  els.pdfPane.addEventListener('mouseup', () => {
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : '';
      if (text.length >= 2 && sel.rangeCount) {
        selectedText = text;
        const r = sel.getRangeAt(0).getBoundingClientRect();
        els.askFloat.style.display = '';
        els.askFloat.style.left = Math.min(window.innerWidth - 175, Math.max(4, r.left + r.width / 2 - 85)) + 'px';
        els.askFloat.style.top  = Math.max(8, r.top - 42) + 'px';
      } else {
        els.askFloat.style.display = 'none';
      }
    }, 10);
  });

  els.pdfPane.addEventListener('scroll', () => { els.askFloat.style.display = 'none'; });

  els.askFloatAsk.addEventListener('click', () => {
    els.askFloat.style.display = 'none';
    openAskModal(selectedText);
  });

  // Quick-translate: reuse the same panel, but skip the question flow and
  // immediately show the translation of the selected text.
  els.askFloatTrans.addEventListener('click', () => {
    els.askFloat.style.display = 'none';
    openAskModal(selectedText, 'translate');
    quickTranslateSelection(selectedText);
  });

  // Only the ✕ button or Escape close the modal — NOT clicking the backdrop,
  // which made it dismiss far too easily.
  els.askClose.addEventListener('click', closeAskModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.askModal.style.display !== 'none') closeAskModal();
  });

  els.askSend.addEventListener('click', askNano);
  els.askStop.addEventListener('click', () => askAbort?.abort());

  // Enter submits; Shift+Enter inserts a newline
  els.askInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); askNano(); }
  });

  // Drag the floating panel by its header
  let dragP = null;
  els.askHead.addEventListener('mousedown', (e) => {
    if (e.target === els.askClose) return;
    const box = els.askModal.getBoundingClientRect();
    dragP = { dx: e.clientX - box.left, dy: e.clientY - box.top };
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragP) return;
    const x = Math.max(0, Math.min(window.innerWidth  - 80, e.clientX - dragP.dx));
    const y = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - dragP.dy));
    els.askModal.style.left = x + 'px';
    els.askModal.style.top  = y + 'px';
    els.askModal.style.right = 'auto';
    els.askModal.style.bottom = 'auto';
  });
  document.addEventListener('mouseup', () => { dragP = null; });
}

let askAbort   = null;
let askSession = null;

function openAskModal(text, mode = 'ask') {
  els.askSel.textContent = text;
  els.askInput.value = '';
  els.askModal.style.display = 'flex';
  if (mode === 'translate') {
    // Translate mode: no typing needed — translation starts immediately.
    // The input stays available only for optional follow-up questions.
    els.askAnswer.textContent = '翻譯中…';
    els.askInput.placeholder = '想追問這段內容？輸入問題後按 Enter（直接翻譯無需輸入）';
    els.askInput.blur();
  } else {
    els.askAnswer.textContent = '';
    els.askInput.placeholder = '想問什麼？（Enter 送出，Shift+Enter 換行；留空＝請 AI 解釋這段文字）';
    els.askInput.focus();
  }
}

function closeAskModal() {
  askAbort?.abort();              // stop any in-flight answer
  els.askModal.style.display = 'none';
}

// Translate the selected snippet and show the result in the ask panel's
// answer area. Reuses the full-document translator when it's already
// initialised; otherwise initialises one on demand.
let quickTransGen = 0;
async function quickTranslateSelection(text) {
  const gen = ++quickTransGen;
  els.askAnswer.textContent = '翻譯中…';
  try {
    if (!translatorObj) {
      translatorObj = await initTranslator(detectedSource, els.targetLang.value, { isManual: true });
    }
    const translated = await doTranslate(translatorObj, text);
    if (gen !== quickTransGen) return;                       // superseded / closed
    if (els.askModal.style.display === 'none') return;
    els.askAnswer.textContent = translated;
  } catch (e) {
    if (gen === quickTransGen) els.askAnswer.textContent = '翻譯失敗：' + e.message;
  }
}

function askSwap(running) {
  els.askSend.style.display = running ? 'none' : '';
  els.askStop.style.display = running ? '' : 'none';
}

// Locate the paragraph a selection came from, by matching its opening words
function findParagraphByText(snippet) {
  const norm = s => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const key = norm(snippet).slice(0, 40);
  if (key.length < 6) return -1;
  for (let i = 0; i < paragraphs.length; i++) {
    if (norm(paragraphs[i].text).includes(key)) return i;
  }
  return -1;
}

const clamp = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : (s || ''));

async function askNano() {
  if (askAbort) return; // already answering
  if (!('LanguageModel' in self)) {
    els.askAnswer.textContent = BROWSER.scheme === 'edge'
      ? 'Edge 內建 AI 不可用，無法提問。Edge 正式版尚未提供 Prompt API；請改用 Edge Canary / Dev，並到 edge://flags 啟用「Prompt API for on-device language model」後重啟。'
      : `${BROWSER.llm} 不可用，無法提問。`;
    return;
  }
  const question = els.askInput.value.trim() || '請用繁體中文解釋這段文字的意思與相關背景。';
  const snippet = els.askSel.textContent;

  askAbort = new AbortController();
  const { signal } = askAbort;
  askSwap(true);
  els.askAnswer.textContent = '思考中…';

  try {
    askSession = await lmCreate({
      initialPrompts: [{ role: 'system', content: '你是研究助理。使用者會閱讀一篇論文並反白其中一段文字提問。請優先依據提供的「論文摘要」與「前後文」作答，用繁體中文回答；若需補充常識可適度補充並註明。' }],
    });

    // Build layered context within Nano's small context window:
    // global (AI summary) + local (neighbouring paragraphs) + the selection.
    const parts = [];
    if (summaryObj) {
      parts.push(
        '【論文摘要】\n' +
        `背景：${clamp(summaryObj.background, 220)}\n` +
        `相關研究：${clamp(summaryObj.relatedWork, 220)}\n` +
        `亮點：${clamp(summaryObj.highlights, 220)}\n` +
        `總結：${clamp(summaryObj.conclusion, 220)}`);
    }
    const idx = findParagraphByText(snippet);
    if (idx >= 0) {
      const ctx = [paragraphs[idx - 1], paragraphs[idx], paragraphs[idx + 1]]
        .filter(Boolean).map(p => p.text).join('\n');
      parts.push('【反白段落的前後文】\n' + clamp(ctx, 1500));
    }
    parts.push('【使用者反白的片段】\n' + clamp(snippet, 1000));
    parts.push('【問題】\n' + question);

    const prompt = parts.join('\n\n');
    const stream = askSession.promptStreaming(prompt, { signal });
    els.askAnswer.textContent = '';
    for await (const chunk of stream) {
      els.askAnswer.textContent += chunk;
      els.askAnswer.scrollTop = els.askAnswer.scrollHeight;
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      if (!els.askAnswer.textContent || els.askAnswer.textContent === '思考中…') els.askAnswer.textContent = '（已停止）';
      else els.askAnswer.textContent += '\n\n（已停止）';
    } else if (e.name === 'NotSupportedError') {
      els.askAnswer.textContent = `${BROWSER.llm} 在這台裝置上無法使用（${e.message}）。` +
        `請按右上角 ⚙ 查看「瀏覽器內建 AI」的檢查結果與設定方式。`;
    } else {
      els.askAnswer.textContent = '發生錯誤：' + e.message;
    }
  } finally {
    try { askSession?.destroy(); } catch (_) {}
    askSession = null;
    askAbort = null;
    askSwap(false);
  }
}

// ─── Resizable divider ──────────────────────────────────────────────────────────
function setupDivider() {
  let dragging = false;
  els.divider.addEventListener('mousedown', () => {
    dragging = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const pct = Math.min(80, Math.max(30, (e.clientX / window.innerWidth) * 100));
    els.pdfPane.style.flex = `0 0 ${pct}%`;
  });
  document.addEventListener('mouseup', () => {
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function swapButtons(translating) {
  els.translateBtn.style.display = translating ? 'none' : '';
  els.stopBtn.style.display      = translating ? '' : 'none';
}
function setStatus(msg) { els.statusText.textContent = msg; }
function setProgress(ratio, label) {
  setIndeterminate(false);
  els.progressBar.style.width = `${Math.round(ratio * 100)}%`;
  els.progressLabel.textContent = label || '';
}
function setIndeterminate(on) {
  if (on) {
    els.progressBar.classList.add('indeterminate');
    els.progressBar.style.width = '100%';
    els.progressLabel.textContent = '處理中...';
  } else {
    els.progressBar.classList.remove('indeterminate');
  }
}
function showError(msg) { els.errorBox.textContent = msg; els.errorBox.style.display = ''; }
function clearError() { els.errorBox.style.display = 'none'; }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
