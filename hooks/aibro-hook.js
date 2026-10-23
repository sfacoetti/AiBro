#!/usr/bin/env node
// Hook di Claude Code: inoltra l'evento a AiBro e, per PermissionRequest,
// attende la decisione dell'utente. Se AiBro non è in esecuzione esce senza
// output, così Claude Code prosegue con il comportamento normale (prompt nel terminale).
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

// Le sessioni avviate da AiBro stesso gestiscono i permessi via SDK.
if (process.env.AIBRO_MANAGED === '1') process.exit(0);

const RUNTIME_FILE = path.join(os.homedir(), '.aibro', 'runtime.json');
const BLOCKING_EVENTS = new Set(['PermissionRequest']);

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
  });
}

async function main() {
  let runtime;
  try { runtime = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8')); } catch { return; }

  const raw = await readStdin();
  let payload;
  try { payload = JSON.parse(raw); } catch { return; }

  const event = payload.hook_event_name;
  const blocking = BLOCKING_EVENTS.has(event);
  const body = JSON.stringify({ event, payload, hookPid: process.pid });

  const response = await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port: runtime.port,
      path: '/hook',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-aibro-token': runtime.token,
      },
      // Gli eventi informativi non devono rallentare Claude Code.
      timeout: blocking ? 0 : 1500,
    }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve(res.statusCode === 200 ? out : ''));
    });
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.on('error', () => resolve(''));
    req.end(body);
  });

  if (blocking && response.trim()) process.stdout.write(response);
}

main().catch(() => {}).finally(() => process.exit(0));
