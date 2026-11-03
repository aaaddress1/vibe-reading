// Keep source URL handling independent of the desktop-only extension APIs.
export function readablePdfSource(value) {
  try {
    const url = new URL(value);
    return /^(https?|file|content):$/.test(url.protocol) ? url.href : null;
  } catch { return null; }
}

export function pdfSourceFromUrl(value) {
  try {
    const url = new URL(value);
    if (/^(https?|file):$/.test(url.protocol) &&
        (/\.pdf$/i.test(url.pathname) || /\/pdf\/[^/]+$/i.test(url.pathname))) return url.href;
    // Android's document provider may not expose a filename at all.
    if (url.protocol === 'content:') return url.href;
    // Only unwrap browser PDF viewers, never arbitrary website query strings.
    if (/^(chrome|edge|chrome-native|edge-native|chrome-extension):$/.test(url.protocol)) {
      for (const key of ['file', 'url', 'src']) {
        const source = readablePdfSource(url.searchParams.get(key));
        if (source) return source;
      }
    }
  } catch { /* New tab / missing URL. */ }
  return null;
}

// Runs inside the active document through scripting.executeScript.
export function inspectPdfDocument() {
  if (document.contentType === 'application/pdf') return location.href;
  if (document.querySelector('article, main, p, h1, h2')) return null;
  const embed = document.querySelector('embed[type="application/pdf"], object[type="application/pdf"]');
  if (!embed) return null;
  const source = embed.getAttribute('original-url') || embed.getAttribute('src') || embed.getAttribute('data');
  if (!source || source === 'about:blank') return location.href;
  try { return new URL(source, document.baseURI).href; } catch { return null; }
}
