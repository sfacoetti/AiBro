// Rileva le app AI aperte sul desktop (ChatGPT, Claude, Copilot, ...) dalle finestre attive.
// Queste app non espongono API: si può solo sapere che sono aperte e portarle in primo piano.
const { execFile } = require('child_process');

const KNOWN = [
  { match: (p) => /^chatgpt$/i.test(p.name), label: 'ChatGPT', kind: 'chatgpt' },
  { match: (p) => /^claude$/i.test(p.name), label: 'Claude', kind: 'claude' },
  { match: (p) => /^(m365)?copilot$/i.test(p.name), label: 'Copilot', kind: 'copilot' },
  { match: (p) => /^code$/i.test(p.name), label: 'VS Code', kind: 'vscode' },
  { match: (p) => /^cursor$/i.test(p.name), label: 'Cursor', kind: 'cursor' },
  { match: (p) => /^windsurf$/i.test(p.name), label: 'Windsurf', kind: 'windsurf' },
];

// Schede del browser: Windows espone solo il titolo della scheda attiva di ogni finestra.
const BROWSERS = /^(chrome|msedge|firefox|brave|opera|vivaldi|arc)$/i;
const WEB = [
  { re: /chatgpt/i, label: 'ChatGPT (web)', kind: 'chatgpt' },
  { re: /\bclaude\b/i, label: 'Claude (web)', kind: 'claude' },
  { re: /copilot/i, label: 'Copilot (web)', kind: 'copilot' },
  { re: /gemini/i, label: 'Gemini (web)', kind: 'gemini' },
];

// Output in UTF-8: con la code page della console i titoli con caratteri non rappresentabili rompono il JSON.
const PS_LIST = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object Id,ProcessName,MainWindowTitle | ConvertTo-Json -Compress";

function powershell(script) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}

async function scanApps() {
  if (process.platform !== 'win32') return [];
  const out = await powershell(PS_LIST);
  let rows = JSON.parse(out || '[]');
  if (!Array.isArray(rows)) rows = [rows];
  const apps = [];
  for (const r of rows) {
    const p = { pid: r.Id, name: r.ProcessName, title: r.MainWindowTitle };
    const k = KNOWN.find((x) => x.match(p));
    if (k) { apps.push({ ...p, label: k.label, kind: k.kind }); continue; }
    if (BROWSERS.test(p.name)) {
      const w = WEB.find((x) => x.re.test(p.title));
      if (w) apps.push({ ...p, label: w.label, kind: w.kind });
    }
  }
  return apps;
}

function focusApp(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n)) return Promise.resolve();
  return powershell(`(New-Object -ComObject WScript.Shell).AppActivate(${n}) | Out-Null`).catch(() => {});
}

module.exports = { scanApps, focusApp };
