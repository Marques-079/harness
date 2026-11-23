'use strict';
// Two small HTTP servers over one shared Firstmate data source:
//   queue (default :4710)  GET /  GET /api/queue  POST /api/answer
//   board (default :4711)  GET /  GET /api/board
// Pages poll their JSON endpoint every few seconds. Both endpoints serve the
// last good payload from one shared Refresher, kept warm in the background.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Firstmate } = require('./fm');
const { buildQueue } = require('./queue');
const { buildBoard } = require('./board');
const { AnswerDesk } = require('./answers');
const { PrChecks } = require('./ci');
const { Refresher } = require('./refresher');

const PUBLIC = path.join(__dirname, '..', 'public');
const ASSETS = {
  '/assets/theme.css': ['theme.css', 'text/css; charset=utf-8'],
  '/assets/theme.js': ['theme.js', 'text/javascript; charset=utf-8'],
  '/assets/live.js': ['live.js', 'text/javascript; charset=utf-8'],
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(data);
}

function sendPage(res, file, type = 'text/html; charset=utf-8') {
  if (file === null) { res.writeHead(204); res.end(); return; }
  fs.readFile(path.join(PUBLIC, file), (err, buf) => {
    if (err) return send(res, 500, { error: 'page missing' });
    send(res, 200, buf, type);
  });
}

// Shared routes on both servers: theme assets, favicon, cross-page links.
function common(req, res, url, ports) {
  if (req.method !== 'GET') return false;
  const asset = ASSETS[url.pathname];
  if (asset) { sendPage(res, asset[0], asset[1]); return true; }
  if (url.pathname === '/favicon.ico') { sendPage(res, null); return true; }
  if (url.pathname === '/api/links') {
    const host = new URL(`http://${req.headers.host || 'localhost'}`).hostname;
    const link = (p) => (p ? `http://${host.includes(':') ? `[${host}]` : host}:${p}/` : null);
    send(res, 200, { queue: link(ports.queue), board: link(ports.board) });
    return true;
  }
  return false;
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch {
        reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// Only same-origin JSON posts may submit answers (blocks cross-site form posts).
function sameOriginJson(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return false;
  const origin = req.headers.origin;
  return !origin || origin === `http://${req.headers.host}`;
}

function fail(res, err) {
  send(res, err.status || 502, { error: err.message || String(err) });
}

// refreshMs: how often the background refresher recomputes the fleet snapshot
// and both payloads (only once start() is called; bin/harness.js does).
function createApp({ fmHome, refreshMs = 5000, runner, prChecks } = {}) {
  const ports = { queue: null, board: null }; // filled in by the caller once listening
  const fm = new Firstmate(fmHome, { runner });
  const desk = new AnswerDesk(fm);
  const checks = prChecks || new PrChecks();
  // One run = one snapshot plus everything derived from it (per-task git reads,
  // PR check lookups), so requests never pay for any of it.
  const refresher = new Refresher(async () => {
    const snap = await fm.snapshot();
    const items = buildQueue(snap, (f) => fm.mtime(f));
    const board = await buildBoard(snap, fm, checks);
    return { queue: { generated: snap.generated, items }, board };
  }, { intervalMs: refreshMs });
  const current = async () => {
    const { value, meta } = await refresher.get();
    return { ...value, meta };
  };

  const queueHandler = async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (req.method === 'GET' && url.pathname === '/') return sendPage(res, 'queue.html');
      if (common(req, res, url, ports)) return undefined;
      if (req.method === 'GET' && url.pathname === '/api/queue') {
        const { queue: q, meta } = await current();
        return send(res, 200, { generated: q.generated, items: desk.annotate(q.items), fresh: meta });
      }
      if (req.method === 'POST' && url.pathname === '/api/answer') {
        if (!sameOriginJson(req)) return send(res, 403, { error: 'same-origin JSON only' });
        const body = await readJson(req);
        const { queue: q } = await current();
        const rec = await desk.submit(q.items, body.id, body.text);
        refresher.refresh(); // pick up Firstmate's reaction sooner
        return send(res, 200, { ok: true, sent: rec });
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) { return fail(res, err); }
  };

  const boardHandler = async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (req.method === 'GET' && url.pathname === '/') return sendPage(res, 'board.html');
      if (common(req, res, url, ports)) return undefined;
      if (req.method === 'GET' && url.pathname === '/api/board') {
        const { board, meta } = await current();
        return send(res, 200, { ...board, fresh: meta });
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) { return fail(res, err); }
  };

  return {
    fm,
    desk,
    prChecks: checks,
    refresher,
    ports,
    start() { refresher.start(); return this; },
    stop() { refresher.stop(); },
    queueServer: http.createServer(queueHandler),
    boardServer: http.createServer(boardHandler),
  };
}

module.exports = { createApp };
