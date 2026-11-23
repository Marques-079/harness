'use strict';
// Stale-while-revalidate holder for one expensive async computation (here: the
// fleet snapshot plus the board/queue payloads built from it).
//
//   - get() returns the last good result immediately whenever one exists; only
//     a caller arriving before the first success waits for a run.
//   - Runs never overlap: a refresh requested while one is in flight joins it.
//   - start() keeps the result warm on a steady interval in the background, so
//     a page opened after an idle gap never lands on a cold computation.
//   - A failed run keeps the last good result and marks it stale (with the
//     error) instead of replacing it; the next success clears the flag.

class Refresher {
  constructor(compute, { intervalMs = 5000, now = Date.now } = {}) {
    this.compute = compute;
    this.intervalMs = intervalMs;
    this.now = now;
    this.value = undefined; // last good result
    this.updatedAt = null; // when the last good result finished computing (ms)
    this.error = null; // { message, at } of the latest failed run, cleared by a success
    this.inflight = null;
    this.runs = 0;
    this._timer = null;
    this._running = false;
  }

  get hasValue() { return this.updatedAt !== null; }

  // Start one run, or join the run already in flight.
  refresh() {
    if (this.inflight) return this.inflight;
    this.runs++;
    const p = Promise.resolve()
      .then(() => this.compute())
      .then((value) => {
        this.value = value;
        this.updatedAt = this.now();
        this.error = null;
        return value;
      }, (err) => {
        this.error = { message: String((err && err.message) || err), at: this.now() };
        throw err;
      })
      .finally(() => { this.inflight = null; });
    this.inflight = p;
    p.catch(() => {}); // failures are surfaced through get() / meta()
    return p;
  }

  /**
   * @returns {Promise<{value: any, meta: object}>} the last good result, at
   *   once if there is one; otherwise waits for a run (and throws if it fails).
   *   When not started, an old result also triggers a background refresh.
   */
  async get() {
    if (!this.hasValue) {
      await this.refresh();
    } else if (!this._running && this.now() - this.updatedAt >= this.intervalMs) {
      this.refresh();
    }
    return { value: this.value, meta: this.meta() };
  }

  meta() {
    return {
      updatedAt: this.updatedAt,
      refreshMs: this.intervalMs,
      stale: Boolean(this.error),
      error: this.error ? this.error.message : null,
      errorAt: this.error ? this.error.at : null,
    };
  }

  // Background keep-warm loop: run now, then again intervalMs after each run
  // STARTS (or immediately if a run took longer than the interval). The timer
  // is unref'd so it never keeps the process alive on its own.
  start() {
    if (this._running) return this;
    this._running = true;
    const tick = () => {
      if (!this._running) return;
      const started = this.now();
      this.refresh().catch(() => {}).then(() => {
        if (!this._running) return;
        const wait = Math.max(0, this.intervalMs - (this.now() - started));
        this._timer = setTimeout(tick, wait);
        if (this._timer.unref) this._timer.unref();
      });
    };
    tick();
    return this;
  }

  stop() {
    this._running = false;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }
}

module.exports = { Refresher };
