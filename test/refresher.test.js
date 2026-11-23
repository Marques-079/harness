'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Refresher } = require('../src/refresher');
const { makeHome, record, task } = require('./helpers');
const { createApp } = require('../src/server');

// A controllable async computation: each call returns a promise the test
// resolves or rejects by hand, and concurrency is tracked to catch overlap.
function gate() {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const compute = () => {
    active++;
    maxActive = Math.max(maxActive, active);
    return new Promise((resolve, reject) => {
      calls.push({
        resolve: (v) => { active--; resolve(v); },
        reject: (e) => { active--; reject(e); },
      });
    });
  };
  return { compute, calls, get maxActive() { return maxActive; } };
}
const tick = () => new Promise((r) => setImmediate(r));

test('first request waits for the first run; later ones get the cached value at once', async () => {
  const g = gate();
  let clock = 1000;
  const r = new Refresher(g.compute, { intervalMs: 5000, now: () => clock });
  const first = r.get();
  await tick();
  assert.equal(g.calls.length, 1);
  let settled = false;
  first.then(() => { settled = true; });
  await tick();
  assert.equal(settled, false, 'first request waits while nothing is cached');
  g.calls[0].resolve('v1');
  const a = await first;
  assert.equal(a.value, 'v1');
  assert.equal(a.meta.updatedAt, 1000);
  assert.equal(a.meta.stale, false);

  // Old enough to revalidate: the slow run starts, but callers are not held.
  clock = 7000;
  const b = await r.get();
  assert.equal(b.value, 'v1');
  await tick();
  assert.equal(g.calls.length, 2, 'background revalidation started');
  const c = await r.get();
  assert.equal(c.value, 'v1', 'served from cache while the slow run is in flight');
  assert.equal(g.calls.length, 2, 'no second run while one is in flight');
  g.calls[1].resolve('v2');
  await tick(); await tick();
  assert.equal((await r.get()).value, 'v2');
});

test('runs never overlap: concurrent refreshes join the in-flight run', async () => {
  const g = gate();
  const r = new Refresher(g.compute);
  const p1 = r.refresh();
  const p2 = r.refresh();
  const p3 = r.get();
  assert.equal(p1, p2);
  await tick();
  assert.equal(g.calls.length, 1);
  g.calls[0].resolve('only');
  assert.equal(await p2, 'only');
  assert.equal((await p3).value, 'only');
  assert.equal(g.maxActive, 1);
});

test('a failed run keeps the last good value and flags it stale until the next success', async () => {
  const g = gate();
  let clock = 0;
  const r = new Refresher(g.compute, { now: () => clock });
  const p = r.refresh(); await tick(); g.calls[0].resolve('good'); await p;
  clock = 10;
  const f = r.refresh(); await tick(); g.calls[1].reject(new Error('snapshot exploded'));
  await assert.rejects(f, /snapshot exploded/);
  const got = await r.get();
  assert.equal(got.value, 'good');
  assert.deepEqual(got.meta, { updatedAt: 0, refreshMs: 5000, stale: true, error: 'snapshot exploded', errorAt: 10 });
  const ok = r.refresh(); await tick(); g.calls[2].resolve('better'); await ok;
  const after = await r.get();
  assert.equal(after.value, 'better');
  assert.equal(after.meta.stale, false);
  assert.equal(after.meta.error, null);
});

test('with nothing cached, a failure reaches the caller and the next request retries', async () => {
  let n = 0;
  const r = new Refresher(async () => { n++; if (n === 1) throw new Error('down'); return 'up'; });
  await assert.rejects(r.get(), /down/);
  assert.equal((await r.get()).value, 'up');
  assert.equal(n, 2);
});

test('start() keeps the value warm on an interval without overlapping slow runs', async () => {
  let active = 0;
  let maxActive = 0;
  let runs = 0;
  const r = new Refresher(async () => {
    active++; runs++;
    maxActive = Math.max(maxActive, active);
    await new Promise((res) => setTimeout(res, 30)); // slower than the interval
    active--;
    return runs;
  }, { intervalMs: 10 });
  r.start();
  await new Promise((res) => setTimeout(res, 200));
  r.stop();
  const stoppedAt = runs;
  assert.ok(runs >= 3, `expected several background runs, got ${runs}`);
  assert.equal(maxActive, 1, 'background runs never overlap');
  assert.ok(r.hasValue);
  await new Promise((res) => setTimeout(res, 80));
  assert.ok(runs <= stoppedAt + 1, 'stop() ends the loop');
});

test('server: both endpoints serve the cached payload with freshness meta while a slow snapshot runs', async (t) => {
  const h = makeHome({});
  const rec = record({ id: 'demo-a', state: 'queued', hold_kind: 'captain', hold_bucket: 'live', captain_actionable: true, hold_reason: 'A or B?' });
  const snap = { schema: 'fm-fleet-snapshot.v1', generated: 'g1', backlog: { records: [rec] }, tasks: [task(h.home, { id: 'demo-b' })] };
  let slow = null; // when set, the fake snapshot hangs until released
  let snapshotRuns = 0;
  const runner = async (cmd, args) => {
    if (cmd.endsWith('fm-fleet-snapshot.sh')) {
      snapshotRuns++;
      if (slow) await slow.promise;
      return JSON.stringify(snap);
    }
    throw new Error(`unexpected command in test: ${cmd} ${args.join(' ')}`);
  };
  const app = createApp({ fmHome: h.home, runner, refreshMs: 60000 });
  for (const s of [app.queueServer, app.boardServer]) {
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    t.after(() => s.close());
  }
  const get = async (s, p) => (await fetch(`http://127.0.0.1:${s.address().port}${p}`)).json();

  const q1 = await get(app.queueServer, '/api/queue');
  assert.deepEqual(q1.items.map((i) => i.id), ['hold:demo-a']);
  assert.equal(typeof q1.fresh.updatedAt, 'number');
  assert.equal(q1.fresh.stale, false);
  assert.equal(q1.fresh.refreshMs, 60000);
  const b1 = await get(app.boardServer, '/api/board');
  assert.deepEqual(b1.live.map((w) => w.id), ['demo-b']);
  assert.equal(snapshotRuns, 1, 'both pages share one run');

  // A slow refresh is in flight: requests still answer from the last good run.
  let release;
  slow = { promise: new Promise((r) => { release = r; }) };
  snap.generated = 'g2';
  const running = app.refresher.refresh();
  const q2 = await get(app.queueServer, '/api/queue');
  const b2 = await get(app.boardServer, '/api/board');
  assert.equal(q2.generated, 'g1');
  assert.equal(b2.generated, 'g1');
  release();
  await running;
  assert.equal((await get(app.boardServer, '/api/board')).generated, 'g2');

  // A failing refresh keeps serving the last good payload, flagged stale.
  snap.schema = 'broken';
  slow = null;
  await assert.rejects(app.refresher.refresh(), /unexpected snapshot schema/);
  const b3 = await get(app.boardServer, '/api/board');
  assert.equal(b3.generated, 'g2');
  assert.equal(b3.fresh.stale, true);
  assert.match(b3.fresh.error, /unexpected snapshot schema/);
});
