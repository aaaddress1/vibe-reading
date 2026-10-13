'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// PDF page layout detection.
//
// Runs PP-DocLayout-S (PaddlePaddle, Apache-2.0; lib/layout/) on the CPU via
// onnxruntime-web's wasm backend (MIT; lib/ort/). Given a rendered page canvas
// it returns labelled regions — body text, titles, captions, figures, tables,
// headers/footers … — which viewer.js uses to keep figure/table text out of
// the translation and to cut paragraphs along real block boundaries.
//
// Exposed as window.VibeLayout. detect() resolves to null when the model can't
// be loaded, and the viewer then falls back to purely geometric segmentation.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  const INPUT_SIZE = 480;   // model input is a fixed 480×480 (aspect not kept)
  const MEAN = [0.485, 0.456, 0.406];
  const STD  = [0.229, 0.224, 0.225];
  const LABELS = [
    'paragraph_title', 'image', 'text', 'number', 'abstract', 'content', 'figure_title',
    'formula', 'table', 'table_title', 'reference', 'doc_title', 'footnote', 'header',
    'algorithm', 'footer', 'seal', 'chart_title', 'chart', 'formula_number', 'header_image',
    'footer_image', 'aside_text',
  ];
  const MIN_SCORE = 0.3;    // callers apply stricter per-label thresholds

  let sessionPromise = null;

  function getSession() {
    if (!sessionPromise) {
      ort.env.wasm.wasmPaths = chrome.runtime.getURL('lib/ort/');
      // Extension pages aren't cross-origin isolated, so no SharedArrayBuffer
      // threads; the S model is small enough for a single thread.
      ort.env.wasm.numThreads = 1;
      sessionPromise = ort.InferenceSession.create(
        chrome.runtime.getURL('lib/layout/pp-doclayout-s.onnx'),
        { executionProviders: ['wasm'] });
    }
    return sessionPromise;
  }

  async function toTensor(canvas) {
    const c = document.createElement('canvas');
    c.width = INPUT_SIZE;
    c.height = INPUT_SIZE;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
    // A plain drawImage downscale aliases badly at these ratios; the model was
    // trained on smoothly (cubic) resized pages, so ask for a high-quality resize.
    const bmp = await createImageBitmap(canvas, {
      resizeWidth: INPUT_SIZE, resizeHeight: INPUT_SIZE, resizeQuality: 'high' });
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const { data } = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
    const plane = INPUT_SIZE * INPUT_SIZE;
    const out = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
      for (let ch = 0; ch < 3; ch++) out[ch * plane + i] = (data[i * 4 + ch] / 255 - MEAN[ch]) / STD[ch];
    }
    return out;
  }

  // Detect layout regions on a rendered page canvas. Boxes are returned in the
  // canvas's pixel coordinates: { label, score, x0, y0, x1, y1 }.
  async function detect(canvas) {
    let session;
    try {
      session = await getSession();
    } catch (e) {
      console.warn('[氛圍閱讀] 版面分析模型載入失敗，改用規則分段：', e);
      return null;
    }
    const feeds = {
      image: new ort.Tensor('float32', await toTensor(canvas), [1, 3, INPUT_SIZE, INPUT_SIZE]),
      scale_factor: new ort.Tensor('float32',
        new Float32Array([INPUT_SIZE / canvas.height, INPUT_SIZE / canvas.width]), [1, 2]),
    };
    const out = await session.run(feeds);
    const det = out[session.outputNames[0]].data;   // N × [class, score, x1, y1, x2, y2]
    const boxes = [];
    for (let i = 0; i + 5 < det.length; i += 6) {
      const score = det[i + 1];
      if (score < MIN_SCORE) continue;
      boxes.push({
        label: LABELS[det[i]] || 'unknown',
        score,
        x0: det[i + 2], y0: det[i + 3], x1: det[i + 4], y1: det[i + 5],
      });
    }
    return boxes;
  }

  window.VibeLayout = { detect };
})();
