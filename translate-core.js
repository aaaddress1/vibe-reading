'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Shared translation engine.
//
// Used by BOTH the PDF viewer (viewer.js) and the in-page content script
// (content.js). It must run in a *document* context (extension page or content
// script), because the Chrome built-in AI APIs (Translator / LanguageModel /
// LanguageDetector) are NOT available inside the MV3 service worker (a Worker
// context). Therefore background.js never calls into this module — it only
// routes and injects.
//
// Exposed as a plain global `window.VibeTranslate` (no ES modules) to match how
// viewer.js is loaded via a classic <script> tag.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  // ─── Target-language options ──────────────────────────────────────────────
  const TARGET_LANGS = [
    { code: 'zh-Hant', name: '繁體中文' },
    { code: 'zh-Hans', name: '简体中文' },
    { code: 'en',      name: 'English' },
    { code: 'ja',      name: '日本語' },
    { code: 'ko',      name: '한국어' },
    { code: 'fr',      name: 'Français' },
    { code: 'de',      name: 'Deutsch' },
    { code: 'es',      name: 'Español' },
    { code: 'pt',      name: 'Português' },
    { code: 'ru',      name: 'Русский' },
  ];

  function browserDefaultTarget() {
    const l = (navigator.language || 'en').toLowerCase();
    if (l.startsWith('zh')) {
      return (l.includes('cn') || l.includes('hans') || l.includes('sg')) ? 'zh-Hans' : 'zh-Hant';
    }
    const primary = l.split('-')[0];
    return TARGET_LANGS.some(t => t.code === primary) ? primary : 'zh-Hant';
  }

  function langName(code) {
    return (TARGET_LANGS.find(t => t.code === code) || {}).name || code;
  }

  // Chrome 154+ with MTP speculative decoding also validates sampling options
  // during LanguageModel.availability().  Bare availability probes can therefore
  // report `unavailable` (and emit the MTP compatibility error) even though an
  // otherwise identical probe with greedy sampling returns `available`.
  //
  // translate-core.js loads before viewer.js, so normalise omitted availability
  // options once here for both the shared translation engine and the PDF viewer.
  const MTP_AVAILABILITY_OPTIONS = Object.freeze({ samplingMode: 'most-predictable' });

  function installMtpAvailabilityCompatibility() {
    if (!('LanguageModel' in self) || typeof LanguageModel.availability !== 'function') return;
    if (LanguageModel.availability.__vibeMtpCompatible) return;

    const nativeAvailability = LanguageModel.availability.bind(LanguageModel);
    const wrappedAvailability = function (options) {
      return nativeAvailability(options ?? MTP_AVAILABILITY_OPTIONS);
    };
    Object.defineProperty(wrappedAvailability, '__vibeMtpCompatible', { value: true });

    try {
      LanguageModel.availability = wrappedAvailability;
    } catch (e) {
      console.warn('[氛圍閱讀] 無法套用 Prompt API MTP availability 相容層：', e);
    }
  }

  installMtpAvailabilityCompatibility();

  // ─── Source-language auto-detection ─────────────────────────────────────────
  // Caller passes a representative text sample (decoupled from any page state).
  function needsDownloadGesture(availability) {
    return availability === 'downloadable' || availability === 'downloading';
  }

  function modelDownloadNeedsUserGestureError() {
    const err = new Error('首次使用需要下載 Chrome 內建 AI 模型或語言包。請由翻譯按鈕開始下載；下載完成後之後就可以自動翻譯。');
    err.name = 'ModelDownloadNeedsUserGesture';
    return err;
  }

  async function detectSourceLang(sampleText) {
    const sample = (sampleText || '').slice(0, 1000);
    if (!sample) return 'en';
    if ('LanguageDetector' in self) {
      try {
        const avail = await LanguageDetector.availability();
        if (avail === 'available') {
          const det = await LanguageDetector.create();
          const res = await det.detect(sample);
          if (res?.[0]?.detectedLanguage && res[0].detectedLanguage !== 'und') {
            return res[0].detectedLanguage;
          }
        } else if (needsDownloadGesture(avail)) {
          console.info('[氛圍閱讀] 語言偵測模型尚未下載，先預設來源語言為 en。');
        }
      } catch (e) {
        console.warn('[氛圍閱讀] 語言偵測失敗，預設 en：', e);
      }
    }
    return 'en';
  }

  // ─── Translator init ────────────────────────────────────────────────────────
  // options: { isManual, onStatus(msg), onProgress(ratio, label), onIndeterminate(bool) }
  // All hooks are optional; default to no-ops so the engine has no UI coupling.
  async function initTranslator(sourceLang, targetLang, options = {}) {
    const isManual        = options.isManual      || false;
    const onStatus        = options.onStatus      || (() => {});
    const onProgress      = options.onProgress    || (() => {});
    const onIndeterminate = options.onIndeterminate || (() => {});

    if (sourceLang === targetLang) sourceLang = sourceLang === 'en' ? 'fr' : 'en'; // avoid same-pair error
    let downloadNeedsGesture = false;

    if ('Translator' in self) {
      try {
        const avail = await Translator.availability({ sourceLanguage: sourceLang, targetLanguage: targetLang });
        if (avail !== 'unavailable') {
          if (needsDownloadGesture(avail) && !isManual) {
            downloadNeedsGesture = true;
          } else {
            if (avail === 'downloadable') { onStatus('首次使用：下載翻譯語言包...'); onProgress(0, '0%'); }
            const t = await Translator.create({
              sourceLanguage: sourceLang,
              targetLanguage: targetLang,
              monitor(m) {
                m.addEventListener('downloadprogress', (e) => {
                  const pct = Math.round(e.loaded * 100);
                  onStatus(`下載翻譯語言包 ${pct}%（僅首次）...`);
                  onProgress(e.loaded, `${pct}%`);
                });
              },
            });
            return { type: 'translator', t, targetName: langName(targetLang) };
          }
        }
      } catch (e) {
        console.warn('[氛圍閱讀] Translator 初始化失敗，改用 Gemini Nano：', e);
      }
    }

    if ('LanguageModel' in self) {
      const avail = await LanguageModel.availability(MTP_AVAILABILITY_OPTIONS);
      if (avail !== 'unavailable') {
        if (needsDownloadGesture(avail) && !isManual) {
          downloadNeedsGesture = true;
        } else {
          onStatus('首次使用：載入 Gemini Nano 模型（約 2.4GB）...');
          onIndeterminate(true);
          const targetName = langName(targetLang);
          const session = await LanguageModel.create({
            samplingMode: 'most-predictable',
            initialPrompts: [{ role: 'system', content: `你是專業翻譯員。請將輸入的文字翻譯成${targetName}，只輸出翻譯結果，不加任何說明文字。` }],
            monitor(m) {
              m.addEventListener('downloadprogress', (e) => {
                const pct = Math.round(e.loaded * 100);
                onStatus(`下載 Gemini Nano 模型 ${pct}%（僅首次）...`);
                onProgress(e.loaded, `${pct}%`);
              });
            },
          });
          onIndeterminate(false);
          return { type: 'lm', session, targetName };
        }
      }
    }

    if (downloadNeedsGesture) throw modelDownloadNeedsUserGestureError();
    throw new Error('無法初始化任何翻譯引擎。');
  }

  async function doTranslate(trans, text) {
    if (trans.type === 'translator') return await trans.t.translate(text);
    return await trans.session.prompt(`翻譯成${trans.targetName}（只輸出翻譯結果）：\n${text}`);
  }

  // ─── Lightweight availability probe ─────────────────────────────────────────
  // For the content-script badge; mirrors viewer.js checkAI() without DOM coupling.
  async function checkAvailability(targetLang) {
    if ('Translator' in self) {
      try {
        const a = await Translator.availability({ sourceLanguage: 'en', targetLanguage: targetLang });
        if (a !== 'unavailable') return { ok: true, engine: 'Translator API' };
      } catch (_) {}
    }
    if ('LanguageModel' in self) {
      try {
        const a = await LanguageModel.availability(MTP_AVAILABILITY_OPTIONS);
        if (a !== 'unavailable') return { ok: true, engine: 'Gemini Nano' };
      } catch (_) {}
    }
    return { ok: false, engine: null };
  }

  window.VibeTranslate = {
    TARGET_LANGS,
    langName,
    browserDefaultTarget,
    detectSourceLang,
    initTranslator,
    doTranslate,
    checkAvailability,
  };
})();
