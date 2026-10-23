// Sessioni Claude Code avviate da AiBro tramite Claude Agent SDK:
// chat bidirezionale e approvazioni dei tool gestite nella finestra.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { summarizeTool } = require('./hookServer');

let sdkPromise = null;
const sdk = () => (sdkPromise ||= import('@anthropic-ai/claude-agent-sdk'));

function findClaudeExecutable() {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'),
    ...(process.env.PATH || '').split(path.delimiter).map((d) => path.join(d, process.platform === 'win32' ? 'claude.exe' : 'claude')),
  ];
  return candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
}

// Coda asincrona usata come prompt in streaming per l'SDK.
class InputQueue {
  constructor() { this.items = []; this.waiters = []; this.closed = false; }
  push(item) {
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }
  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
    };
  }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

class AgentRunner {
  constructor(store) {
    this.store = store;
    this.running = new Map(); // id locale -> { query, input }
    this.seq = 0;
    this.claudePath = findClaudeExecutable();
  }

  async recentSessions(limit = 15) {
    const { listSessions } = await sdk();
    const list = await listSessions({ limit });
    return list.map((s) => ({
      sessionId: s.sessionId,
      title: s.customTitle || s.summary || s.firstPrompt || s.sessionId,
      cwd: s.cwd || null,
      lastModified: s.lastModified,
    }));
  }

  // Cronologia di una sessione esterna (letta dal transcript su disco).
  async history(sessionId, limit = 40) {
    const { getSessionMessages } = await sdk();
    const msgs = await getSessionMessages(sessionId);
    return msgs
      .filter((m) => m.type === 'user' || m.type === 'assistant')
      .map((m) => ({ role: m.type, text: textOf(m.message?.content) }))
      .filter((m) => m.text.trim())
      .slice(-limit);
  }

  addMessage(id, msg) {
    const s = this.store.sessions.get(id);
    if (!s) return;
    s.messages = s.messages || [];
    s.messages.push({ ...msg, at: Date.now() });
    if (msg.role === 'assistant' && msg.text) s.lastMessage = msg.text;
    this.store.upsertSession(id, {});
    this.store.emit('messages', id);
  }

  /**
   * Avvia una sessione. resumeId riprende una sessione esistente (anche aperta nel terminale:
   * la conversazione prosegue qui, il terminale non vedrà i nuovi messaggi).
   */
  async start({ cwd, prompt, resumeId = null, title = null, permissionMode = 'default' }) {
    if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      throw new Error(`Cartella non trovata: ${cwd || '(vuota)'}`);
    }
    // L'exe non include il binario di Claude Code dell'SDK (285 MB): usa quello installato.
    this.claudePath ||= findClaudeExecutable();
    if (!this.claudePath) throw new Error('Claude Code non trovato: installalo (claude.exe in ~/.local/bin o nel PATH).');
    const { query } = await sdk();
    const id = `app-${Date.now().toString(36)}-${++this.seq}`;
    const input = new InputQueue();
    this.store.upsertSession(id, {
      source: 'app',
      cwd,
      title: title || path.basename(cwd),
      status: 'running',
      activity: 'Avvio…',
      claudeSessionId: resumeId,
      permissionMode,
      messages: [],
    });

    if (resumeId) {
      try {
        const past = await this.history(resumeId, 20);
        this.store.sessions.get(id).messages.push(...past.map((m) => ({ ...m, past: true })));
      } catch { /* cronologia non disponibile */ }
    }

    const q = query({
      prompt: input,
      options: {
        cwd,
        resume: resumeId || undefined,
        permissionMode,
        settingSources: ['user', 'project', 'local'],
        env: { ...process.env, AIBRO_MANAGED: '1' },
        pathToClaudeCodeExecutable: this.claudePath,
        canUseTool: (toolName, toolInput, { signal, suggestions, decisionReason }) => new Promise((resolve) => {
          const approvalId = this.store.addApproval({
            sessionId: id,
            tool: toolName,
            input: toolInput,
            suggestions,
            reason: decisionReason,
            respond: (d) => resolve(d.behavior === 'allow'
              ? { behavior: 'allow', updatedInput: toolInput, updatedPermissions: d.updatedPermissions }
              : { behavior: 'deny', message: d.message || "L'utente ha rifiutato", interrupt: d.interrupt }),
          });
          signal.addEventListener('abort', () => this.store.dropApproval(approvalId));
        }),
      },
    });
    this.running.set(id, { query: q, input });
    this.send(id, prompt);
    this.consume(id, q).catch((e) => {
      this.addMessage(id, { role: 'error', text: String(e?.message || e) });
    }).finally(() => {
      this.running.delete(id);
      this.store.upsertSession(id, { status: 'ended', activity: null });
    });
    return id;
  }

  async consume(id, q) {
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') {
        this.store.upsertSession(id, { claudeSessionId: m.session_id, model: m.model, activity: 'Sta pensando…' });
      } else if (m.type === 'assistant' && !m.parent_tool_use_id) {
        for (const b of m.message?.content || []) {
          if (b.type === 'text' && b.text.trim()) this.addMessage(id, { role: 'assistant', text: b.text });
          if (b.type === 'tool_use') {
            const label = summarizeTool(b.name, b.input);
            this.addMessage(id, { role: 'tool', text: label });
            this.store.upsertSession(id, { activity: label });
          }
        }
      } else if (m.type === 'result') {
        const s = this.store.sessions.get(id);
        this.store.upsertSession(id, {
          status: 'idle',
          activity: null,
          costUsd: (s?.costUsd || 0) + (m.total_cost_usd || 0),
        });
        if (m.subtype !== 'success') this.addMessage(id, { role: 'error', text: `Turno terminato: ${m.subtype}` });
        this.store.emit('attention', { kind: 'done', sessionId: id, message: s?.lastMessage, ok: m.subtype === 'success' && !m.is_error });
      }
    }
  }

  send(id, text) {
    const r = this.running.get(id);
    if (!r || !text?.trim()) return false;
    this.addMessage(id, { role: 'user', text });
    this.store.upsertSession(id, { status: 'running', activity: 'Sta pensando…', lastPrompt: text });
    r.input.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' });
    return true;
  }

  async interrupt(id) {
    const r = this.running.get(id);
    if (r) await r.query.interrupt().catch(() => {});
  }

  close(id) {
    const r = this.running.get(id);
    if (r) { r.input.close(); r.query.close(); }
    this.store.removeSession(id);
  }

  closeAll() {
    for (const r of this.running.values()) { r.input.close(); try { r.query.close(); } catch { /* già chiusa */ } }
  }

  messages(id) {
    return this.store.sessions.get(id)?.messages || [];
  }
}

module.exports = { AgentRunner };
