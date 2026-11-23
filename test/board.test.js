'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { makeHome, record, task, fakeGh } = require('./helpers');
const { PrChecks } = require('../src/ci');
const { createApp } = require('../src/server');

test('board shows live workers with objective, stage and PR; queued and landed separately', async (t) => {
  const h = makeHome({});
  // A worker worktree with one commit beyond origin/main.
  const wt = path.join(h.home, 'wt');
  const git = (...a) => execFileSync('git', ['-C', wt, ...a], { stdio: 'pipe' });
  fs.mkdirSync(wt);
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '--allow-empty', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '--allow-empty', '-m', 'work');

  fs.mkdirSync(path.join(h.home, 'data', 'demo-exec'));
  fs.writeFileSync(path.join(h.home, 'data', 'demo-exec', 'brief.md'),
    "# Task\n## Captain's intent\nMake the widget faster.\n\n## Firstmate spec\nstuff\n");

  const execRec = record({ id: 'demo-exec' });
  const prRec = record({ id: 'demo-pr' });
  const execTask = task(h.home, { id: 'demo-exec', backlog: execRec });
  execTask.paths.worktree = { path: wt, present: true };
  const prTask = task(h.home, { id: 'demo-pr', backlog: prRec, pr: { url: 'https://example.test/o/r/pull/7', source: 'meta' } });
  h.setSnapshot({
    schema: 'fm-fleet-snapshot.v1', generated: 'g',
    backlog: { records: [execRec, prRec,
      record({ id: 'demo-queued', state: 'queued' }),
      record({ id: 'demo-landed', state: 'done', done: '2026-01-05', completion: { verb: 'merged', date: '2026-01-05' } })] },
    tasks: [execTask, prTask],
  });

  const gh = fakeGh({}); // no responses: every lookup fails -> degraded
  const app = createApp({ fmHome: h.home, prChecks: new PrChecks({ env: gh.env, waitMs: 10000 }) });
  await new Promise((r) => app.boardServer.listen(0, '127.0.0.1', r));
  t.after(() => app.boardServer.close());
  const b = await (await fetch(`http://127.0.0.1:${app.boardServer.address().port}/api/board`)).json();

  const exec = b.live.find((w) => w.id === 'demo-exec');
  assert.equal(exec.stage, 'Executing');
  assert.equal(exec.objective, 'Make the widget faster.');
  const pr = b.live.find((w) => w.id === 'demo-pr');
  assert.equal(pr.stage, 'PR open');
  assert.equal(pr.prUrl, 'https://example.test/o/r/pull/7');
  assert.deepEqual(pr.ci, { label: 'CI status unavailable', tone: 'neutral' });
  assert.deepEqual(b.queued.map((q) => [q.id, q.stage]), [['demo-queued', 'Received']]);
  assert.deepEqual(b.landed.map((q) => [q.id, q.stage]), [['demo-landed', 'Landed']]);
});

test('config: env defaults and CLI overrides', () => {
  const { loadConfig } = require('../src/config');
  const c = loadConfig(['--queue-port', '5000', '--board-port=5001'], { FM_HOME: '/x', HARNESS_QUEUE_PORT: '4000' });
  assert.equal(c.fmHome, '/x');
  assert.equal(c.queuePort, 5000);
  assert.equal(c.boardPort, 5001);
  const d = loadConfig([], {});
  assert.equal(d.queuePort, 4710);
  assert.equal(d.boardPort, 4711);
  assert.equal(d.refreshMs, 5000);
  assert.equal(loadConfig(['--refresh-ms', '2000'], { HARNESS_REFRESH_MS: '9000' }).refreshMs, 2000);
  assert.equal(loadConfig([], { HARNESS_REFRESH_MS: '9000' }).refreshMs, 9000);
  assert.throws(() => loadConfig(['--refresh-ms', '0'], {}), /refresh interval/);
});

test('pages are served as HTML', async (t) => {
  const h = makeHome({ schema: 'fm-fleet-snapshot.v1', backlog: { records: [] }, tasks: [] });
  const app = createApp({ fmHome: h.home });
  for (const s of [app.queueServer, app.boardServer]) {
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    t.after(() => s.close());
    const res = await fetch(`http://127.0.0.1:${s.address().port}/`);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /^<!doctype html>/);
  }
});

test('shared theme assets and cross-page links are served on both ports', async (t) => {
  const h = makeHome({ schema: 'fm-fleet-snapshot.v1', backlog: { records: [] }, tasks: [] });
  const app = createApp({ fmHome: h.home });
  for (const s of [app.queueServer, app.boardServer]) {
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    t.after(() => s.close());
  }
  app.ports.queue = app.queueServer.address().port;
  app.ports.board = app.boardServer.address().port;
  for (const port of [app.ports.queue, app.ports.board]) {
    const css = await fetch(`http://127.0.0.1:${port}/assets/theme.css`);
    assert.match(css.headers.get('content-type'), /text\/css/);
    assert.match(await css.text(), /prefers-color-scheme: dark/);
    for (const asset of ['theme.js', 'live.js']) {
      const js = await fetch(`http://127.0.0.1:${port}/assets/${asset}`);
      assert.match(js.headers.get('content-type'), /javascript/);
    }
    const links = await (await fetch(`http://127.0.0.1:${port}/api/links`)).json();
    assert.deepEqual(links, {
      queue: `http://127.0.0.1:${app.ports.queue}/`,
      board: `http://127.0.0.1:${app.ports.board}/`,
    });
  }
});
