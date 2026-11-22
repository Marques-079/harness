'use strict';
// Page 2 model: one row per live worker, queued tasks separately, and recently
// landed work. Stage comes from ./stage (the single inference module).

const path = require('node:path');
const { inferStage } = require('./stage');
const { parseTime } = require('./queue');

const LANDED_LIMIT = 10;

async function buildBoard(snap, fm, prChecks = null) {
  const records = (snap.backlog && snap.backlog.records) || [];
  const structured = records.filter((r) => r.structured !== false && r.id);
  const tasks = snap.tasks || [];
  const liveIds = new Set(tasks.map((t) => t.id));

  const live = await Promise.all(tasks.map(async (task) => {
    const record = task.backlog || structured.find((r) => r.id === task.id) || null;
    const remote = Boolean(task.remote);
    const worktree = task.paths && task.paths.worktree && task.paths.worktree.path;
    const git = remote ? null : await fm.gitProgress(worktree);
    let stage = inferStage({ task, record, git });
    // Only a shipped PR (stage PR open) is worth a forge lookup.
    if (prChecks && stage.stage === 'PR open' && stage.shippedPrUrl) {
      stage = inferStage({ task, record, git, ci: await prChecks.lookup(stage.shippedPrUrl) });
    }
    const cs = task.current_state || {};
    const ev = (task.paths && task.paths.status_log && task.paths.status_log.last_event) || {};
    const statusAt = fm.mtime(task.paths && task.paths.status_log && task.paths.status_log.path);
    const lastAt = Math.max(statusAt || 0, (git && git.lastCommitAt) || 0) || null;
    const decisions = (task.hints && task.hints.open_decisions) || [];
    return {
      id: task.id,
      project: (record && record.repo) || (task.project ? path.basename(task.project) : null),
      kind: task.kind || (record && record.kind) || null,
      title: (record && record.title) || null,
      objective: fm.captainIntent(task.id),
      stage: stage.stage,
      stages: stage.stages,
      stageReason: stage.reason,
      prUrl: stage.prUrl,
      ci: stage.ci,
      state: cs.state || 'unknown',
      lastActivity: {
        text: ev.raw || cs.detail || null,
        current: cs.raw || null,
        at: lastAt,
      },
      waitingOnCaptain: decisions.length > 0 || Boolean(record && record.captain_actionable),
      remote,
    };
  }));

  const queued = structured
    .filter((r) => r.state !== 'done' && !liveIds.has(r.id))
    .map((r) => {
      const stage = inferStage({ record: r });
      return {
        id: r.id,
        project: r.repo || null,
        kind: r.kind || null,
        title: r.title || null,
        objective: fm.captainIntent(r.id),
        stage: stage.stage,
        stages: stage.stages,
        stageReason: stage.reason,
        state: r.state,
        hold: r.hold_kind ? { kind: r.hold_kind, reason: r.hold_reason, bucket: r.hold_bucket } : null,
        blockedBy: r.unresolved_blocker_ids || [],
        since: parseTime(r.since),
      };
    });

  const landed = structured
    .filter((r) => r.state === 'done')
    .map((r) => {
      const stage = inferStage({ record: r });
      return {
        id: r.id,
        project: r.repo || null,
        kind: r.kind || null,
        title: r.title || null,
        stage: stage.stage,
        stages: stage.stages,
        prUrl: stage.prUrl,
        doneAt: parseTime(r.done || (r.completion && r.completion.date)),
        doneDate: r.done || (r.completion && r.completion.date) || null,
        verb: (r.completion && r.completion.verb) || 'done',
      };
    })
    .sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0))
    .slice(0, LANDED_LIMIT);

  return { generated: snap.generated, live, queued, landed };
}

module.exports = { buildBoard };
