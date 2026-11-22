'use strict';
// Stage inference. Workers do not report their stage explicitly yet, so this
// module derives it from records Firstmate already keeps. It is deliberately
// the ONLY place that knows these rules: when workers start reporting stages,
// replace inferStage() and nothing else needs to change.
//
// Pipelines:
//   ship:  Received -> Planning -> Executing -> Reviewing -> PR open -> Landed
//   scout: Received -> Planning -> Executing -> Report ready
//
// Rules, first match wins:
//   Landed        backlog row is Done (scouts show Report ready instead)
//   Received      backlog row is queued, or there is no live worker
//   Report ready  scout whose report.md exists
//   PR open       ship with a PR recorded (meta pr=, snapshot pr.url, backlog
//                 pr_url) or a `done: PR <url>` status event
//   Reviewing     the no-mistakes validation pipeline owns the branch, i.e.
//                 fm-crew-state.sh reads its state from source "run-step"
//   Executing     the worker branch has commits beyond its base (or edits in
//                 its worktree)
//   Planning      worker live, nothing committed yet

const SHIP_STAGES = ['Received', 'Planning', 'Executing', 'Reviewing', 'PR open', 'Landed'];
const SCOUT_STAGES = ['Received', 'Planning', 'Executing', 'Report ready'];

const PR_EVENT_RE = /\bPR\s+(https:\/\/\S+)/;

function stagesFor(kind) {
  return kind === 'scout' ? SCOUT_STAGES : SHIP_STAGES;
}

// Find a PR URL from any record Firstmate keeps.
function findPrUrl({ task, record } = {}) {
  if (task && task.pr && task.pr.url) return task.pr.url;
  if (record && record.pr_url) return record.pr_url;
  const ev = task && task.paths && task.paths.status_log && task.paths.status_log.last_event;
  if (ev && ev.state === 'done') {
    const m = PR_EVENT_RE.exec(ev.raw || ev.note || '');
    if (m) return m[1].replace(/[),.;]+$/, '');
  }
  return null;
}

/**
 * @param {object} input
 * @param {object} [input.task]   snapshot tasks[] row (live worker), if any
 * @param {object} [input.record] snapshot backlog record, if any
 * @param {object} [input.git]    { commitsAhead, dirty } from the worker worktree
 * @returns {{stage: string, stages: string[], reason: string, prUrl: string|null}}
 */
function inferStage({ task = null, record = null, git = null } = {}) {
  const kind = (task && task.kind) || (record && record.kind) || 'ship';
  const stages = stagesFor(kind);
  const prUrl = findPrUrl({ task, record });
  const out = (stage, reason) => ({ stage, stages, reason, prUrl });

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
  } else if (prUrl) {
    return out('PR open', 'PR recorded');
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

module.exports = { inferStage, findPrUrl, SHIP_STAGES, SCOUT_STAGES };
