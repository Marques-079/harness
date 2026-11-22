'use strict';
// Stage inference. Workers do not report their stage explicitly yet, so this
// module derives it from records Firstmate already keeps plus the PR's live
// checks on the forge. It is deliberately the ONLY place that knows these
// rules: when workers start reporting stages, replace inferStage() and nothing
// else needs to change. (src/ci.js only fetches and caches the raw `gh pr view`
// JSON; how it maps to a stage lives here in classifyPr().)
//
// Pipelines:
//   ship:  Received -> Planning -> Executing -> Reviewing -> PR open -> CI passing -> Landed
//   scout: Received -> Planning -> Executing -> Report ready
//
// Rules, first match wins:
//   Landed        backlog row is Done (scouts show Report ready instead), or
//                 the shipped PR is merged on the forge
//   Received      backlog row is queued, or there is no live worker
//   Report ready  scout whose report.md exists
//   CI passing    shipped PR is open, every check succeeded, and it is
//                 mergeable (no conflicts)
//   PR open       ship with a SHIPPED PR: meta pr= (snapshot pr.source "meta")
//                 or a `done: ... PR <url>` status event. Sub-status shows CI
//                 running / failing / merge conflicts / unavailable.
//   Reviewing     the no-mistakes validation pipeline owns the branch, i.e.
//                 fm-crew-state.sh reads its state from source "run-step"
//   Executing     the worker branch has commits beyond its base (or edits in
//                 its worktree)
//   Planning      worker live, nothing committed yet
//
// A PR URL merely MENTIONED while working (fm-fleet-snapshot.sh falls back to
// the first /pull/N URL anywhere in the status log, pr.source "status_event";
// or a backlog row linking the PR a task should rebase) is still returned as
// prUrl for the card, but never advances the stage.

const SHIP_STAGES = ['Received', 'Planning', 'Executing', 'Reviewing', 'PR open', 'CI passing', 'Landed'];
const SCOUT_STAGES = ['Received', 'Planning', 'Executing', 'Report ready'];

const PR_EVENT_RE = /\bPR\s+(https:\/\/\S+)/;

function stagesFor(kind) {
  return kind === 'scout' ? SCOUT_STAGES : SHIP_STAGES;
}

function lastEvent(task) {
  return (task && task.paths && task.paths.status_log && task.paths.status_log.last_event) || null;
}

// The PR a worker has SHIPPED: recorded by Firstmate (meta pr=) or reported in
// a terminal `done:` event. Only this advances a live ship to PR open.
function findShippedPrUrl({ task } = {}) {
  if (task && task.pr && task.pr.url && task.pr.source === 'meta') return task.pr.url;
  const ev = lastEvent(task);
  if (ev && ev.state === 'done') {
    const m = PR_EVENT_RE.exec(ev.raw || ev.note || '');
    if (m) return m[1].replace(/[),.;]+$/, '');
  }
  return null;
}

// Any PR linked to the task, for display: shipped first, then whatever the
// snapshot or backlog row mentions.
function findPrUrl({ task, record } = {}) {
  return findShippedPrUrl({ task })
    || (task && task.pr && task.pr.url)
    || (record && record.pr_url)
    || null;
}

const FAIL_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE']);
const FAIL_STATES = new Set(['FAILURE', 'ERROR']);

/**
 * Map `gh pr view --json statusCheckRollup,mergeable,mergeStateStatus,state`
 * (or {error} / {pending} from src/ci.js) to a stage verdict.
 * @returns {{verdict: 'merged'|'passing'|'open', label: string, tone: string}}
 *   tone is one of positive | warning | danger | neutral.
 */
