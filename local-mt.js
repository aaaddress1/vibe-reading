// ─────────────────────────────────────────────────────────────────────────────
// Local machine translation (Opus-MT / MarianMT on onnxruntime-web, CPU wasm).
//
// Fallback engine for browsers without the built-in Translator / Prompt APIs —
// notably Edge on Android. It runs in the background service worker so the PDF
// viewer and every tab share one copy of the model; pages reach it through a
// runtime port (see background.js and translate-core.js).
//
// Models are the quantized ONNX exports by Xenova on the Hugging Face Hub (about
// 110MB per language pair), pinned to a commit and kept in Cache Storage after
// the first download. Pairs without a direct model pivot through English.
// zh-Hant is produced by translating into Simplified Chinese (the model's
// Traditional output drops content) and converting with OpenCC (s2twp).
// ─────────────────────────────────────────────────────────────────────────────
import * as ort from './lib/ort/ort.wasm.bundle.min.mjs';
import { Tokenizer } from './lib/tokenizers/tokenizers.min.mjs';
import { ConverterFactory } from './lib/opencc/core.js';

ort.env.wasm.numThreads = 1;   // no cross-origin isolation in a service worker
// Name only the .wasm: a path prefix makes the bundle import() the separate
// ort-wasm-*.mjs glue, and import() is not allowed in a service worker.
ort.env.wasm.wasmPaths = { wasm: new URL('./lib/ort/ort-wasm-simd-threaded.wasm', import.meta.url).href };

const HUB = 'https://huggingface.co/Xenova/opus-mt-';
const CACHE_NAME = 'vibe-mt-v1';
const REVISIONS = {
  'en-zh': '046f55aec303cdee3e0318604406d4df20f1e8ea',
  'en-fr': '28726206f80896b90035bd99cccd5cc1e151f916',
  'en-de': '1ca130c44c4c5441ef16d48aae521a424ab644f7',
  'en-es': '4b002a4c7edd54a7ced58877258b87f7efd3f892',
  'en-ru': 'e050376e960175e8ddc5cff85025dc8436cddd68',
  'en-ROMANCE': '9d2ba69ac80c8e8453c3d9a1e2323a0e7b8ca3cd',
  'zh-en': '39d480d52a9ea3065a1f117adfe4dbc55de10e6f',
  'ja-en': '1a906cfaaf7c8f4193f67f5885c082aa6dbd9d16',
  'ko-en': 'd9fa1ac6008242100fecb4fff9b0a5917a1be81f',
  'fr-en': '6b166a182780e118c997879d0ad5be4b53671644',
  'de-en': '399dfd68706739fffd503f876093e455ae268a06',
  'es-en': 'eadfd7c658a9d8929ac3b8e996b68a68e2c7d480',
  'ru-en': 'afe8c6c738ec81b6d033fd8f44f9678a639a7c67',
  'ROMANCE-en': 'f60feaabe8bb435a5871e7702b25f53a01e770f8',
  'mul-en': '72a05e47cee89c718a9db4dc70d02fef3bc39de8',
};
// Approximate sizes, used for progress until the real Content-Length arrives.
const FILES = [
  ['config.json', 2e3],
  ['tokenizer_config.json', 1e3],
  ['tokenizer.json', 6.4e6],
  ['onnx/encoder_model_quantized.onnx', 52e6],
  ['onnx/decoder_model_merged_quantized.onnx', 59e6],
];
const MODEL_MB = Math.round(FILES.reduce((s, [, n]) => s + n, 0) / 1e6);

// English → target (codes from translate-core.js TARGET_LANGS).
const FROM_EN = {
  'zh-Hans': { model: 'en-zh', token: '>>cmn_Hans<<' },
  'zh-Hant': { model: 'en-zh', token: '>>cmn_Hans<<', post: 's2twp' },
  fr: { model: 'en-fr' },
  de: { model: 'en-de' },
  es: { model: 'en-es' },
  ru: { model: 'en-ru' },
  pt: { model: 'en-ROMANCE', token: '>>pt<<' },
};
// Source (primary language subtag) → English. Anything else uses mul-en.
const TO_EN = {
  zh: 'zh-en', ja: 'ja-en', ko: 'ko-en', fr: 'fr-en', de: 'de-en', es: 'es-en', ru: 'ru-en',
  pt: 'ROMANCE-en', it: 'ROMANCE-en', ro: 'ROMANCE-en', ca: 'ROMANCE-en', gl: 'ROMANCE-en',
};

