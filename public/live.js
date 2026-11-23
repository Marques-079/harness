// Shared polling loop for both pages: instant render from the last payload
// this browser saw, quiet reconnects, and an "updated Ns ago" status line.
//
//   HarnessLive.start({ url, cacheKey, statusEl, render, intervalMs }) -> { refresh }
//
// - The last good payload is kept in localStorage and rendered at once on load,
//   then replaced by fresh data (a subtle "updating…" shows while it loads).
// - Returning to the tab (visibilitychange / focus) refreshes immediately
//   instead of waiting for a (possibly throttled) timer.
// - A failed fetch keeps the data on screen and shows an amber "reconnecting…"
//   with backoff (1s, 2s, 4s, 8s, max 10s). Only after 30s of failures does the
//   status turn red. Success clears it silently.
// Errors from user actions (answer submission) are NOT routed through here.
(function () {
  var BACKOFF = [1000, 2000, 4000, 8000, 10000];
  var RED_AFTER_MS = 30000;
  var SLOW_MS = 250;

  function ago(ms) {
    var s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 90) return Math.round(s) + 's ago';
    if (s < 5400) return Math.round(s / 60) + 'm ago';
    if (s < 172800) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }
  function span(cls, text) {
    var n = document.createElement('span');
    if (cls) n.className = cls;
    n.textContent = text;
    return n;
  }
  function load(key) {
    try {
      var raw = localStorage.getItem(key);
      var v = raw && JSON.parse(raw);
      return v && v.data ? v : null;
    } catch (e) { return null; }
  }
  function save(key, data) {
    try { localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), data: data })); } catch (e) { /* storage unavailable or full */ }
  }

  function start(opts) {
    var intervalMs = opts.intervalMs || 4000;
    var st = {
      data: null, // payload on screen
      fromCache: false, // on-screen payload came from localStorage, not this session
      inflight: false,
      slow: false, // a fetch has been in flight for > SLOW_MS
      failingSince: null,
      failures: 0,
      lastError: null,
    };
    var timer = null;

    function updatedAt() {
      var d = st.data;
      return (d && d.fresh && d.fresh.updatedAt) || null;
    }

    function paint() {
      var el = opts.statusEl;
      var parts = [];
      var tone = '';
      var at = updatedAt();
      var age = at ? 'updated ' + ago(at) : null;
      if (st.failingSince) {
        var down = Date.now() - st.failingSince;
        tone = down > RED_AFTER_MS ? 'err' : 'warn';
        parts.push(down > RED_AFTER_MS
          ? 'Server unreachable for ' + ago(st.failingSince).replace(' ago', '') + (st.lastError ? ' (' + st.lastError + ')' : '')
          : 'Reconnecting…');
        if (st.data) parts.push('showing data ' + (age || 'from earlier'));
      } else if (!st.data) {
        parts.push('Loading…');
      } else {
        parts.push((st.fromCache ? 'Saved view' : 'Live') + (age ? ' · ' + age : ''));
        if (st.data.fresh && st.data.fresh.stale) {
          tone = 'warn';
          parts.push('Firstmate snapshot failing, showing last good data');
        }
      }
      var kids = [span('dot', ''), span(null, parts.join(' · '))];
      if ((st.slow || (st.fromCache && st.inflight)) && !st.failingSince) kids.push(span('statusline-busy', 'updating…'));
      el.className = 'statusline' + (tone ? ' ' + tone : '');
      el.title = (st.data && st.data.fresh && st.data.fresh.error) || st.lastError || '';
      el.replaceChildren.apply(el, kids);
    }

    function schedule(ms) {
      clearTimeout(timer);
      timer = setTimeout(refresh, ms);
    }

    function refresh() {
      if (st.inflight) return;
      st.inflight = true;
      clearTimeout(timer);
      var slowTimer = setTimeout(function () { st.slow = true; paint(); }, SLOW_MS);
      paint();
      fetch(opts.url, { cache: 'no-store' })
        .then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (j) {
            if (!r.ok) throw new Error(j.error || r.statusText || ('HTTP ' + r.status));
            return j;
          });
        })
        .then(function (j) {
          st.data = j;
          st.fromCache = false;
          st.failingSince = null;
          st.failures = 0;
          st.lastError = null;
          save(opts.cacheKey, j);
          opts.render(j);
          schedule(intervalMs);
        }, function (e) {
          if (!st.failingSince) st.failingSince = Date.now();
          st.lastError = (e && e.message) || String(e);
          schedule(BACKOFF[Math.min(st.failures, BACKOFF.length - 1)]);
          st.failures++;
        })
        .then(function () {
          clearTimeout(slowTimer);
          st.inflight = false;
          st.slow = false;
          paint();
        });
    }

    var cached = load(opts.cacheKey);
    if (cached) {
      st.data = cached.data;
      st.fromCache = true;
      try { opts.render(cached.data); } catch (e) { st.data = null; st.fromCache = false; }
    }
    paint();
    refresh();
    setInterval(paint, 1000); // keep "updated Ns ago" honest
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') refresh();
    });
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    return { refresh: refresh };
  }

  window.HarnessLive = { start: start, ago: ago };
})();
