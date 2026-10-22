'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'viewer.js'), 'utf8');
const summaryCode = source.slice(source.indexOf('function validateSummaryObject('), source.indexOf('function renderSummaryShell('));
const keys = ['background', 'relatedWork', 'highlights', 'conclusion'];
const english = Object.fromEntries(keys.map(key => [key, 'The research studies ' + key + '.']));
const chinese = Object.fromEntries(keys.map(key => [key, '本研究探討學術問題並驗證研究成果。']));
function fixture(overrides = {}) {
  const calls = { translated: [], initialized: [], destroyed: 0, rendered: [], prompts: [] };
  const context = {
    summaryDone: false, summaryGeneration: 0, summaryObj: null,
    self: { LanguageModel: {} }, BROWSER: { scheme: 'edge', llm: 'Edge AI' },
    paragraphs: [{ text: 'A paper about scientific discovery.' }],
    els: { targetLang: { value: 'zh-Hant' }, summary: { style: {}, innerHTML: '' } },
    console: { info() {}, warn() {} },
    langName: code => ({ 'zh-Hant': '繁體中文', en: 'English', fr: 'Français' }[code] || code),
    detectSourceLang: async text => /\p{Script=Han}/u.test(text) ? 'zh' : 'en',
    lmAvailability: async () => 'available',
    lmCreate: async () => ({
      prompt: async (prompt, options) => { calls.prompts.push({ prompt, options }); return JSON.stringify(english); },
      destroy() { calls.destroyed++; },
    }),
    initTranslator: async (src, tgt, options) => {
      calls.initialized.push({ src, tgt, options });
      return { type: 'translator', t: { destroy() { calls.destroyed++; } } };
    },
    doTranslate: async (trans, text) => { calls.translated.push(text); return '本研究探討學術問題並驗證研究成果。'; },
    renderSummaryShell() {},
    renderSummary: obj => calls.rendered.push(obj),
    isDownloadGestureError: e => e.name === 'ModelDownloadNeedsUserGesture',
    esc: s => s.replaceAll('<', '&lt;'),
    ...overrides,
  };
  vm.createContext(context);
  vm.runInContext(summaryCode, context);
  return { context, calls };
}

test('Edge English summary is translated field by field into the selected language', async () => {
  const { context, calls } = fixture();
  await context.generateSummary();
  assert.equal(calls.translated.length, 4);
  assert.equal(calls.initialized.length, 1);
  assert.equal(calls.initialized[0].src, 'en');
  assert.equal(calls.initialized[0].tgt, 'zh-Hant');
  assert.equal(calls.rendered.length, 1);
  for (const key of keys) assert.equal(context.summaryObj[key], chinese[key]);
  assert.equal(calls.destroyed, 2);
});

test('mixed summaries translate only fields in the wrong language', async () => {
  const { context, calls } = fixture();
  const obj = { ...chinese, conclusion: english.conclusion };
  const result = await context.localizeSummary(obj, 'zh-Hant');
  assert.equal(calls.translated.length, 1);
  assert.equal(result.background, chinese.background);
  assert.equal(result.conclusion, chinese.conclusion);
});

test('Chinese output works without a downloaded language detector', async () => {
  const { context, calls } = fixture({ detectSourceLang: async () => 'en' });
  await context.localizeSummary(chinese, 'zh-Hant');
  assert.equal(calls.initialized.length, 0);
});

test('English target keeps English summary and requests English in the prompt', async () => {
  const { context, calls } = fixture();
  context.els.targetLang.value = 'en';
  await context.generateSummary();
  assert.equal(calls.translated.length, 0);
  assert.equal(context.summaryObj.conclusion, english.conclusion);
  assert.match(calls.prompts[0].prompt, /ALL FOUR VALUES in English \(en\)/);
});

test('a translation that remains English is rejected rather than shown as success', async () => {
  const { context, calls } = fixture({ doTranslate: async () => 'Still an English summary.' });
  await context.generateSummary();
  assert.equal(calls.rendered.length, 0);
  assert.equal(context.summaryObj, null);
  assert.equal(context.summaryDone, false);
  assert.match(context.els.summary.innerHTML, /摘要產生失敗/);
  assert.equal(calls.destroyed, 2);
});

test('Edge falls back to a translation model if Prompt API is chosen for translation', async () => {
  let destroyed = 0;
  const engines = [];
  const { context } = fixture({ initTranslator: async (src, tgt, options) => {
    engines.push(options.engine);
    return options.engine === 'auto'
      ? { type: 'lm', session: { destroy() { destroyed++; } } }
      : { type: 'local' };
  } });
  await context.localizeSummary(english, 'zh-Hant');
  assert.deepEqual(engines, ['auto', 'local']);
  assert.equal(destroyed, 1);
});

test('unsupported structured output falls back to plain JSON and still localizes', async () => {
  let prompts = 0;
  const { context, calls } = fixture({ lmCreate: async () => ({
    prompt: async (prompt, options) => {
      prompts++;
      if (options) throw new TypeError('responseConstraint unsupported');
      return '~~~json\n' + JSON.stringify(english) + '\n~~~';
    }, destroy() {},
  }) });
  await context.generateSummary();
  assert.equal(prompts, 2);
  assert.equal(calls.rendered.length, 1);
  assert.equal(calls.translated.length, 4);
});

test('a previous language request cannot overwrite the new language summary', async () => {
  let resolveOld;
  const { context, calls } = fixture({ lmCreate: async () => ({
    prompt: () => new Promise(resolve => { resolveOld = resolve; }), destroy() {},
  }) });
  const pending = context.generateSummary();
  await new Promise(resolve => setImmediate(resolve));
  context.els.targetLang.value = 'en';
  context.resetSummary();
  context.lmCreate = async () => ({ prompt: async () => JSON.stringify(english), destroy() {} });
  await context.generateSummary();
  resolveOld(JSON.stringify(chinese));
  await pending;
  assert.equal(calls.rendered.length, 1);
  assert.equal(context.summaryObj.background, english.background);
  assert.equal(context.summaryDone, true);
});

test('duplicate requests while checking model availability create only one session', async () => {
  let available;
  const { context, calls } = fixture({ lmAvailability: () => new Promise(resolve => { available = resolve; }) });
  const pending = context.generateSummary();
  await context.generateSummary();
  available('available');
  await pending;
  assert.equal(calls.prompts.length, 1);
});

test('missing language pack leaves a visible retry message and allows retry', async () => {
  const { context, calls } = fixture({ initTranslator: async () => {
    const err = new Error('Needs user gesture');
    err.name = 'ModelDownloadNeedsUserGesture';
    throw err;
  } });
  await context.generateSummary();
  assert.equal(calls.rendered.length, 0);
  assert.equal(context.summaryDone, false);
  assert.match(context.els.summary.innerHTML, /請點擊「翻譯」/);
});