function classifyPr(pr) {
  if (pr && pr.pending) return { verdict: 'open', label: 'Checking CI…', tone: 'neutral' };
  if (!pr || pr.error) return { verdict: 'open', label: 'CI status unavailable', tone: 'neutral' };
  const state = String(pr.state || '').toUpperCase();
  if (state === 'MERGED') return { verdict: 'merged', label: 'Merged', tone: 'positive' };
  if (state === 'CLOSED') return { verdict: 'open', label: 'PR closed without merging', tone: 'danger' };
  const mergeable = String(pr.mergeable || '').toUpperCase();
  const mss = String(pr.mergeStateStatus || '').toUpperCase();
  const conflicts = mergeable === 'CONFLICTING' || mss === 'DIRTY';

  const checks = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
  const failing = [];
  let running = 0;
  for (const c of checks) {
    if (!c || typeof c !== 'object') continue;
    const name = c.name || c.context || 'check';
    if (c.__typename === 'StatusContext' || (c.state && !c.status)) {
      const s = String(c.state || '').toUpperCase();
      if (FAIL_STATES.has(s)) failing.push(name);
      else if (s !== 'SUCCESS') running++;
    } else {
      const status = String(c.status || '').toUpperCase();
      const conclusion = String(c.conclusion || '').toUpperCase();
      if (status && status !== 'COMPLETED') running++;
      else if (FAIL_CONCLUSIONS.has(conclusion)) failing.push(name);
    }
  }

  if (conflicts) {
    const extra = failing.length ? ` · CI failing: ${failing[0]}` : '';
    return { verdict: 'open', label: `Merge conflicts${extra}`, tone: 'danger' };
  }
  if (failing.length) {
    const more = failing.length > 1 ? ` (+${failing.length - 1} more)` : '';
    return { verdict: 'open', label: `CI failing: ${failing[0]}${more}`, tone: 'danger' };
  }
  if (running) return { verdict: 'open', label: `CI running (${running} pending)`, tone: 'warning' };
  if (mergeable !== 'MERGEABLE') return { verdict: 'open', label: 'Checks green · mergeability pending', tone: 'warning' };
  const note = checks.length ? 'Checks green · mergeable' : 'No checks · mergeable';
  return { verdict: 'passing', label: mss === 'BLOCKED' ? `${note} · awaiting review` : note, tone: 'positive' };
}

/**
 * @param {object} input
 * @param {object} [input.task]   snapshot tasks[] row (live worker), if any
 * @param {object} [input.record] snapshot backlog record, if any
 * @param {object} [input.git]    { commitsAhead, dirty } from the worker worktree
 * @param {object} [input.ci]     raw `gh pr view` JSON for the shipped PR, {error} or {pending}
 * @returns {{stage: string, stages: string[], reason: string, prUrl: string|null,
 *            shippedPrUrl: string|null, ci: {label: string, tone: string}|null}}
 */
function inferStage({ task = null, record = null, git = null, ci = undefined } = {}) {
  const kind = (task && task.kind) || (record && record.kind) || 'ship';
  const stages = stagesFor(kind);
  const prUrl = findPrUrl({ task, record });
  const shippedPrUrl = findShippedPrUrl({ task });
  const out = (stage, reason, ciStatus = null) => ({ stage, stages, reason, prUrl, shippedPrUrl, ci: ciStatus });

  if (record && record.state === 'done') {
    return kind === 'scout' ? out('Report ready', 'backlog: done') : out('Landed', 'backlog: done');
  }
  if (!task || (record && record.state === 'queued')) {
    return out('Received', task ? 'backlog: queued' : 'no live worker');
  }
  if (kind === 'scout') {
    const reportPresent = (task.hints && task.hints.scout_report_present)
      || (task.paths && task.paths.report && task.paths.report.present);
    if (reportPresent) return out('Report ready', 'report.md present');
  } else if (shippedPrUrl) {
    const how = task.pr && task.pr.source === 'meta' && task.pr.url === shippedPrUrl ? 'PR recorded' : 'worker reported done with PR';
    if (ci === undefined) return out('PR open', how);
    const c = classifyPr(ci);
    const status = { label: c.label, tone: c.tone };
    if (c.verdict === 'merged') return out('Landed', 'PR merged on the forge', status);
    if (c.verdict === 'passing') return out('CI passing', c.label, status);
    return out('PR open', `${how} · ${c.label}`, status);
  }
  const cs = task.current_state || {};
  if (cs.source === 'run-step' && kind !== 'scout') {
    return out('Reviewing', `validation pipeline: ${cs.detail || cs.state || 'running'}`);
  }
  if (git && (git.commitsAhead > 0 || git.dirty)) {
    return out('Executing', git.commitsAhead > 0
      ? `${git.commitsAhead} commit(s) beyond ${git.base || 'base'}`
      : 'uncommitted edits in worktree');
  }
  return out('Planning', git ? 'no commits beyond base yet' : 'worker live; worktree not readable');
}

module.exports = { inferStage, findPrUrl, findShippedPrUrl, classifyPr, SHIP_STAGES, SCOUT_STAGES };
