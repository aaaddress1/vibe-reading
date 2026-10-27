'use strict';

// A second PDF view backed by the original page bitmaps. Only nearby pages
// allocate canvases; translations stay selectable HTML in PDF coordinates.
(function (root) {
  function viewportBox(rect, viewport) {
    const points = [[rect.x0, rect.y0], [rect.x0, rect.y1],
      [rect.x1, rect.y0], [rect.x1, rect.y1]]
      .map(([x, y]) => viewport.convertToViewportPoint(x, y));
    const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    return { x: Math.min(...xs), y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  }

  // A logical paragraph can span columns/pages. Distribute its one translation
  // over physical blocks, preferring word/punctuation boundaries near each
  // source-length proportion. Never duplicate or discard translated content.
  function splitTranslation(text, parts) {
    if (parts.length <= 1) return [text];
    const chars = typeof Intl.Segmenter === 'function'
      ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), s => s.segment)
      : Array.from(text);
    const weights = parts.map(p => p.text?.length ||
      Math.max(1, (p.rect.x1 - p.rect.x0) * (p.rect.y1 - p.rect.y0)));
    const total = weights.reduce((a, b) => a + b, 0);
    let start = 0, cumulative = 0;
    return parts.map((part, i) => {
      if (i === parts.length - 1) return chars.slice(start).join('');
      cumulative += weights[i];
      const ideal = Math.round(chars.length * cumulative / total);
      const radius = Math.min(30, Math.floor(chars.length / parts.length / 4));
      let end = Math.max(start, ideal), best = Infinity;
      for (let k = Math.max(start + 1, ideal - radius); k <= Math.min(chars.length - 1, ideal + radius); k++) {
        const left = chars[k - 1], right = chars[k];
        const boundary = /[\s。！？；，、.!?;,:]/u.test(left) ||
          /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(left + right);
        if (boundary && Math.abs(k - ideal) < best) { end = k; best = Math.abs(k - ideal); }
      }
      end = Math.max(start, Math.min(chars.length, end));
      const piece = chars.slice(start, end).join('');
      start = end;
      return piece;
    });
  }

  function captureAnchor(pane, pages) {
    const top = pane.getBoundingClientRect().top + 8;
    let last = null;
    for (const [number, pg] of Object.entries(pages)) {
      const r = pg.wrap.getBoundingClientRect();
      last = { page: number, fraction: (top - r.top) / Math.max(1, r.height) };
      if (r.bottom > top) break;
    }
    return last;
  }

  class Reader {
    constructor({ pane, inner, sourcePane, sourcePages, onLocate, onZoom, onEdit = () => {} }) {
      Object.assign(this, { pane, inner, sourcePane, sourcePages, onLocate, onZoom, onEdit });
      this.pages = {};
      this.translations = new Map();
      this.blocks = new Map();
      this.enabled = false;
      this.scale = 1;
      this.fontRatio = 1;
      this.frame = null;
      this.editing = null;
      this.locateTimer = null;
      this.expectedScroll = new Map();
      sourcePane.addEventListener('scroll', () => this.onScroll(sourcePane), { passive: true });
      pane.addEventListener('scroll', () => this.onScroll(pane), { passive: true });
      pane.addEventListener('wheel', e => {
        // Let an unusually long block scroll internally, without moving pages.
        if (!e.ctrlKey && e.target.closest('.pdf-trans-block.is-overflowing')) {
          e.stopPropagation();
          return;
        }
        if (e.ctrlKey) { e.preventDefault(); onZoom(e); }
      }, { passive: false });
      this.resizeObserver = new ResizeObserver(() => {
        if (this.enabled) { this.syncFrom(sourcePane); this.schedule(); }
      });
      this.resizeObserver.observe(pane);
      document.fonts?.ready.then(() => this.refit());
    }

    setDocument(sourcePages, paragraphs) {
      this.editing?.finish(false);
      this.release();
      this.inner.replaceChildren();
      this.pages = {};
      this.blocks.clear();
      this.translations.clear();
      this.expectedScroll.clear();
      for (const [number, source] of Object.entries(sourcePages)) {
        const wrap = document.createElement('div');
        wrap.className = 'page-wrap translated-page';
        wrap.dataset.page = number;
        wrap.setAttribute('aria-label', `翻譯 PDF，第 ${number} 頁`);
        const layer = document.createElement('div');
        layer.className = 'pdf-overlay-layer';
        layer.style.width = source.w1 + 'px';
        layer.style.height = source.h1 + 'px';
        wrap.appendChild(layer);
        this.inner.appendChild(wrap);
        this.pages[number] = { wrap, layer, source, viewport: source.page.getViewport({ scale: 1 }),
          blocks: [], canvas: null, sourceCanvas: null, dirty: true, revision: -1 };
      }
      paragraphs.forEach((para, index) => {
        const parts = para.parts || [{ page: para.page, rect: para.rect, text: para.text, fontSize: para.fontSize }];
        const records = [];
        parts.forEach((part, partIndex) => {
          const pg = this.pages[part.page];
          if (!pg) return;
          const record = { part, partIndex, index, kind: para.kind, pg, node: null };
          pg.blocks.push(record);
          records.push(record);
        });
        this.blocks.set(index, { parts, records });
      });
      this.setScale(this.scale);
    }

    setEnabled(on) {
      if (!on) this.editing?.finish(true);
      this.enabled = on;
      if (on) { this.syncFrom(this.sourcePane); this.schedule(); }
      else this.release();
    }

    release() {
      clearTimeout(this.locateTimer);
      if (this.frame != null) cancelAnimationFrame(this.frame);
      this.frame = null;
      for (const pg of Object.values(this.pages)) this.releasePage(pg);
    }

    releasePage(pg) {
      if (this.editing?.block.pg === pg) this.editing.finish(true);
      if (pg.canvas) {
        pg.canvas.remove();
        pg.canvas.width = pg.canvas.height = 0;
        pg.canvas = pg.sourceCanvas = null;
      }
      pg.layer.replaceChildren();
      pg.blocks.forEach(b => { b.node = null; });
      pg.dirty = true;
    }

    setScale(scale) {
      this.scale = scale;
      for (const pg of Object.values(this.pages)) {
        pg.wrap.style.width = pg.source.w1 * scale + 'px';
        pg.wrap.style.height = pg.source.h1 * scale + 'px';
        pg.layer.style.transform = `scale(${scale})`;
      }
      this.schedule();
    }

    setFontRatio(ratio) { this.fontRatio = ratio; this.refit(); }
    refit() {
      Object.values(this.pages).forEach(pg => { pg.dirty = true; });
      this.schedule();
    }

    clearTranslations() {
      this.editing?.finish(false);
      this.translations.clear();
      Object.values(this.pages).forEach(pg => {
        pg.layer.replaceChildren();
        pg.blocks.forEach(b => { b.node = null; });
        pg.dirty = true;
      });
      this.schedule();
    }

    updateTranslation(index, text, isError, lang) {
      const group = this.blocks.get(index);
      if (!group) return;
      if (this.editing?.block.index === index) this.editing.finish(false);
      if (isError || !text.trim()) this.translations.delete(index);
      else this.translations.set(index, { text, pieces: splitTranslation(text, group.parts), lang });
      group.records.forEach(b => { b.pg.dirty = true; });
      this.schedule();
    }

    refreshPage(number) {
      const pg = this.pages[number];
      if (pg) { pg.sourceCanvas = null; this.schedule(); }
    }

    schedule() {
      if (!this.enabled || this.frame != null) return;
      this.frame = requestAnimationFrame(() => { this.frame = null; this.paintNearby(); });
    }

    paintNearby() {
      const bounds = this.pane.getBoundingClientRect(), margin = this.pane.clientHeight / 2;
      for (const pg of Object.values(this.pages)) {
        const r = pg.wrap.getBoundingClientRect();
        if (r.bottom < bounds.top - margin || r.top > bounds.bottom + margin) {
          if (pg.canvas) this.releasePage(pg);
          continue;
        }
        const original = pg.source.canvas;
        if (pg.sourceCanvas !== original || pg.revision !== pg.source.rasterRevision) {
          const next = document.createElement('canvas');
          next.width = original.width;
          next.height = original.height;
          next.setAttribute('aria-hidden', 'true');
          next.getContext('2d').drawImage(original, 0, 0);
          if (pg.canvas) {
            const old = pg.canvas;
            old.replaceWith(next);
            old.width = old.height = 0;
          } else pg.wrap.prepend(next);
          pg.canvas = next;
          pg.sourceCanvas = original;
          pg.revision = pg.source.rasterRevision;
        }
        if (pg.dirty) {
          for (const block of pg.blocks) this.paintBlock(block);
          pg.dirty = false;
        }
      }
    }

    paintBlock(block) {
      const result = this.translations.get(block.index);
      const text = result?.pieces[block.partIndex];
      if (!text?.trim()) { block.node?.remove(); block.node = null; return; }
      if (!block.node) {
        const node = document.createElement('div');
        node.className = 'pdf-trans-block';
        node.dataset.idx = block.index;
        node.tabIndex = 0;
        node.dir = 'auto';
        node.addEventListener('click', e => {
          clearTimeout(this.locateTimer);
          if (this.editing?.block === block) return;
          if (e.detail > 1) return;
          // Locating scrolls both panes; wait for a possible double-click first
          // so the block cannot move away before its editor opens.
          this.locateTimer = setTimeout(() => {
            this.locateTimer = null;
            if (!this.editing && !window.getSelection()?.toString().trim()) this.onLocate(block.index);
          }, 500);
        });
        node.addEventListener('dblclick', e => {
          if (this.editing?.block === block) return;
          e.preventDefault();
          e.stopPropagation();
          clearTimeout(this.locateTimer);
          this.editBlock(block);
        });
        node.addEventListener('keydown', e => {
          if (this.editing?.block === block) return;
          if (e.key === 'Enter') { e.preventDefault(); this.onLocate(block.index); }
          else if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(e.key)) e.stopPropagation();
        });
        const box = viewportBox(block.part.rect, block.pg.viewport);
        const font = block.part.fontSize || 10;
        // PDF text y0 is the baseline: include descenders in the opaque mask.
        const pad = 1, descent = Math.min(2.5, font * 0.2);
        const left = Math.max(0, box.x - pad), top = Math.max(0, box.y - pad);
        Object.assign(node.style, { left: left + 'px', top: top + 'px',
          width: Math.min(block.pg.source.w1 - left, box.width + pad * 2) + 'px',
          height: Math.min(block.pg.source.h1 - top, box.height + pad * 2 + descent) + 'px' });
        const background = this.sampleBackground(block.pg, box);
        node.style.backgroundColor = background.css;
        node.style.color = background.dark ? '#f4f4f4' : '#202020';
        if (['doc_title', 'paragraph_title'].includes(block.kind)) node.classList.add('is-heading');
        if (block.kind === 'doc_title') node.classList.add('is-title');
        block.pg.layer.appendChild(node);
        block.node = node;
      }
      if (this.editing?.block === block) return;
      block.node.textContent = text.trim();
      block.node.lang = result.lang;
      block.node.title = '雙擊編輯譯文；點擊定位原文；文字較長時可在區塊內捲動閱讀';
      this.fitBlock(block.node, (block.part.fontSize || 10) * this.fontRatio);
    }

    editBlock(block) {
      if (this.editing?.block === block) { this.editing.field.focus(); return; }
      this.editing?.finish(true);
      const original = this.translations.get(block.index);
      if (!original || !block.node) return;
      // Edit the existing translated block itself: no extra panel or controls.
      const field = block.node;
      field.contentEditable = 'plaintext-only';
      field.setAttribute('role', 'textbox');
      field.setAttribute('aria-label', '譯文內容');
      field.setAttribute('aria-multiline', 'true');
      field.textContent = original.pieces[block.partIndex];
      field.classList.add('is-editing');
      let done = false;
      const finish = commit => {
        if (done) return;
        done = true;
        this.editing = null;
        const value = field.innerText.replace(/\r\n/g, '\n');
        field.removeEventListener('blur', onBlur);
        field.removeEventListener('keydown', onKeyDown);
        field.contentEditable = 'false';
        field.removeAttribute('role');
        field.removeAttribute('aria-label');
        field.removeAttribute('aria-multiline');
        field.classList.remove('is-editing');
        field.textContent = (commit ? value : original.pieces[block.partIndex]).trim();
        block.pg.dirty = true;
        this.schedule();
        // A language change/retranslation may already have replaced this result.
        if (!commit || this.translations.get(block.index) !== original) return;
        const pieces = original.pieces.slice();
        const previous = pieces[block.partIndex];
        let text = value;
        // Keep the whitespace joining this physical block to the next one.
        if (/^\s/.test(previous) && !/^\s/.test(text)) text = previous.match(/^\s+/)[0] + text;
        if (/\s$/.test(previous) && !/\s$/.test(text)) text += previous.match(/\s+$/)[0];
        pieces[block.partIndex] = text;
        const fullText = pieces.join('');
        this.translations.set(block.index, { ...original, text: fullText, pieces });
        this.blocks.get(block.index).records.forEach(b => { b.pg.dirty = true; });
        this.schedule();
        this.onEdit(block.index, fullText);
      };
      this.editing = { block, field, finish };
      const onBlur = () => finish(true);
      const onKeyDown = e => {
        e.stopPropagation();
        if (e.isComposing) return;
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finish(true); }
      };
      field.addEventListener('blur', onBlur);
      field.addEventListener('keydown', onKeyDown);
      field.focus();
    }

    sampleBackground(pg, box) {
      // Sample just outside the text block; the source bitmap is unfiltered.
      // A small median rejects isolated glyphs/lines on tinted paper.
      const canvas = pg.source.baseCanvas;
      try {
        const ctx = canvas.getContext('2d');
        const sx = canvas.width / pg.source.w1, sy = canvas.height / pg.source.h1;
        const samples = [];
        for (const [x, y] of [[box.x - 2, box.y], [box.x + box.width + 2, box.y],
          [box.x, box.y - 2], [box.x + box.width / 2, box.y - 2], [box.x, box.y + box.height + 3]]) {
          samples.push(ctx.getImageData(Math.max(0, Math.min(canvas.width - 1, Math.round(x * sx))),
            Math.max(0, Math.min(canvas.height - 1, Math.round(y * sy))), 1, 1).data);
        }
        const rgb = [0, 1, 2].map(c => samples.map(s => s[c]).sort((a, b) => a - b)[2]);
        return { css: `rgb(${rgb.join(',')})`, dark: rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722 < 128 };
      } catch (_) { return { css: '#fff', dark: false }; }
    }

    fitBlock(node, preferredSize) {
      // Fit in logical PDF points, independent of CSS zoom. Keep all text:
      // very long translations get an internal scrollbar at the minimum size.
      let low = 6.5, high = Math.max(low, Math.min(32, preferredSize));
      const fits = size => {
        node.style.fontSize = size + 'px';
        return node.scrollHeight <= node.clientHeight + 1 && node.scrollWidth <= node.clientWidth + 1;
      };
      if (!fits(high)) {
        for (let i = 0; i < 7; i++) {
          const mid = (low + high) / 2;
          if (fits(mid)) low = mid; else high = mid;
        }
        fits(low);
      }
      node.classList.toggle('is-overflowing', node.scrollHeight > node.clientHeight + 1);
    }

    onScroll(pane) {
      if (!this.enabled) return;
      const expected = this.expectedScroll.get(pane);
      this.expectedScroll.delete(pane);
      if (!expected || Math.abs(pane.scrollTop - expected.top) > 1 || Math.abs(pane.scrollLeft - expected.left) > 1) this.syncFrom(pane);
      this.schedule();
    }

    syncFrom(pane) {
      if (!this.enabled) return;
      const fromSource = pane === this.sourcePane;
      const target = fromSource ? this.pane : this.sourcePane;
      const pages = fromSource ? this.sourcePages() : this.pages;
      const targets = fromSource ? this.pages : this.sourcePages();
      const anchor = captureAnchor(pane, pages);
      const pg = anchor && targets[anchor.page];
      if (!pg) return;
      const r = pg.wrap.getBoundingClientRect();
      target.scrollTop += r.top + anchor.fraction * r.height - target.getBoundingClientRect().top - 8;
      const range = pane.scrollWidth - pane.clientWidth;
      target.scrollLeft = range > 0 ? pane.scrollLeft / range * (target.scrollWidth - target.clientWidth) : 0;
      this.expectedScroll.set(target, { top: target.scrollTop, left: target.scrollLeft });
    }

    locate(index) {
      const records = this.blocks.get(index)?.records || [];
      for (const pg of Object.values(this.pages)) pg.layer.querySelectorAll('.is-active').forEach(n => n.classList.remove('is-active'));
      const first = records[0];
      if (!first) return;
      const box = viewportBox(first.part.rect, first.pg.viewport);
      const r = first.pg.wrap.getBoundingClientRect();
      this.pane.scrollTop += r.top + box.y * this.scale - this.pane.getBoundingClientRect().top - this.pane.clientHeight / 3;
      this.paintNearby();
      records.forEach(b => b.node?.classList.add('is-active'));
    }
  }

  const api = { Reader, viewportBox, splitTranslation, captureAnchor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VibePdfOverlay = api;
})(typeof window === 'undefined' ? globalThis : window);
