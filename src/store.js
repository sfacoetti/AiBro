// Stato centrale: sessioni, richieste di approvazione, app desktop e GitHub.
// Emette 'change' a ogni modifica e 'attention' quando serve l'intervento dell'utente.
const { EventEmitter } = require('events');
const path = require('path');

const ENDED_TTL_MS = 30 * 60 * 1000;
const STALE_TTL_MS = 12 * 60 * 60 * 1000;

class Store extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.approvals = new Map();
    this.apps = [];
    this.github = { configured: false, notifications: [], reviews: [], actions: [], error: null, updatedAt: null };
    this.hooks = { installed: false, partial: false, events: [] };
    this.usage = null;
    this.seq = 0;
    this.changeTimer = null;
  }

  changed() {
    // Raggruppa gli aggiornamenti ravvicinati (es. raffiche di PreToolUse).
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      this.emit('change');
    }, 50);
  }

  upsertSession(id, patch) {
    const prev = this.sessions.get(id);
    const s = prev || {
      id,
      source: 'claude-code',
      title: null,
      cwd: null,
      status: 'idle',
      activity: null,
      lastPrompt: null,
      lastMessage: null,
      startedAt: Date.now(),
      messages: null,
    };
    Object.assign(s, patch, { updatedAt: Date.now() });
    if (!s.title && s.cwd) s.title = path.basename(s.cwd);
    this.sessions.set(id, s);
    this.changed();
    return s;
  }

  removeSession(id) {
    this.sessions.delete(id);
    for (const a of this.approvals.values()) if (a.sessionId === id) this.dropApproval(a.id, 'Sessione chiusa');
    this.changed();
  }

  pruneEnded() {
    const now = Date.now();
    const waiting = new Set([...this.approvals.values()].map((a) => a.sessionId));
    for (const s of this.sessions.values()) {
      if (s.status === 'ended' && now - s.updatedAt > ENDED_TTL_MS) this.sessions.delete(s.id);
      // Un terminale chiuso di colpo non invia SessionEnd: dopo molte ore senza eventi la sessione sparisce.
      else if (s.source === 'claude-code' && !waiting.has(s.id) && now - s.updatedAt > STALE_TTL_MS) this.sessions.delete(s.id);
    }
    this.changed();
  }

  // respond(decision) viene chiamata una sola volta con {behavior:'allow'|'deny', ...}.
  addApproval({ sessionId, tool, input, suggestions, reason, respond }) {
    const id = `ap-${++this.seq}`;
    this.approvals.set(id, { id, sessionId, tool, input, suggestions: suggestions || [], reason, createdAt: Date.now(), respond });
    const s = this.sessions.get(sessionId);
    if (s) s.status = 'waiting';
    this.changed();
    this.emit('attention', { kind: 'approval', approvalId: id, sessionId, tool });
    return id;
  }

  resolveApproval(id, decision) {
    const a = this.approvals.get(id);
    if (!a) return false;
    this.approvals.delete(id);
    this.restoreStatus(a.sessionId);
    try { a.respond(decision); } catch { /* il richiedente non c'è più */ }
    this.changed();
    return true;
  }

  // Rimuove senza rispondere (es. l'utente ha risposto nel terminale).
  dropApproval(id) {
    const a = this.approvals.get(id);
    if (!a) return;
    this.approvals.delete(id);
    this.restoreStatus(a.sessionId);
    this.changed();
  }

  restoreStatus(sessionId) {
    const s = this.sessions.get(sessionId);
    const stillPending = [...this.approvals.values()].some((x) => x.sessionId === sessionId);
    if (s && s.status === 'waiting' && !stillPending) s.status = 'running';
  }

  snapshot() {
    const sessions = [...this.sessions.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ messages, ...rest }) => ({ ...rest, hasChat: rest.source === 'app' }));
    const approvals = [...this.approvals.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(({ respond, ...rest }) => ({ ...rest, sessionTitle: this.sessions.get(rest.sessionId)?.title || null }));
    return { sessions, approvals, apps: this.apps, github: this.github, hooks: this.hooks, usage: this.usage };
  }
}

module.exports = { Store };
