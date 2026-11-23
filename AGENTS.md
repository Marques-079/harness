# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Zero-dependency Node app; run `npm start`, test `npm test` (node:test). Layout and data sources: see README.md.
- Read-only against `$FM_HOME`. The only write path is `fm-inbox.sh note -` in `src/fm.js` (`submitNote`); never add fm-send / fm-captain-hold / state-file writes.
- Requests never compute data: both endpoints serve the last good payload from `src/refresher.js` (see README "Freshness"). Tests that change the synthetic snapshot must `await app.refresher.refresh()` before asserting.
- Stage rules live only in `src/stage.js` (incl. `classifyPr` for gh PR JSON); `src/ci.js` only fetches/caches read-only `gh pr view`. Replace stage.js when workers report stages explicitly.
- This repo is PUBLIC: tests use synthetic homes and the fake `gh` (`fakeGh`) from `test/helpers.js`; never call real gh in tests or commit live Firstmate data, task names, or real repo/PR URLs.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
