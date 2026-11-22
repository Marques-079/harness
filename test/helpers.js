'use strict';
// Synthetic Firstmate home for tests. Nothing here is copied from a live home.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function record(over) {
  return {
    structured: true, state: 'in_flight', kind: 'ship', repo: 'demo-repo', title: 'demo task',
    hold_reason: null, hold_kind: null, hold_until: null, hold_set: null, hold_bucket: null,
    captain_actionable: false, unresolved_blocker_ids: [], since: '2026-01-01', done: null,
    completion: { verb: null, date: null }, pr_url: null, body_excerpt: null, ...over,
  };
}

function task(home, over) {
  const id = over.id;
  return {
    kind: 'ship', project: path.join(home, 'projects', 'demo-repo'), remote: null,
    paths: {
      status_log: { path: path.join(home, 'state', `${id}.status`), present: true, last_event: { state: '', note: '', raw: '' } },
      worktree: { path: null, present: false },
      report: { path: path.join(home, 'data', id, 'report.md'), present: false },
    },
    current_state: { state: 'working', source: 'pane', detail: 'busy', raw: 'state: working · source: pane · busy' },
    pr: { url: null, source: 'absent' },
    hints: { open_decisions: [], scout_report_present: false },
    backlog: null,
    ...over,
  };
}

function makeHome(snapshot) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-fm-'));
  for (const d of ['bin', 'state', 'data']) fs.mkdirSync(path.join(home, d));
  const calls = path.join(home, 'calls.log');
  fs.writeFileSync(path.join(home, 'snapshot.json'), JSON.stringify(snapshot));
  const script = (name, body) => {
    const f = path.join(home, 'bin', name);
    fs.writeFileSync(f, `#!/usr/bin/env bash\n${body}\n`);
    fs.chmodSync(f, 0o755);
  };
  script('fm-fleet-snapshot.sh', `cat "$FM_HOME/snapshot.json"`);
  // Records every invocation (argv + stdin) so tests can assert the write path.
  script('fm-inbox.sh', `body=$(cat); printf 'fm-inbox.sh %s\\n%s\\n--end--\\n' "$*" "$body" >> "$FM_HOME/calls.log"`);
  for (const forbidden of ['fm-send.sh', 'fm-captain-hold.sh']) {
    script(forbidden, `echo "FORBIDDEN ${forbidden} $*" >> "$FM_HOME/calls.log"`);
  }
  return { home, calls, setSnapshot: (s) => fs.writeFileSync(path.join(home, 'snapshot.json'), JSON.stringify(s)) };
}

module.exports = { makeHome, record, task };
