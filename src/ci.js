'use strict';
// Live PR state from the forge via read-only `gh pr view`. This module only
// fetches and caches the raw JSON; src/stage.js (classifyPr) decides what it
// means. Every lookup is cached per PR for `ttlMs`, failures included, so the
// 4 s page poll never hammers GitHub. gh runs asynchronously: a stale entry is
// served immediately while it refreshes in the background, and a first lookup
// waits at most `waitMs` before the page renders without it. Never throws.

const { run } = require('./fm');

const FIELDS = 'statusCheckRollup,mergeable,mergeStateStatus,state';
// Only a plain forge PR URL is ever passed to gh (never something flag-like).
const PR_URL_RE = /^https:\/\/[A-Za-z0-9.-]+\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

class PrChecks {
  constructor({ runner = run, env, bin = 'gh', ttlMs = 60000, waitMs = 1500, timeoutMs = 15000 } = {}) {
    this.runner = runner;
    this.env = env;
    this.bin = bin;
    this.ttlMs = ttlMs;
    this.waitMs = waitMs;
    this.timeoutMs = timeoutMs;
    this.cache = new Map(); // url -> { at, value }
    this.inflight = new Map(); // url -> promise<value>
  }

  _fetch(url) {
    if (this.inflight.has(url)) return this.inflight.get(url);
    const p = Promise.resolve()
      .then(() => this.runner(this.bin, ['pr', 'view', url, '--json', FIELDS], { env: this.env, timeout: this.timeoutMs }))
      .then((out) => {
        const v = JSON.parse(out);
        if (!v || typeof v !== 'object') throw new Error('unexpected gh output');
        return v;
      })
      .catch((err) => ({ error: String((err && (err.stderr || err.message)) || err).trim().slice(0, 300) || 'gh failed' }))
      .then((value) => {
        this.cache.set(url, { at: Date.now(), value });
        this.inflight.delete(url);
        return value;
      });
    this.inflight.set(url, p);
    return p;
  }

  /**
   * @returns {Promise<object>} gh JSON, {error}, or {pending: true} when gh
   *   has not answered within waitMs (the answer lands in the cache later).
   */
  async lookup(url) {
    if (!url || !PR_URL_RE.test(url)) return { error: 'not a forge PR URL' };
    const hit = this.cache.get(url);
    if (hit) {
      if (Date.now() - hit.at >= this.ttlMs) this._fetch(url);
      return hit.value;
    }
    const pending = this._fetch(url);
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(resolve, this.waitMs, { pending: true }); });
    try {
      return await Promise.race([pending, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { PrChecks, PR_URL_RE };
