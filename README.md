# harness

Local visualisation pages over [Firstmate](../firstmate)'s records. Firstmate
stays the centre: these pages only **read** its records, and the one action they
offer (answering a question) is handed back to Firstmate, never to a worker.

| Page | Default port | What it shows |
| --- | --- | --- |
| Question queue | `4710` | Everything waiting on the captain, pooled, newest first, with an answer box |
| Agent board | `4711` | Every live worker: objective, inferred stage, last activity, PR link and live CI status; plus queued and recently landed tasks |

Both pages share one look: a light/dark design system in
`public/theme.css` (styled after benchlm.ai's palette, type and spacing, using
the freely licensed Geist fonts from Google Fonts). Every colour is a CSS
variable, and dark mode is a second set of values for those same variables. By
default the pages follow the OS `prefers-color-scheme`. The **Dark/Light**
button in the header overrides that, and the choice is saved per browser with
`localStorage`. The two pages run on different ports, which the browser treats
as different origins, so each page remembers its own choice.

## Running

Requires Node 20+ and no npm dependencies.

```sh
npm start                     # queue on :4710, board on :4711
FM_HOME=/path/to/firstmate npm start
node bin/harness.js --queue-port 5710 --board-port 5711 --fm-home /path/to/firstmate
npm test
```

| Setting | Env | Flag | Default |
| --- | --- | --- | --- |
| Firstmate home | `FM_HOME` | `--fm-home` | `~/Documents/firstmate` |
| Queue port | `HARNESS_QUEUE_PORT` | `--queue-port` | `4710` |
| Board port | `HARNESS_BOARD_PORT` | `--board-port` | `4711` |
| Bind address | `HARNESS_HOST` | `--host` | `127.0.0.1` |
| Snapshot reuse window (ms) | `HARNESS_CACHE_MS` | `--cache-ms` | `3000` |

Pages poll their JSON endpoint every 4 s. Flags override env.

## What each page reads

Both pages share one cached run of `$FM_HOME/bin/fm-fleet-snapshot.sh --json`
(schema `fm-fleet-snapshot.v1`), Firstmate's versioned machine contract, rather
than parsing raw state files.

**Question queue** (`GET /api/queue`)

- Backlog rows with `captain_actionable: true` (hold bucket `live`). The
  `hold_reason` is the question and options. Holds that are dated, aged, or blocked
  are left out, matching Firstmate's own Captain's Call.
- `tasks[].hints.open_decisions`: open worker `needs-decision` / `blocked`
  events. The snapshot computes this with `fm-classify-lib.sh`'s
  `status_open_decisions` fold, so the open/resolved logic is not re-implemented
  here. Age is the mtime of the task's status log.

**Answering** (`POST /api/answer`, same-origin JSON only). The server looks the
item up in the current queue, then pipes one line to
`$FM_HOME/bin/fm-inbox.sh note -`:

```
answer <task-id>: <captain's text>                # captain hold
answer <task-id> [key=<decision-key>]: <text>     # keyed worker decision
```

That appends one wake, and Firstmate routes the answer. The app never calls
`fm-send.sh` or `fm-captain-hold.sh` and never writes `state/` or `data/`. A
submitted item shows "Sent to Firstmate" until Firstmate resolves it and it
leaves the queue. The marker is kept in memory, so it resets if the app restarts.

**Agent board** (`GET /api/board`)

- Live workers: `tasks[]` from the snapshot, which includes `current_state` from
  `fm-crew-state.sh`, `pr` (`pr=` in meta, else the first `/pull/N` URL anywhere
  in the status log, told apart by `pr.source`), and the last status event.
- CI status (shipped PRs only): read-only
  `gh pr view <url> --json statusCheckRollup,mergeable,mergeStateStatus,state`,
  run in `src/ci.js`. Results (failures too) are cached per PR for 60 s, so the
  4 s poll never hammers GitHub. A stale result is served while gh refreshes in
  the background, and a first lookup waits at most 1.5 s, showing "Checking CI…"
  until gh answers. If gh is missing or fails, the card shows "CI status
  unavailable" and the stage stays at PR open. `gh` must be on `PATH` and logged in.
- Objective: the `## Captain's intent` section of `$FM_HOME/data/<id>/brief.md`.
- Commit progress: read-only `git rev-list` / `git status` in the worker's
  worktree against `origin/HEAD` (or `origin/main` / `origin/master`).
- Queued: backlog rows that are not Done and have no live worker, with any hold
  or blocker shown.
- Recently landed: the 10 newest Done backlog rows.

### Stage inference

Workers do not report a stage yet, so `src/stage.js` infers one. All of the
rules are in that file, including how gh's PR JSON maps to a stage
(`classifyPr`), so it can be swapped out when workers report stages
explicitly. The first matching rule wins:

| Stage | Rule |
| --- | --- |
| Landed | backlog row is Done (scouts: Report ready), or the shipped PR is merged on GitHub |
| Received | backlog row is queued, or no live worker |
| Report ready | scout whose `report.md` exists |
| CI passing | shipped PR is open, every check succeeded (skipped/neutral count as passing), and it is mergeable with no conflicts |
| PR open | ship with a **shipped** PR: `pr=` in meta, or a `done: … PR <url>` event. The card shows the sub-status: CI running (amber), CI failing: `<check>` (red), Merge conflicts (red), or CI status unavailable |
| Reviewing | `fm-crew-state.sh` reads from source `run-step` (the validation pipeline owns the branch) |
| Executing | commits beyond base, or uncommitted edits in the worktree |
| Planning | worker live, nothing committed yet |

A PR URL that only appears in a `working:` note, such as a task that rebases an
existing PR, or that only appears in a backlog row's links, is still shown as
the card's pull request. It does not advance the stage, so such a task goes
through Planning → Executing → (Reviewing) → PR open like any other ship.

Ship pipeline: Received → Planning → Executing → Reviewing → PR open → CI passing → Landed.
Scout pipeline: Received → Planning → Executing → Report ready.

## Layout

```
bin/harness.js   entry point (two servers)
src/config.js    env/CLI config
src/fm.js        Firstmate data source (read-only + the fm-inbox write)
src/stage.js     stage inference (the only place stage rules live)
src/ci.js        cached, async read-only `gh pr view` lookups for live PR checks
src/queue.js     question-queue model and answer formatting
src/answers.js   answer submission + "sent to Firstmate" tracking
src/board.js     agent-board model
src/server.js    HTTP routes
public/          the two pages + shared theme.css / theme.js
test/            node:test suites on a synthetic FM_HOME (no live data)
```

## Limits (base version)

- Main home only: secondmate homes' decisions and children aren't pooled yet.
- Remote workers show no commit progress, because their worktree is on another host.
