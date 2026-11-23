'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { makeHome, record, task } = require('./helpers');
const { createApp } = require('../src/server');
const { buildQueue, formatAnswer } = require('../src/queue');

function fixture(home) {
  const held = record({
    id: 'demo-held', state: 'queued', hold_kind: 'captain', hold_bucket: 'live', captain_actionable: true,
    hold_reason: 'Pick A or B?', hold_set: '2026-01-02T00:00:00Z',
  });
  const deferred = record({ id: 'demo-deferred', state: 'queued', hold_kind: 'captain', hold_bucket: 'dated', captain_actionable: false, hold_reason: 'later' });
  const workerRec = record({ id: 'demo-worker' });
  const worker = task(home, {
    id: 'demo-worker', backlog: workerRec,
    hints: { open_decisions: [{ key: 'api-shape', verb: 'needs-decision', summary: 'REST or RPC?' }] },
  });
  return { schema: 'fm-fleet-snapshot.v1', generated: '2026-01-03T00:00:00Z', backlog: { records: [held, deferred, workerRec] }, tasks: [worker] };
}

async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}

test('queue pools live captain holds and open worker decisions only', () => {
  const { home } = makeHome({});
  const items = buildQueue(fixture(home));
  assert.deepEqual(items.map((i) => i.id).sort(), ['decision:demo-worker:api-shape', 'hold:demo-held']);
  const hold = items.find((i) => i.type === 'captain-hold');
  assert.equal(hold.question, 'Pick A or B?');
  assert.equal(hold.project, 'demo-repo');
});

test('answer format routes by task id and decision key', () => {
  assert.equal(formatAnswer({ type: 'captain-hold', taskId: 't', key: null }, 'go A'), 'answer t: go A\n');
  assert.equal(formatAnswer({ type: 'needs-decision', taskId: 't', key: 'k1' }, 'RPC'), 'answer t [key=k1]: RPC\n');
  assert.equal(formatAnswer({ type: 'blocked', taskId: 't', key: 'default' }, 'ok'), 'answer t: ok\n');
});

test('submitting an answer only invokes fm-inbox.sh note - and marks it sent', async (t) => {
  const h = makeHome({});
  h.setSnapshot(fixture(h.home));
  const stateBefore = fs.readdirSync(`${h.home}/state`);
  const app = createApp({ fmHome: h.home });
  const base = await listen(app.queueServer);
  t.after(() => app.queueServer.close());

  const res = await fetch(`${base}/api/answer`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'decision:demo-worker:api-shape', text: '  RPC please\nand log it ' }),
  });
  assert.equal(res.status, 200);

  const log = fs.readFileSync(h.calls, 'utf8');
  assert.equal(log, 'fm-inbox.sh note -\nanswer demo-worker [key=api-shape]: RPC please\nand log it\n--end--\n');
  assert.doesNotMatch(log, /FORBIDDEN/);
  assert.deepEqual(fs.readdirSync(`${h.home}/state`), stateBefore, 'app wrote nothing to state/');

  const q = await (await fetch(`${base}/api/queue`)).json();
  const item = q.items.find((i) => i.id === 'decision:demo-worker:api-shape');
  assert.equal(item.sent.text, 'RPC please\nand log it');

  // Once Firstmate resolves it, the item (and its sent marker) leaves the queue.
  const snap = fixture(h.home);
  snap.tasks[0].hints.open_decisions = [];
  h.setSnapshot(snap);
  await app.refresher.refresh();
  const q2 = await (await fetch(`${base}/api/queue`)).json();
  assert.deepEqual(q2.items.map((i) => i.id), ['hold:demo-held']);
  assert.equal(app.desk.sent.size, 0);
});

test('answers for unknown items, empty answers, and cross-origin posts are refused without writing', async (t) => {
  const h = makeHome({});
  h.setSnapshot(fixture(h.home));
  const app = createApp({ fmHome: h.home });
  const base = await listen(app.queueServer);
  t.after(() => app.queueServer.close());
  const post = (body, headers = {}) => fetch(`${base}/api/answer`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });

  assert.equal((await post({ id: 'hold:not-there', text: 'x' })).status, 404);
  assert.equal((await post({ id: 'hold:demo-deferred', text: 'x' })).status, 404);
  assert.equal((await post({ id: 'hold:demo-held', text: '   ' })).status, 400);
  assert.equal((await post({ id: 'hold:demo-held', text: 'x' }, { origin: 'http://evil.test' })).status, 403);
  const form = await fetch(`${base}/api/answer`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(form.status, 403);
  assert.equal(fs.existsSync(h.calls), false, 'no script was invoked');
});
