'use strict';
(function () {
  if (window.VibeTheme) return;
  const themes = ['charcoal', 'orange', 'pink'];
  const normalize = value => themes.includes(value) ? value : 'charcoal';
  function apply(value) {
    const theme = normalize(value);
    document.documentElement.dataset.vibeTheme = theme;
    document.querySelectorAll('.vibe-ui [data-vibe-theme-select]').forEach(select => { select.value = theme; });
  }
  function bind() {
    document.querySelectorAll('.vibe-ui [data-vibe-theme-select]').forEach(select => {
      select.value = normalize(document.documentElement.dataset.vibeTheme);
      select.addEventListener('change', () => {
        const theme = normalize(select.value);
        apply(theme);
        chrome.storage.local.set({ readingTheme: theme });
      });
    });
  }
  window.VibeTheme = { apply };
  chrome.storage.local.get('readingTheme', ({ readingTheme }) => apply(readingTheme));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.readingTheme) apply(changes.readingTheme.newValue);
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true });
  else bind();
})();
