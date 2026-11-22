'use strict';
// Page 1 model: one pooled list of everything waiting on the captain.
//   - captain-held backlog rows that are actionable now (snapshot
//     captain_actionable, i.e. hold_bucket == "live"); the hold reason carries
//     the question and options.
//   - open worker needs-decision / blocked events (snapshot
//     tasks[].hints.open_decisions, which is fm-classify-lib.sh's
//     status_open_decisions fold, already reconciled by Firstmate).

const path = require('node:path');

function parseTime(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) {
    const n = Number(v);
    return n < 1e12 ? n * 1000 : n;
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function projectName(task, record) {
  if (record && record.repo) return record.repo;
  if (task && task.backlog && task.backlog.repo) return task.backlog.repo;
  if (task && task.project) return path.basename(task.project);
  return null;
}

/**
 * @param {object} snap  fm-fleet-snapshot.v1 object
 * @param {(file: string) => number|null} mtime  file mtime lookup (ms)
 * @returns {Array<object>} items, newest first
 */
function buildQueue(snap, mtime = () => null) {
  const items = [];
  const seen = new Set();
  const records = (snap.backlog && snap.backlog.records) || [];
  const tasks = snap.tasks || [];

  const addHold = (record, task) => {
    if (!record || !record.id || record.state === 'done' || !record.captain_actionable) return;
    const id = `hold:${record.id}`;
    if (seen.has(id)) return;
    seen.add(id);
    items.push({
      id,
      type: 'captain-hold',
      taskId: record.id,
      key: null,
      project: projectName(task, record),
      title: record.title || null,
      question: record.hold_reason || '(no hold reason recorded)',
      context: record.body_excerpt || null,
      askedAt: parseTime(record.hold_set) || parseTime(record.since),
    });
  };

  for (const r of records) {
    if (r.structured === false) continue;
    addHold(r, tasks.find((t) => t.id === r.id));
  }
  for (const t of tasks) {
    addHold(t.backlog, t);
    const decisions = (t.hints && t.hints.open_decisions) || [];
    for (const d of decisions) {
      const id = `decision:${t.id}:${d.key || 'default'}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const statusPath = t.paths && t.paths.status_log && t.paths.status_log.path;
      items.push({
        id,
        type: d.verb === 'blocked' ? 'blocked' : 'needs-decision',
        taskId: t.id,
        key: d.key || 'default',
        project: projectName(t, t.backlog),
        title: (t.backlog && t.backlog.title) || null,
        question: d.summary || '(no summary)',
        context: null,
        askedAt: mtime(statusPath),
      });
    }
  }

  items.sort((a, b) => (b.askedAt || 0) - (a.askedAt || 0));
  return items;
}

// The note Firstmate receives. Keyed decisions carry their key so Firstmate can
// close the right one; captain holds route by task id alone.
function formatAnswer(item, text) {
  const keyTag = item.type === 'captain-hold' || !item.key || item.key === 'default' ? '' : ` [key=${item.key}]`;
  return `answer ${item.taskId}${keyTag}: ${text}\n`;
}

module.exports = { buildQueue, formatAnswer, parseTime };
