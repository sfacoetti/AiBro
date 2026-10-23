// Installa/rimuove gli hook di AiBro in ~/.claude/settings.json senza toccare il resto.
const fs = require('fs');
const { CLAUDE_SETTINGS, HOOK_SOURCE, HOOK_SCRIPT, ensureDataDir, readJson, writeJson } = require('./paths');

const MARKER = 'aibro-hook.js';
// Evento -> timeout in secondi. PermissionRequest resta in attesa della decisione dell'utente.
const EVENTS = {
  SessionStart: 10,
  SessionEnd: 10,
  UserPromptSubmit: 10,
  PreToolUse: 10,
  Stop: 10,
  Notification: 10,
  PermissionRequest: 600,
};

function hookCommand() {
  return `node "${HOOK_SCRIPT.replace(/\\/g, '/')}"`;
}

function isOurs(group) {
  return (group.hooks || []).some((h) => typeof h.command === 'string' && h.command.includes(MARKER));
}

function status() {
  const settings = readJson(CLAUDE_SETTINGS, {});
  const hooks = settings.hooks || {};
  const installed = Object.keys(EVENTS).filter((ev) => (hooks[ev] || []).some(isOurs));
  return { installed: installed.length === Object.keys(EVENTS).length, partial: installed.length > 0, events: installed };
}

function backup() {
  if (fs.existsSync(CLAUDE_SETTINGS)) {
    fs.copyFileSync(CLAUDE_SETTINGS, `${CLAUDE_SETTINGS}.aibro-backup`);
  }
}

// Copia lo script dell'hook nella cartella dati (sempre aggiornato alla versione dell'app).
function syncScript() {
  ensureDataDir();
  fs.writeFileSync(HOOK_SCRIPT, fs.readFileSync(HOOK_SOURCE));
}

// All'avvio: aggiorna la copia dello script e riporta sul percorso attuale gli hook installati altrove
// (es. dalla cartella del progetto prima di usare l'exe).
function refresh() {
  syncScript();
  const hooks = readJson(CLAUDE_SETTINGS, {}).hooks || {};
  const stale = Object.values(hooks).flat().filter(isOurs).some((g) => g.hooks.some((h) => h.command?.includes(MARKER) && h.command !== hookCommand()));
  return stale ? install() : status();
}

function install() {
  syncScript();
  backup();
  const settings = readJson(CLAUDE_SETTINGS, {});
  settings.hooks = settings.hooks || {};
  for (const [ev, timeout] of Object.entries(EVENTS)) {
    const groups = (settings.hooks[ev] || []).filter((g) => !isOurs(g));
    groups.push({ hooks: [{ type: 'command', command: hookCommand(), timeout }] });
    settings.hooks[ev] = groups;
  }
  writeJson(CLAUDE_SETTINGS, settings);
  return status();
}

function uninstall() {
  backup();
  const settings = readJson(CLAUDE_SETTINGS, {});
  if (!settings.hooks) return status();
  for (const ev of Object.keys(settings.hooks)) {
    const groups = settings.hooks[ev].filter((g) => !isOurs(g));
    if (groups.length) settings.hooks[ev] = groups;
    else delete settings.hooks[ev];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  writeJson(CLAUDE_SETTINGS, settings);
  return status();
}

module.exports = { status, install, uninstall, refresh };