const primary = code => String(code || 'en').toLowerCase().split(/[-_]/)[0];

// Steps to get from `src` to `tgt`, or null when no local model covers the pair.
export function planFor(src, tgt) {
  const s = primary(src);
  const t = primary(tgt);
  if (s === t) {
    // Same language: nothing to translate, but zh → zh-Hant still converts script.
    return { steps: [], post: tgt === 'zh-Hant' ? 's2twp' : null };
  }
  const out = FROM_EN[tgt];
  if (s === 'en') return out ? { steps: [{ model: out.model, token: out.token }], post: out.post || null } : null;
  const back = { model: TO_EN[s] || 'mul-en' };
  if (t === 'en') return { steps: [back], post: null };
  return out ? { steps: [back, { model: out.model, token: out.token }], post: out.post || null } : null;
}

const fileUrl = (model, path) => `${HUB}${model}/resolve/${REVISIONS[model]}/${path}`;

export async function isDownloaded(plan) {
  const cache = await caches.open(CACHE_NAME);
  for (const { model } of plan.steps) {
    for (const [path] of FILES) if (!(await cache.match(fileUrl(model, path)))) return false;
  }
  return true;
}

export function downloadSizeMB(plan) {
  return new Set(plan.steps.map(s => s.model)).size * MODEL_MB;
}

// Fetch every file of `model` into Cache Storage, reporting byte progress.
async function download(model, onProgress) {
  const cache = await caches.open(CACHE_NAME);
  const sizes = FILES.map(([, n]) => n);
  const loaded = FILES.map(() => 0);
  const report = () => onProgress?.({
    phase: 'download', model,
    loaded: loaded.reduce((a, b) => a + b, 0),
    total: sizes.reduce((a, b) => a + b, 0),
  });
  for (let i = 0; i < FILES.length; i++) {
    const url = fileUrl(model, FILES[i][0]);
    const hit = await cache.match(url);
    if (hit) { loaded[i] = sizes[i]; report(); continue; }
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`下載翻譯模型失敗（HTTP ${resp.status}）`);
    const len = Number(resp.headers.get('Content-Length'));
    if (len) sizes[i] = len;
    const reader = resp.body.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded[i] += value.length;
      report();
    }
    const type = resp.headers.get('Content-Type') || 'application/octet-stream';
    await cache.put(url, new Response(new Blob(chunks, { type })));
    loaded[i] = sizes[i];
    report();
  }
}

async function readModel(model) {
  const cache = await caches.open(CACHE_NAME);
  const get = async path => {
    const r = await cache.match(fileUrl(model, path));
    if (!r) throw new Error('翻譯模型尚未下載');
    return r;
  };
  const [config, tokenizer, tokenizerConfig, encoder, decoder] = await Promise.all([
    get('config.json').then(r => r.json()),
    get('tokenizer.json').then(r => r.json()),
    get('tokenizer_config.json').then(r => r.json()),
    get('onnx/encoder_model_quantized.onnx').then(r => r.arrayBuffer()),
    get('onnx/decoder_model_merged_quantized.onnx').then(r => r.arrayBuffer()),
  ]);
  return { config, tokenizer, tokenizerConfig, encoder: new Uint8Array(encoder), decoder: new Uint8Array(decoder) };
}

// Greedy decoding can fall into a loop ("電離電離電離…"): ban any token that
// would repeat a trigram already in the output (no_repeat_ngram_size = 3).
function repeatBans(seq) {
  const banned = new Set();
  const n = seq.length;
  if (n < 2) return banned;
  const a = seq[n - 2], b = seq[n - 1];
  for (let i = 0; i + 2 < n; i++) {
    if (seq[i] === a && seq[i + 1] === b) banned.add(seq[i + 2]);
  }
  return banned;
}

