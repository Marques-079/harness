'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inferStage, classifyPr, SHIP_STAGES, SCOUT_STAGES } = require('../src/stage');

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
  let r = inferStage({ task: live({ pr: { url: 'https://example.test/o/r/pull/1', source: 'meta' } }), git: { commitsAhead: 1 } });
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

const PR = 'https://github.com/example-owner/example-repo/pull/12';

test('a working worker whose status mentions a PR stays Executing; the PR is still linked', () => {
  // fm-fleet-snapshot.sh picks the first /pull/N URL from the status log (source status_event).
  const t = live({
    pr: { url: PR, source: 'status_event' },
    paths: { status_log: { last_event: { state: 'working', raw: `working: setup done, rebasing ${PR} onto origin/main` } } },
  });
  const r = inferStage({ task: t, record: { state: 'in_flight', kind: 'ship', pr_url: PR }, git: { commitsAhead: 2 } });
  assert.equal(r.stage, 'Executing');
  assert.equal(r.prUrl, PR);
  assert.equal(r.shippedPrUrl, null);
  assert.equal(inferStage({ task: t, git: { commitsAhead: 0 } }).stage, 'Planning');
  // Even with CI data passed in, an unshipped PR never advances the stage.
  assert.equal(inferStage({ task: t, git: { commitsAhead: 2 }, ci: { state: 'MERGED' } }).stage, 'Executing');
});

test('done with PR is PR open even when the snapshot only saw it in the status log', () => {
  const t = live({
    pr: { url: PR, source: 'status_event' },
    paths: { status_log: { last_event: { state: 'done', raw: `done: PR ${PR}` } } },
  });
  const r = inferStage({ task: t, git: { commitsAhead: 2 } });
  assert.equal(r.stage, 'PR open');
  assert.equal(r.shippedPrUrl, PR);
  assert.equal(r.ci, null);
});

const shipped = () => live({ pr: { url: PR, source: 'meta' } });
const ok = (name) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS' });

test('checks green and mergeable is CI passing', () => {
  const r = inferStage({ task: shipped(), ci: {
    state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
    statusCheckRollup: [ok('test'), { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SKIPPED' },
      { __typename: 'StatusContext', context: 'deploy/preview', state: 'SUCCESS' }],
  } });
  assert.equal(r.stage, 'CI passing');
  assert.deepEqual(r.ci, { label: 'Checks green · mergeable', tone: 'positive' });
  assert.equal(SHIP_STAGES.indexOf('CI passing'), SHIP_STAGES.indexOf('PR open') + 1);
  assert.equal(SHIP_STAGES.indexOf('Landed'), SHIP_STAGES.indexOf('CI passing') + 1);
});

test('failing, running or conflicting checks stay PR open with a sub-status', () => {
  const at = (ci) => inferStage({ task: shipped(), ci });
  let r = at({ state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'UNSTABLE',
    statusCheckRollup: [ok('lint'), { __typename: 'CheckRun', name: 'unit-tests', status: 'COMPLETED', conclusion: 'FAILURE' }] });
  assert.equal(r.stage, 'PR open');
  assert.deepEqual(r.ci, { label: 'CI failing: unit-tests', tone: 'danger' });
  assert.match(r.reason, /CI failing: unit-tests/);

  r = at({ state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'UNSTABLE',
    statusCheckRollup: [{ __typename: 'StatusContext', context: 'ci/legacy', state: 'ERROR' }] });
  assert.equal(r.ci.label, 'CI failing: ci/legacy');

  r = at({ state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED',
    statusCheckRollup: [ok('lint'), { __typename: 'CheckRun', name: 'build', status: 'IN_PROGRESS', conclusion: '' }] });
  assert.equal(r.stage, 'PR open');
  assert.deepEqual(r.ci, { label: 'CI running (1 pending)', tone: 'warning' });

  r = at({ state: 'OPEN', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', statusCheckRollup: [] });
  assert.equal(r.stage, 'PR open');
  assert.deepEqual(r.ci, { label: 'Merge conflicts', tone: 'danger' });

  r = at({ state: 'OPEN', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', statusCheckRollup: [ok('t')] });
  assert.equal(r.stage, 'PR open');
  assert.equal(r.ci.tone, 'warning');
});

test('a merged PR is Landed before the backlog catches up', () => {
  const r = inferStage({ task: shipped(), record: { state: 'in_flight', kind: 'ship' }, ci: { state: 'MERGED' } });
  assert.equal(r.stage, 'Landed');
  assert.equal(r.ci.label, 'Merged');
});

test('gh failure or no answer yet degrades to PR open and never throws', () => {
  for (const ci of [{ error: 'gh: not found' }, null, {}, { statusCheckRollup: 'garbage' }]) {
    const r = inferStage({ task: shipped(), ci });
    assert.equal(r.stage, 'PR open');
  }
  assert.deepEqual(inferStage({ task: shipped(), ci: { error: 'x' } }).ci, { label: 'CI status unavailable', tone: 'neutral' });
  assert.equal(inferStage({ task: shipped(), ci: { pending: true } }).ci.label, 'Checking CI…');
  assert.doesNotThrow(() => classifyPr({ statusCheckRollup: [null, 3, {}] }));
});
