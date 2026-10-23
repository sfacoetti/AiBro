// Percorsi e configurazione condivisi tra app e script di hook.
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = path.join(os.homedir(), '.aibro');
const RUNTIME_FILE = path.join(DATA_DIR, 'runtime.json'); // porta + token del server hook
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
// Gli hook eseguono una copia in ~/.aibro: il percorso resta valido anche se l'app viene spostata o aggiornata.
const HOOK_SOURCE = path.join(__dirname, '..', 'hooks', 'aibro-hook.js');
const HOOK_SCRIPT = path.join(DATA_DIR, 'aibro-hook.js');
const DEFAULT_PORT = 47821;
const APP_ICON = path.join(__dirname, '..', 'aibro_orange.ico'); // copia arancione di aibro.ico (npm run icon)

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function writeRuntime(port) {
  ensureDataDir();
  const token = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(RUNTIME_FILE, JSON.stringify({ port, token, pid: process.pid }), { mode: 0o600 });
  return token;
}

function clearRuntime() {
  try { fs.unlinkSync(RUNTIME_FILE); } catch { /* già rimosso */ }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

module.exports = {
  DATA_DIR, RUNTIME_FILE, CONFIG_FILE, CLAUDE_SETTINGS, HOOK_SOURCE, HOOK_SCRIPT, DEFAULT_PORT, APP_ICON,
  ensureDataDir, writeRuntime, clearRuntime, readJson, writeJson,
};