// ─── Marian encoder–decoder with greedy, batched decoding ──────────────────────
export async function createMarian(files) {
  const { config: cfg } = files;
  const tokenizer = new Tokenizer(files.tokenizer, files.tokenizerConfig);
  const opts = { executionProviders: ['wasm'] };
  const encoder = await ort.InferenceSession.create(files.encoder, opts);
  const decoder = await ort.InferenceSession.create(files.decoder, opts);

  // Target-language tokens (">>cmn_Hans<<") are ordinary vocab entries, not
  // added tokens, so the tokenizer would split them: prepend their id instead.
  const vocabIds = new Map(files.tokenizer.model.vocab.map(([piece], i) => [piece, i]));
  const layers = cfg.decoder_layers;
  const heads = cfg.decoder_attention_heads;
  const headDim = cfg.d_model / heads;
  const EOS = cfg.eos_token_id, PAD = cfg.pad_token_id, START = cfg.decoder_start_token_id;
  const MAX_IN = 500;

  async function translateBatch(texts, langToken) {
    const B = texts.length;
    const prefix = langToken && vocabIds.has(langToken) ? [vocabIds.get(langToken)] : [];
    const seqs = texts.map(t => {
      const ids = [...prefix, ...tokenizer.encode(t).ids];   // encode() appends </s>
      return ids.length > MAX_IN ? [...ids.slice(0, MAX_IN - 1), EOS] : ids;
    });
    const L = Math.max(...seqs.map(s => s.length));
    const ids = new BigInt64Array(B * L).fill(BigInt(PAD));
    const m = new BigInt64Array(B * L);
    seqs.forEach((s, b) => s.forEach((v, i) => { ids[b * L + i] = BigInt(v); m[b * L + i] = 1n; }));
    const mask = new ort.Tensor('int64', m, [B, L]);
    const { last_hidden_state } = await encoder.run({
      input_ids: new ort.Tensor('int64', ids, [B, L]), attention_mask: mask });

    const empty = new ort.Tensor('float32', new Float32Array(0), [B, heads, 0, headDim]);
    const past = {};
    for (let l = 0; l < layers; l++) {
      for (const k of ['decoder.key', 'decoder.value', 'encoder.key', 'encoder.value']) {
        past[`past_key_values.${l}.${k}`] = empty;
      }
    }
    const out = texts.map(() => []);
    const done = new Array(B).fill(false);
    const next = new Array(B).fill(START);
    const maxNew = Math.min(512, L * 2 + 10);
    for (let step = 0; step < maxNew && done.includes(false); step++) {
      const res = await decoder.run({
        encoder_attention_mask: mask,
        input_ids: new ort.Tensor('int64', BigInt64Array.from(next, BigInt), [B, 1]),
        encoder_hidden_states: last_hidden_state,
        ...past,
        use_cache_branch: new ort.Tensor('bool', [step > 0], [1]),
      });
      const V = res.logits.dims[2];
      const lg = res.logits.data;
      for (let b = 0; b < B; b++) {
        if (done[b]) { next[b] = PAD; continue; }
        const banned = repeatBans(out[b]);
        let best = EOS, bv = -Infinity;
        for (let v = 0, o = b * V; v < V; v++) {
          if (v !== PAD && lg[o + v] > bv && !banned.has(v)) { bv = lg[o + v]; best = v; }
        }
        if (best === EOS) { done[b] = true; next[b] = PAD; }
        else { out[b].push(best); next[b] = best; }
      }
      for (let l = 0; l < layers; l++) {
        past[`past_key_values.${l}.decoder.key`] = res[`present.${l}.decoder.key`];
        past[`past_key_values.${l}.decoder.value`] = res[`present.${l}.decoder.value`];
        // The encoder cross-attention cache is only produced on the first step.
        if (step === 0) {
          past[`past_key_values.${l}.encoder.key`] = res[`present.${l}.encoder.key`];
          past[`past_key_values.${l}.encoder.value`] = res[`present.${l}.encoder.value`];
        }
      }
    }
    return out.map(o => tokenizer.decode(o, { skip_special_tokens: true }).trim());
  }

  return { translateBatch, release: () => Promise.all([encoder.release(), decoder.release()]) };
}

// ─── Text handling ──────────────────────────────────────────────────────────────
const NO_SPACE = new Set(['zh', 'ja']);
const BATCH = 8;
const LONG_SENTENCE = 400;   // chars; Marian is trained on sentences

