'use strict';
// Answer submission. The captain's answer goes to Firstmate ONLY through
// `fm-inbox.sh note -` (via Firstmate#submitNote); Firstmate then routes it.
// Nothing here talks to a worker, calls fm-send / fm-captain-hold, or writes
// Firstmate state files.

const { formatAnswer } = require('./queue');

const MAX_ANSWER = 8000;

class AnswerDesk {
  constructor(fm) {
    this.fm = fm;
    this.sent = new Map(); // item id -> { text, at }
  }

  // Submit an answer for an item that is CURRENTLY in the queue. Looking the
  // item up server-side means a caller can only answer real open questions and
  // cannot choose the routing line's task id or key.
  async submit(items, itemId, rawText) {
    const text = typeof rawText === 'string' ? rawText.trim() : '';
    if (!text) throw httpError(400, 'answer is empty');
    if (text.length > MAX_ANSWER) throw httpError(400, `answer longer than ${MAX_ANSWER} characters`);
    const item = items.find((i) => i.id === itemId);
    if (!item) throw httpError(404, 'that question is no longer in the queue');
    await this.fm.submitNote(formatAnswer(item, text));
    const rec = { text, at: Date.now() };
    this.sent.set(item.id, rec);
    return rec;
  }

  // Attach "sent to Firstmate" markers; forget answers whose item has left the queue.
  annotate(items) {
    const live = new Set(items.map((i) => i.id));
    for (const id of this.sent.keys()) if (!live.has(id)) this.sent.delete(id);
    return items.map((i) => ({ ...i, sent: this.sent.get(i.id) || null }));
  }
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

module.exports = { AnswerDesk, MAX_ANSWER };
