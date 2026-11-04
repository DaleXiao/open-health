// Theme toggle (light/dark) without React.
// Sets <html> class synchronously from localStorage / prefers-color-scheme to avoid FOUC,
// then attaches a click handler to the #theme-toggle button to flip + persist.
(function () {
  var STORAGE_KEY = 'health-tracker-theme';
  var LEGACY_KEY = 'health-weweekly-theme'; // one-shot migration from the legacy key
  function getStored() {
    try {
      var v = localStorage.getItem(STORAGE_KEY);
      if (v === 'dark' || v === 'light') return v;
      var ov = localStorage.getItem(LEGACY_KEY);
      if (ov === 'dark' || ov === 'light') {
        try { localStorage.setItem(STORAGE_KEY, ov); localStorage.removeItem(LEGACY_KEY); } catch (e) {}
        return ov;
      }
      return null;
    } catch (e) { return null; }
  }
  function systemPref() {
    try { return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
    catch (e) { return 'light'; }
  }
  function apply(theme) {
    var root = document.documentElement;
    if (theme === 'dark') root.classList.add('dark'); else root.classList.remove('dark');
    try { localStorage.setItem(STORAGE_KEY, theme); } catch (e) {}
  }
  // Initial paint sync (the inline <script> in <head> already did this; this is a safety net).
  var current = getStored() || systemPref();
  apply(current);

  function bind() {
    var btn = document.getElementById('theme-toggle');
    if (!btn) return;
    btn.addEventListener('click', function () {
      current = (document.documentElement.classList.contains('dark')) ? 'light' : 'dark';
      apply(current);
      btn.setAttribute('aria-label', current === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
      btn.setAttribute('title', current === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