function splitSentences(text, lang) {
  let parts;
  try {
    const seg = new Intl.Segmenter(lang, { granularity: 'sentence' });
    parts = Array.from(seg.segment(text), s => s.segment.trim());
  } catch (_) {
    parts = text.split(/(?<=[.!?。！？])\s+/);
  }
  // Break run-on "sentences" (reference lists, tables) at clause punctuation.
  return parts.filter(Boolean).flatMap(s => {
    if (s.length <= LONG_SENTENCE) return [s];
    const out = [];
    let cur = '';
    for (const piece of s.split(/(?<=[;:,，；：])\s*/)) {
      if (cur && cur.length + piece.length > LONG_SENTENCE) { out.push(cur); cur = piece; }
      else cur = cur ? `${cur} ${piece}` : piece;
    }
    if (cur) out.push(cur);
    return out;
  });
}

// Opus-MT emits ASCII punctuation in Chinese; use the full-width forms.
function fixCjkPunctuation(s) {
  const CJK = '\\u3400-\\u9fff\\uf900-\\ufaff';
  return s
    .replace(/(?<!\d),\s*|,\s*(?!\d)/g, '，')   // keep thousands separators (1,000)
    .replace(new RegExp(`([${CJK}])\\s*;\\s*`, 'g'), '$1；')
    .replace(new RegExp(`([${CJK}])\\s*:\\s*`, 'g'), '$1：')
    .replace(new RegExp(`([${CJK}])\\s*\\?`, 'g'), '$1？')
    .replace(new RegExp(`([${CJK}])\\s*!`, 'g'), '$1！')
    .replace(new RegExp(`([${CJK}])\\s*\\(([^()]*)\\)`, 'g'), '$1（$2）');
}

let s2twpPromise = null;
function s2twp() {
  if (!s2twpPromise) {
    s2twpPromise = fetch(new URL('./lib/opencc/s2twp.json', import.meta.url))
      .then(r => r.json())
      .then(groups => ConverterFactory(...groups));
  }
  return s2twpPromise;
}

// ─── Loaded models (at most two: a pivot needs both legs) ──────────────────────
const loaded = new Map();   // model → Promise<marian>

async function getModel(model, onProgress) {
  if (loaded.has(model)) {
    const m = loaded.get(model);
    loaded.delete(model);        // re-insert = most recently used
    loaded.set(model, m);
    return m;
  }
  await download(model, onProgress);
  onProgress?.({ phase: 'load', model });
  const p = readModel(model).then(createMarian);
  loaded.set(model, p);
  p.catch(() => loaded.delete(model));
  while (loaded.size > 2) {
    const [oldest, op] = loaded.entries().next().value;
    loaded.delete(oldest);
    op.then(m => m.release()).catch(() => {});
  }
  return p;
}

// Download (if needed) and load every model of the pair.
export async function prepare(src, tgt, onProgress) {
  const plan = planFor(src, tgt);
  if (!plan) throw new Error('本機翻譯模型不支援這個語言組合');
  for (const step of plan.steps) await getModel(step.model, onProgress);
  if (plan.post === 's2twp') await s2twp();
  return plan;
}

export async function translate(text, src, tgt, onProgress) {
  const plan = await prepare(src, tgt, onProgress);
  let sentences = splitSentences(String(text), primary(src));
  if (!sentences.length) return '';
  for (const step of plan.steps) {
    const marian = await getModel(step.model);
    const order = sentences.map((s, i) => i).sort((a, b) => sentences[a].length - sentences[b].length);
    const result = new Array(sentences.length);
    for (let i = 0; i < order.length; i += BATCH) {
      const idx = order.slice(i, i + BATCH);
      const res = await marian.translateBatch(idx.map(j => sentences[j]), step.token);
      idx.forEach((j, k) => { result[j] = res[k]; });
      onProgress?.({ phase: 'translate', done: Math.min(i + BATCH, order.length), total: order.length });
    }
    sentences = result;
  }
  const t = primary(tgt);
  let out = sentences.join(NO_SPACE.has(t) ? '' : ' ');
  if (t === 'zh') out = fixCjkPunctuation(out);
  if (plan.post === 's2twp') out = (await s2twp())(out);
  return out;
}
