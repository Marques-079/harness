#!/usr/bin/env node
'use strict';
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/server');

const HELP = `harness - local visualisation pages over Firstmate's records

Usage: node bin/harness.js [--fm-home DIR] [--queue-port N] [--board-port N] [--host ADDR] [--refresh-ms N]

Env: FM_HOME, HARNESS_QUEUE_PORT (4710), HARNESS_BOARD_PORT (4711),
     HARNESS_HOST (127.0.0.1), HARNESS_REFRESH_MS (5000). Flags win over env.`;

let cfg;
try {
  cfg = loadConfig();
} catch (err) {
  console.error(`${err.message}\n\n${HELP}`);
  process.exit(2);
}
if (cfg.help) { console.log(HELP); process.exit(0); }

const app = createApp({ fmHome: cfg.fmHome, refreshMs: cfg.refreshMs }).start();
app.queueServer.listen(cfg.queuePort, cfg.host, () => {
  app.ports.queue = app.queueServer.address().port;
  console.log(`question queue  http://${cfg.host}:${app.ports.queue}/`);
});
app.boardServer.listen(cfg.boardPort, cfg.host, () => {
  app.ports.board = app.boardServer.address().port;
  console.log(`agent board     http://${cfg.host}:${app.ports.board}/`);
});
console.log(`FM_HOME=${cfg.fmHome}`);
