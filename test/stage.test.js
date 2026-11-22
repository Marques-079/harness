'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inferStage, SHIP_STAGES, SCOUT_STAGES } = require('../src/stage');

const live = (over = {}) => ({
  id: 't1', kind: 'ship',
  current_state: { state: 'working', source: 'pane', detail: 'busy' },
  pr: { url: null }, hints: {}, paths: { status_log: { last_event: { state: '', raw: '' } }, report: { present: false } },
  ...over,
});

test('queued backlog row with no worker is Received', () => {
  const r = inferStage({ record: { state: 'queued', kind: 'ship' } });
  assert.equal(r.stage, 'Received');
  assert.deepEqual(r.stages, SHIP_STAGES);
});

test('live worker with no commits is Planning', () => {
  assert.equal(inferStage({ task: live(), git: { commitsAhead: 0, dirty: false } }).stage, 'Planning');
  assert.equal(inferStage({ task: live(), git: null }).stage, 'Planning');
});

test('commits beyond base (or edits) is Executing', () => {
  assert.equal(inferStage({ task: live(), git: { commitsAhead: 2, dirty: false, base: 'origin/main' } }).stage, 'Executing');
  assert.equal(inferStage({ task: live(), git: { commitsAhead: 0, dirty: true } }).stage, 'Executing');
});

test('validation pipeline run-step is Reviewing, even with commits', () => {
  const t = live({ current_state: { state: 'working', source: 'run-step', detail: 'review running' } });
  const r = inferStage({ task: t, git: { commitsAhead: 3 } });
  assert.equal(r.stage, 'Reviewing');
  assert.match(r.reason, /review running/);
});

test('recorded PR is PR open, from meta pr= or a done: PR event', () => {
  let r = inferStage({ task: live({ pr: { url: 'https://example.test/o/r/pull/1' } }), git: { commitsAhead: 1 } });
  assert.equal(r.stage, 'PR open');
  assert.equal(r.prUrl, 'https://example.test/o/r/pull/1');
  r = inferStage({ task: live({ paths: { status_log: { last_event: { state: 'done', raw: 'done: PR https://example.test/o/r/pull/9' } } } }) });
  assert.equal(r.stage, 'PR open');
  assert.equal(r.prUrl, 'https://example.test/o/r/pull/9');
});

test('done backlog row is Landed', () => {
  const r = inferStage({ record: { state: 'done', kind: 'ship', pr_url: 'https://example.test/pull/3' } });
  assert.equal(r.stage, 'Landed');
  assert.equal(r.prUrl, 'https://example.test/pull/3');
});

test('scouts end at Report ready instead of PR', () => {
  const t = live({ kind: 'scout', hints: { scout_report_present: true }, pr: { url: 'https://example.test/pull/4' } });
  const r = inferStage({ task: t });
  assert.equal(r.stage, 'Report ready');
  assert.deepEqual(r.stages, SCOUT_STAGES);
  assert.equal(inferStage({ record: { state: 'done', kind: 'scout' } }).stage, 'Report ready');
  assert.equal(inferStage({ task: live({ kind: 'scout' }), git: { commitsAhead: 0 } }).stage, 'Planning');
});
