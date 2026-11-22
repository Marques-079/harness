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

// A fake `gh` on a private PATH dir. `gh pr view <url> --json ...` prints
// responses[<url>] as JSON; a missing entry (or the string 'fail') exits 1.
// Every call is appended to `log` so tests can assert caching.
function fakeGh(responses = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-gh-'));
  const log = path.join(dir, 'calls.log');
  const data = path.join(dir, 'responses.json');
  const set = (r) => fs.writeFileSync(data, JSON.stringify(r));
  set(responses);
  const f = path.join(dir, 'gh');
  fs.writeFileSync(f, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n');
const r = JSON.parse(fs.readFileSync(${JSON.stringify(data)}, 'utf8'))[args[2]];
if (args[0] !== 'pr' || args[1] !== 'view' || r === undefined || r === 'fail') {
  process.stderr.write('fake gh: no such PR\\n'); process.exit(1);
}
process.stdout.write(JSON.stringify(r));
`);
  fs.chmodSync(f, 0o755);
  const env = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` };
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
  return { dir, env, calls, set };
}

module.exports = { makeHome, record, task, fakeGh };
