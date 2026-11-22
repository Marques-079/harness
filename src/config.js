'use strict';
// Runtime configuration: env vars, overridable by CLI flags.
//   FM_HOME / --fm-home           Firstmate operational home (read-only).
//   HARNESS_QUEUE_PORT / --queue-port   question queue page (default 4710).
//   HARNESS_BOARD_PORT / --board-port   agent board page (default 4711).
//   HARNESS_HOST / --host          bind address (default 127.0.0.1).
//   HARNESS_CACHE_MS / --cache-ms  how long one Firstmate snapshot is reused (default 3000).

const os = require('node:os');
const path = require('node:path');

const DEFAULT_FM_HOME = path.join(os.homedir(), 'Documents', 'firstmate');

function parsePort(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`invalid ${name}: ${value}`);
  return n;
}

function loadConfig(argv = process.argv.slice(2), env = process.env) {
  const cfg = {
    fmHome: env.FM_HOME || DEFAULT_FM_HOME,
    queuePort: parsePort(env.HARNESS_QUEUE_PORT || 4710, 'queue port'),
    boardPort: parsePort(env.HARNESS_BOARD_PORT || 4711, 'board port'),
    host: env.HARNESS_HOST || '127.0.0.1',
    cacheMs: Number(env.HARNESS_CACHE_MS || 3000),
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=', 2);
    const val = () => (inline !== undefined ? inline : argv[++i]);
    switch (flag) {
      case '--fm-home': cfg.fmHome = val(); break;
      case '--queue-port': cfg.queuePort = parsePort(val(), 'queue port'); break;
      case '--board-port': cfg.boardPort = parsePort(val(), 'board port'); break;
      case '--host': cfg.host = val(); break;
      case '--cache-ms': cfg.cacheMs = Number(val()); break;
      case '-h': case '--help': cfg.help = true; break;
      default: throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  return cfg;
}

module.exports = { loadConfig, DEFAULT_FM_HOME };
