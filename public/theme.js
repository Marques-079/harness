// Theme: follows the OS (prefers-color-scheme) until the viewer picks one with
// the masthead toggle; the pick persists per browser. Loaded in <head> so the
// theme is applied before first paint. Also wires the cross-page nav links.
(function () {
  var KEY = 'harness-theme';
  var root = document.documentElement;
  function stored() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function save(v) { try { localStorage.setItem(KEY, v); } catch (e) { /* storage unavailable */ } }
  function effective() {
    var s = root.getAttribute('data-theme');
    if (s === 'light' || s === 'dark') return s;
    return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  var initial = stored();
  if (initial === 'light' || initial === 'dark') root.setAttribute('data-theme', initial);

  function label(btn) {
    var dark = effective() === 'dark';
    btn.textContent = dark ? '☀ Light' : '☾ Dark';
    btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  }
  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('theme-toggle');
    if (btn) {
      label(btn);
      btn.addEventListener('click', function () {
        var next = effective() === 'dark' ? 'light' : 'dark';
        root.setAttribute('data-theme', next);
        save(next);
        label(btn);
      });
      if (window.matchMedia) {
        var mq = matchMedia('(prefers-color-scheme: dark)');
        if (mq.addEventListener) mq.addEventListener('change', function () { label(btn); });
      }
    }
    fetch('/api/links').then(function (r) { return r.json(); }).then(function (l) {
      document.querySelectorAll('[data-link]').forEach(function (a) {
        var href = l[a.getAttribute('data-link')];
        if (href) a.setAttribute('href', href);
      });
    }).catch(function () { /* nav stays on relative links */ });
  });
})();
