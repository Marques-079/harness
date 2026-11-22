'use strict';
// Two small HTTP servers over one shared Firstmate data source:
//   queue (default :4710)  GET /  GET /api/queue  POST /api/answer
//   board (default :4711)  GET /  GET /api/board
// Pages poll their JSON endpoint every few seconds.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Firstmate } = require('./fm');
const { buildQueue } = require('./queue');
const { buildBoard } = require('./board');
const { AnswerDesk } = require('./answers');
const { PrChecks } = require('./ci');

const PUBLIC = path.join(__dirname, '..', 'public');
const ASSETS = {
  '/assets/theme.css': ['theme.css', 'text/css; charset=utf-8'],
  '/assets/theme.js': ['theme.js', 'text/javascript; charset=utf-8'],
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

function createApp({ fmHome, cacheMs = 3000, runner, prChecks } = {}) {
  const ports = { queue: null, board: null }; // filled in by the caller once listening
  const fm = new Firstmate(fmHome, { cacheMs, runner });
  const desk = new AnswerDesk(fm);
  const checks = prChecks || new PrChecks();
  const currentQueue = async () => {
    const snap = await fm.snapshot();
    return { generated: snap.generated, items: buildQueue(snap, (f) => fm.mtime(f)) };
  };

  const queueHandler = async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (req.method === 'GET' && url.pathname === '/') return sendPage(res, 'queue.html');
      if (common(req, res, url, ports)) return undefined;
      if (req.method === 'GET' && url.pathname === '/api/queue') {
        const q = await currentQueue();
        return send(res, 200, { generated: q.generated, items: desk.annotate(q.items) });
      }
      if (req.method === 'POST' && url.pathname === '/api/answer') {
        if (!sameOriginJson(req)) return send(res, 403, { error: 'same-origin JSON only' });
        const body = await readJson(req);
        const q = await currentQueue();
        const rec = await desk.submit(q.items, body.id, body.text);
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
        return send(res, 200, await buildBoard(await fm.snapshot(), fm, checks));
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) { return fail(res, err); }
  };

  return {
    fm,
    desk,
    prChecks: checks,
    ports,
    queueServer: http.createServer(queueHandler),
    boardServer: http.createServer(boardHandler),
  };
}

module.exports = { createApp };
