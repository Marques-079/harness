'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeHome, record, task, fakeGh } = require('./helpers');
const { PrChecks } = require('../src/ci');
const { createApp } = require('../src/server');

const url = (n) => `https://github.com/example-owner/example-repo/pull/${n}`;
const green = { state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] };

test('lookups are cached per PR, failures included', async () => {
  const gh = fakeGh({ [url(1)]: green });
  const c = new PrChecks({ env: gh.env, ttlMs: 60000, waitMs: 10000 });
  assert.deepEqual(await c.lookup(url(1)), green);
  assert.deepEqual(await c.lookup(url(1)), green);
  const failed = await c.lookup(url(2));
  assert.match(failed.error, /fake gh/);
  await c.lookup(url(2));
  assert.deepEqual(gh.calls(), [
    `pr view ${url(1)} --json statusCheckRollup,mergeable,mergeStateStatus,state`,
    `pr view ${url(2)} --json statusCheckRollup,mergeable,mergeStateStatus,state`,
  ]);
});

test('a stale entry is served immediately and refreshed in the background', async () => {
  const gh = fakeGh({ [url(3)]: green });
  const c = new PrChecks({ env: gh.env, ttlMs: 0, waitMs: 10000 });
  await c.lookup(url(3));
  gh.set({ [url(3)]: { state: 'MERGED' } });
  assert.deepEqual(await c.lookup(url(3)), green); // stale value, refresh kicked off
  await c.inflight.get(url(3));
  assert.deepEqual(await c.lookup(url(3)), { state: 'MERGED' });
});

test('a slow gh never blocks: first lookup returns pending after waitMs', async () => {
  let release;
  const runner = () => new Promise((r) => { release = () => r(JSON.stringify(green)); });
  const c = new PrChecks({ runner, waitMs: 20 });
  assert.deepEqual(await c.lookup(url(4)), { pending: true });
  release();
  await c.inflight.get(url(4));
  assert.deepEqual(await c.lookup(url(4)), green);
});

test('missing gh binary or bad URLs degrade, never throw', async () => {
  const c = new PrChecks({ bin: 'gh-does-not-exist-harness', waitMs: 2000 });
  assert.ok((await c.lookup(url(5))).error);
  assert.ok((await c.lookup('--help')).error);
  assert.ok((await c.lookup(null)).error);
  const bad = new PrChecks({ runner: async () => 'not json', waitMs: 2000 });
  assert.ok((await bad.lookup(url(6))).error);
});

test('board: CI passing, PR open with sub-status, merged -> Landed, mentioned PR stays Executing', async (t) => {
  const h = makeHome({});
  const mk = (id, n, over = {}) => {
    const rec = record({ id });
    return [rec, task(h.home, { id, backlog: rec, pr: { url: url(n), source: 'meta' }, ...over })];
  };
  const [r1, t1] = mk('demo-green', 10);
  const [r2, t2] = mk('demo-conflict', 11);
  const [r3, t3] = mk('demo-merged', 12);
  const [r4, t4] = mk('demo-rebase', 13, { pr: { url: url(13), source: 'status_event' } });
  t4.paths.status_log.last_event = { state: 'working', raw: `working: setup done, rebasing ${url(13)} onto origin/main` };
  h.setSnapshot({ schema: 'fm-fleet-snapshot.v1', generated: 'g',
    backlog: { records: [r1, r2, r3, r4] }, tasks: [t1, t2, t3, t4] });
  const gh = fakeGh({
    [url(10)]: green,
    [url(11)]: { ...green, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
    [url(12)]: { state: 'MERGED' },
    [url(13)]: { state: 'MERGED' },
  });
  const app = createApp({ fmHome: h.home, cacheMs: 0, prChecks: new PrChecks({ env: gh.env, waitMs: 10000 }) });
  await new Promise((r) => app.boardServer.listen(0, '127.0.0.1', r));
  t.after(() => app.boardServer.close());
  const get = async () => (await (await fetch(`http://127.0.0.1:${app.boardServer.address().port}/api/board`)).json());
  const b = await get();
  const by = Object.fromEntries(b.live.map((w) => [w.id, w]));
  assert.equal(by['demo-green'].stage, 'CI passing');
  assert.equal(by['demo-conflict'].stage, 'PR open');
  assert.deepEqual(by['demo-conflict'].ci, { label: 'Merge conflicts', tone: 'danger' });
  assert.equal(by['demo-merged'].stage, 'Landed');
  assert.equal(by['demo-rebase'].stage, 'Planning');
  assert.equal(by['demo-rebase'].prUrl, url(13));
  assert.equal(by['demo-rebase'].ci, null);
  // The mentioned-only PR is never looked up; repeat polls reuse the cache.
  await get();
  assert.equal(gh.calls().length, 3);
  assert.ok(!gh.calls().some((c) => c.includes(url(13))));
});
