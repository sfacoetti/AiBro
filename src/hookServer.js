// Server HTTP locale che riceve gli eventi dagli hook di Claude Code.
const http = require('http');
const { DEFAULT_PORT, writeRuntime, clearRuntime } = require('./paths');

// Hook di approvazione: oltre questo tempo si lascia decidere al terminale.
const APPROVAL_TIMEOUT_MS = 580 * 1000;

function summarizeTool(tool, input) {
  if (!input || typeof input !== 'object') return tool;
  const v = input.command || input.file_path || input.path || input.pattern || input.url || input.query || input.description;
  return v ? `${tool}: ${String(v).split('\n')[0].slice(0, 120)}` : tool;
}

function permissionOutput(decision) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
}

function handleEvent(store, event, p, req, res) {
  const id = p.session_id;
  if (!id) return res.end('');
  const base = { cwd: p.cwd, source: 'claude-code' };
  if (p.session_title) base.title = p.session_title;

  switch (event) {
    case 'SessionStart':
      store.upsertSession(id, { ...base, status: 'idle', model: p.model || null, activity: null });
      break;
    case 'UserPromptSubmit':
      store.upsertSession(id, { ...base, status: 'running', lastPrompt: p.prompt, activity: 'Sta pensando…' });
      break;
    case 'PreToolUse':
      store.upsertSession(id, { ...base, status: store.sessions.get(id)?.status === 'waiting' ? 'waiting' : 'running', activity: summarizeTool(p.tool_name, p.tool_input) });
      break;
    case 'Notification': {
      const s = store.upsertSession(id, base);
      if (/idle|input/i.test(p.notification_type || '')) {
        s.status = 'waiting-input';
        s.inputKind = p.notification_type;
        store.emit('attention', { kind: 'input', sessionId: id, message: p.message });
      }
      break;
    }
    case 'Stop':
      store.upsertSession(id, { ...base, status: 'idle', activity: null, lastMessage: p.last_assistant_message || null });
      store.emit('attention', { kind: 'done', sessionId: id, message: p.last_assistant_message, ok: true });
      break;
    case 'SessionEnd':
      store.upsertSession(id, { status: 'ended', activity: null });
      for (const a of store.approvals.values()) if (a.sessionId === id) store.dropApproval(a.id);
      break;
    case 'PermissionRequest': {
      store.upsertSession(id, base);
      let done = false;
      const finish = (body) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        res.end(body);
      };
      const approvalId = store.addApproval({
        sessionId: id,
        tool: p.tool_name,
        input: p.tool_input,
        suggestions: p.permission_suggestions,
        respond: (decision) => finish(permissionOutput(decision)),
      });
      const timer = setTimeout(() => { store.dropApproval(approvalId); finish(''); }, APPROVAL_TIMEOUT_MS);
      // Se il processo hook muore (l'utente ha risposto nel terminale) la richiesta sparisce.
      res.on('close', () => { if (!done) { done = true; clearTimeout(timer); store.dropApproval(approvalId); } });
      return;
    }
    default:
      break;
  }
  res.end('');
}

function startHookServer(store) {
  return new Promise((resolve, reject) => {
    let token = null;
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/hook' || req.headers['x-aibro-token'] !== token) {
        res.statusCode = 403;
        return res.end();
      }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => { body += c; if (body.length > 5e6) req.destroy(); });
      req.on('end', () => {
        let msg;
        try { msg = JSON.parse(body); } catch { res.statusCode = 400; return res.end(); }
        res.setHeader('content-type', 'application/json');
        try { handleEvent(store, msg.event, msg.payload || {}, req, res); } catch (e) { console.error('hook error', e); res.end(''); }
      });
    });
    server.requestTimeout = 0;
    server.headersTimeout = 10000;

    const tryListen = (port, attempts) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempts > 0) tryListen(port + 1, attempts - 1);
        else reject(err);
      });
      server.listen(port, '127.0.0.1', () => {
        token = writeRuntime(server.address().port);
        resolve({ server, port: server.address().port, close: () => { clearRuntime(); server.close(); } });
      });
    };
    tryListen(DEFAULT_PORT, 10);
  });
}

module.exports = { startHookServer, summarizeTool };
