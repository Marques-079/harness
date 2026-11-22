'use strict';
// Firstmate data-source layer. Everything the app knows about the fleet comes
// through here, and everything here is READ-ONLY against $FM_HOME, with exactly
// one exception: submitAnswer() hands the captain's answer to
// `bin/fm-inbox.sh note -`, Firstmate's own capture surface. The app never
// writes to state/ or data/ itself and never calls fm-send / fm-captain-hold.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function run(cmd, args, { input, timeout = 30000, env, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout, env, cwd, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = stderr;
          return reject(err);
        }
        resolve(stdout);
      });
    if (input !== undefined) child.stdin.end(input);
  });
}

class Firstmate {
  constructor(fmHome, { cacheMs = 3000, runner = run } = {}) {
    this.home = fmHome;
    this.cacheMs = cacheMs;
    this.runner = runner;
    this._snap = null; // { at, promise }
  }

  bin(name) { return path.join(this.home, 'bin', name); }

  env() { return { ...process.env, FM_HOME: this.home }; }

  // fm-fleet-snapshot.sh --json (schema fm-fleet-snapshot.v1). Cached briefly so
  // both pages and several browser tabs share one execution per refresh window.
  snapshot() {
    const now = Date.now();
    if (this._snap && now - this._snap.at < this.cacheMs) return this._snap.promise;
    const promise = this.runner(this.bin('fm-fleet-snapshot.sh'), ['--json'], { env: this.env(), timeout: 60000 })
      .then((out) => {
        const snap = JSON.parse(out);
        if (snap.schema !== 'fm-fleet-snapshot.v1') {
          throw new Error(`unexpected snapshot schema: ${snap.schema}`);
        }
        return snap;
      });
    this._snap = { at: now, promise };
    promise.catch(() => { if (this._snap && this._snap.promise === promise) this._snap = null; });
    return promise;
  }

  // The `## Captain's intent` section of data/<id>/brief.md: the worker's overall objective.
  captainIntent(taskId) {
    if (!/^[A-Za-z0-9._-]+$/.test(taskId)) return null;
    let text;
    try {
      text = fs.readFileSync(path.join(this.home, 'data', taskId, 'brief.md'), 'utf8');
    } catch {
      return null;
    }
    return extractSection(text, "Captain's intent");
  }

  // mtime (ms) of a file, or null.
  mtime(file) {
    if (!file) return null;
    try { return fs.statSync(file).mtimeMs; } catch { return null; }
  }

  // Commits on the worker's branch beyond its base, plus whether the tree is
  // dirty and when the last commit landed. Read-only git queries in the task's
  // worktree. Returns null when the worktree is unavailable.
  async gitProgress(worktree) {
    if (!worktree || !fs.existsSync(worktree)) return null;
    const git = (...args) => this.runner('git', ['-C', worktree, ...args], { timeout: 10000 })
      .then((s) => s.trim());
    let base = null;
    try {
      base = await git('rev-parse', '--abbrev-ref', 'origin/HEAD');
    } catch {
      for (const cand of ['origin/main', 'origin/master']) {
        try { await git('rev-parse', '--verify', '--quiet', cand); base = cand; break; } catch { /* next */ }
      }
    }
    try {
      const commitsAhead = base ? Number(await git('rev-list', '--count', `${base}..HEAD`)) : null;
      const dirty = (await git('status', '--porcelain', '--untracked-files=normal')).length > 0;
      let lastCommitAt = null;
      if (commitsAhead) lastCommitAt = Number(await git('log', '-1', '--format=%ct')) * 1000;
      return { base, commitsAhead, dirty, lastCommitAt };
    } catch {
      return null;
    }
  }

  // The ONLY write path: append one note to Firstmate's inbox (body on stdin).
  async submitNote(body) {
    return this.runner(this.bin('fm-inbox.sh'), ['note', '-'], { input: body, env: this.env(), timeout: 15000 });
  }
}

function extractSection(markdown, heading) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => /^##\s+/.test(l) && l.replace(/^##\s+/, '').trim().toLowerCase() === heading.toLowerCase());
  if (start === -1) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) break;
    out.push(lines[i]);
  }
  const body = out.join('\n').trim();
  return body || null;
}

module.exports = { Firstmate, run, extractSection };
