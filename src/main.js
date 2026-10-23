const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, Notification, screen, shell, dialog, safeStorage } = require('electron');
const path = require('path');
const { Store } = require('./store');
const { startHookServer } = require('./hookServer');
const { AgentRunner } = require('./agentRunner');
const hooksInstaller = require('./hooksInstaller');
const { scanApps, focusApp } = require('./desktopApps');
const { fetchGithub, markRead, rerunFailed } = require('./github');
const { overlayBadge } = require('./icons');
const { UsageTracker } = require('./usage');
const { CONFIG_FILE, APP_ICON, readJson, writeJson } = require('./paths');

const WIN_W = 380;
const WIN_H = 600;
const MIN_W = 320;
const MIN_H = 360;
const STRIP = 32; // spessore della finestra contratta (Windows non scende sotto ~30px)
const EDGES = ['right', 'left', 'top', 'bottom'];
const COLLAPSE_POLL_MS = 250;
const COLLAPSE_ANIM_MS = 180;
const BLUR_COLLAPSE_MS = 400;
const KEEP_ON_TOP_MS = 1000;
const APPS_INTERVAL_MS = 10 * 1000;
const GITHUB_INTERVAL_MS = 60 * 1000;
const GITHUB_BUSY_INTERVAL_MS = 20 * 1000; // con Actions in corso
const USAGE_INTERVAL_MS = 30 * 1000;
const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

// Modalità riga di comando: npm run hooks:install / hooks:uninstall
if (process.argv.includes('--install-hooks') || process.argv.includes('--uninstall-hooks')) {
  const st = process.argv.includes('--install-hooks') ? hooksInstaller.install() : hooksInstaller.uninstall();
  console.log('Hook AiBro:', st.installed ? 'installati' : 'rimossi', st.events.join(', '));
  process.exit(0);
}

if (!app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId('it.in4tek.aibro');

const store = new Store();
const runner = new AgentRunner(store);
const usage = new UsageTracker();
let config = { collapseAfterSec: 10, collapseEdge: 'right', ...readJson(CONFIG_FILE, { alwaysOnTop: true, notifyDone: true }) };
const clampOpacity = (v) => Math.min(1, Math.max(0.3, Number(v) || 1));
const clampDelay = (v) => Math.min(3600, Math.max(0, Math.round(Number(v) || 0)));
let win = null;
let tray = null;
let hookServer = null;
let quitting = false;
const seenGithub = new Set();
const runStates = new Map(); // id run -> status visto all'ultimo polling
let githubTimer = null;

const saveConfig = () => writeJson(CONFIG_FILE, config);

function githubToken() {
  if (config.githubToken && safeStorage.isEncryptionAvailable()) {
    try { return safeStorage.decryptString(Buffer.from(config.githubToken, 'base64')); } catch { /* token non leggibile */ }
  }
  return process.env.GITHUB_TOKEN || null;
}

// ---------- Finestra ----------

function defaultBounds() {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - WIN_W - 12, y: wa.y + wa.height - WIN_H - 12, width: WIN_W, height: WIN_H };
}

function boundsOnScreen(b) {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x >= a.x - 50 && b.y >= a.y - 10 && b.x + 100 <= a.x + a.width && b.y + 60 <= a.y + a.height;
  });
}

function createWindow() {
  const b = config.bounds && boundsOnScreen(config.bounds) ? config.bounds : defaultBounds();
  win = new BrowserWindow({
    ...b,
    useContentSize: true, // le dimensioni salvate sono quelle del contenuto: evitano la deriva di getBounds/setBounds con DPI ≠ 100%
    minWidth: MIN_W,
    minHeight: MIN_H,
    frame: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: config.alwaysOnTop,
    opacity: clampOpacity(config.opacity),
    backgroundColor: '#16161a',
    title: 'AiBro',
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.setContentBounds(b); // il costruttore arrotonda le dimensioni con DPI ≠ 100%
  win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  const remember = () => { if (dock.collapsed || dock.anim) return; config.bounds = win.getContentBounds(); saveConfig(); };
  win.on('moved', remember);
  win.on('resized', remember);
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
  // Finita in secondo piano (clic su un'altra finestra): si contrae subito. La breve attesa ignora i passaggi
  // di focus momentanei, ad esempio verso una notifica.
  win.on('blur', () => setTimeout(() => { if (!win.isFocused() && canCollapse()) collapseWindow(); }, BLUR_COLLAPSE_MS));
}

function showWindow(focus = true) {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  if (dock.collapsed) expandWindow();
  dock.idleSince = Date.now();
  if (focus) { win.show(); win.focus(); } else win.showInactive();
}

// ---------- Contrazione sul bordo ----------
// Dopo collapseAfterSec senza mouse sopra né focus la finestra si contrae sul posto verso il lato scelto,
// lasciando una striscia su quel lato; cliccandola torna esattamente dov'era.
// Restando sul proprio monitor non attraversa schermi con DPI diversi.

const dock = { collapsed: false, anim: null, full: null, edge: 'right', idleSince: Date.now() };

function animateBounds(to, done) {
  clearInterval(dock.anim);
  const from = win.getContentBounds();
  const start = Date.now();
  dock.anim = setInterval(() => {
    const k = Math.min(1, (Date.now() - start) / COLLAPSE_ANIM_MS);
    const e = 1 - (1 - k) ** 3;
    const lerp = (a, b) => Math.round(a + (b - a) * e);
    win.setContentBounds({ x: lerp(from.x, to.x), y: lerp(from.y, to.y), width: lerp(from.width, to.width), height: lerp(from.height, to.height) });
    if (k === 1) { clearInterval(dock.anim); dock.anim = null; done?.(); }
  }, 15);
}

function stripBounds(b, edge) {
  if (edge === 'left') return { x: b.x, y: b.y, width: STRIP, height: b.height };
  if (edge === 'top') return { x: b.x, y: b.y, width: b.width, height: STRIP };
  if (edge === 'bottom') return { x: b.x, y: b.y + b.height - STRIP, width: b.width, height: STRIP };
  return { x: b.x + b.width - STRIP, y: b.y, width: STRIP, height: b.height };
}

function collapseWindow() {
  const edge = EDGES.includes(config.collapseEdge) ? config.collapseEdge : 'right';
  dock.full = win.getContentBounds();
  dock.collapsed = true;
  dock.edge = edge;
  win.setMinimumSize(1, 1);
  win.setResizable(false);
  win.setAlwaysOnTop(true, 'screen-saver'); // la striscia resta sopra a tutto, anche ad altre finestre in primo piano
  win.webContents.send('collapsed', { collapsed: true, edge });
  animateBounds(stripBounds(dock.full, edge));
}

function expandWindow() {
  const target = dock.full;
  dock.collapsed = false;
  dock.idleSince = Date.now();
  win.webContents.send('collapsed', { collapsed: false, edge: dock.edge });
  animateBounds(target, () => {
    win.setResizable(true);
    win.setMinimumSize(MIN_W, MIN_H);
    win.setAlwaysOnTop(config.alwaysOnTop);
    config.bounds = target;
    saveConfig();
  });
}

// Resta aperta finché ci sono approvazioni in attesa o una finestra di dialogo di AiBro aperta.
function canCollapse() {
  return win.isVisible() && !dock.collapsed && !dock.anim && !dock.dialog && config.collapseAfterSec > 0 && !store.approvals.size;
}

function tickDock() {
  if (!win || !win.isVisible() || dock.anim) return;
  if (dock.collapsed) {
    // Un'altra finestra "sempre in primo piano" attivata dopo può coprirla: la riporta sopra.
    if (Date.now() - (dock.raisedAt || 0) >= KEEP_ON_TOP_MS) { dock.raisedAt = Date.now(); win.moveTop(); }
    return;
  }
  const p = screen.getCursorScreenPoint();
  const b = win.getContentBounds();
  const over = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
  if (!canCollapse() || over || win.isFocused()) { dock.idleSince = Date.now(); return; }
  if (Date.now() - dock.idleSince >= config.collapseAfterSec * 1000) collapseWindow();
}

function toggleWindow() {
  if (win.isVisible() && win.isFocused()) win.hide();
  else showWindow();
}

// ---------- Tray ----------

// Icona dell'app (aibro.ico) con il badge di stato, per ogni scala DPI comune.
const ICONS = {};
function icon(kind) {
  if (!ICONS[kind]) {
    const badge = { approval: [245, 158, 11], input: [59, 130, 246], failure: [239, 68, 68], github: [148, 163, 184] }[kind] || null;
    const base = nativeImage.createFromPath(APP_ICON);
    const img = nativeImage.createEmpty();
    for (const scale of [1, 1.25, 1.5, 2]) {
      const size = Math.round(16 * scale);
      let frame = base.resize({ width: size, height: size, quality: 'best' });
      if (badge) frame = nativeImage.createFromBitmap(overlayBadge(frame.toBitmap(), size, badge), { width: size, height: size });
      img.addRepresentation({ scaleFactor: scale, buffer: frame.toPNG() });
    }
    ICONS[kind] = img;
  }
  return ICONS[kind];
}

function updateTray() {
  if (!tray) return;
  const approvals = store.approvals.size;
  const active = [...store.sessions.values()].filter((s) => s.status !== 'ended');
  const needInput = active.filter((s) => s.status === 'waiting-input').length;
  const gh = store.github.notifications.length + store.github.reviews.length;
  const failed = store.github.actions.filter((r) => FAILED.has(r.conclusion)).length;
  const runningRuns = store.github.actions.filter((r) => r.status !== 'completed').length;
  tray.setImage(icon(approvals ? 'approval' : needInput ? 'input' : failed ? 'failure' : gh ? 'github' : 'idle'));
  const lines = [`AiBro — ${active.length} sessioni attive`];
  if (approvals) lines.push(`${approvals} approvazioni in attesa`);
  if (needInput) lines.push(`${needInput} sessioni attendono input`);
  if (failed) lines.push(`Actions: ${failed} fallite`);
  if (runningRuns) lines.push(`Actions: ${runningRuns} in corso`);
  if (gh) lines.push(`GitHub: ${gh} elementi`);
  tray.setToolTip(lines.join('\n'));
}

function buildTrayMenu() {
  const hooks = hooksInstaller.status();
  // In sviluppo l'eseguibile è electron.exe e serve il percorso dell'app; l'exe pacchettizzato parte da solo.
  const args = app.isPackaged ? [] : [app.getAppPath()];
  const login = app.getLoginItemSettings({ path: process.execPath, args }).openAtLogin;
  return Menu.buildFromTemplate([
    { label: 'Mostra AiBro', click: () => showWindow() },
    { type: 'separator' },
    hooks.installed
      ? { label: 'Rimuovi hook di Claude Code', click: () => { store.hooks = hooksInstaller.uninstall(); store.changed(); } }
      : { label: 'Installa hook di Claude Code', click: () => { store.hooks = hooksInstaller.install(); store.changed(); } },
    {
      label: 'Sempre in primo piano', type: 'checkbox', checked: config.alwaysOnTop,
      click: (i) => { config.alwaysOnTop = i.checked; win.setAlwaysOnTop(i.checked || dock.collapsed); saveConfig(); },
    },
    {
      label: 'Avvia con Windows', type: 'checkbox', checked: login,
      click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked, path: process.execPath, args }),
    },
    { type: 'separator' },
    { label: 'Esci', click: () => { quitting = true; app.quit(); } },
  ]);
}

function createTray() {
  tray = new Tray(icon('idle'));
  tray.on('click', toggleWindow);
  tray.on('right-click', () => tray.popUpContextMenu(buildTrayMenu()));
  updateTray();
}

// ---------- Attenzione / notifiche ----------

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body: (body || '').slice(0, 240), silent: false, icon: APP_ICON });
  n.on('click', () => { showWindow(); onClick?.(); });
  n.show();
}

function sessionTitle(id) {
  return store.sessions.get(id)?.title || 'Sessione';
}

store.on('attention', (ev) => {
  if (ev.kind === 'approval') {
    // Una richiesta di approvazione apre subito il popup.
    showWindow();
    win.flashFrame(true);
    win.webContents.send('focus-approval', ev.approvalId);
    notify(`Approvazione richiesta · ${sessionTitle(ev.sessionId)}`, `Vuole usare ${ev.tool}`);
  } else if (ev.kind === 'input') {
    showWindow(false);
    notify(`${sessionTitle(ev.sessionId)} attende una risposta`, ev.message);
  } else if (ev.kind === 'done' && config.notifyDone && !(win.isVisible() && win.isFocused())) {
    notify(`${sessionTitle(ev.sessionId)} ha finito`, ev.message, () => win.webContents.send('open-session', ev.sessionId));
  }
});

store.on('change', () => {
  updateTray();
  win?.webContents.send('state', store.snapshot());
});

store.on('messages', (id) => {
  win?.webContents.send('session-messages', { id, messages: runner.messages(id) });
});

// ---------- Polling ----------

async function refreshApps() {
  try { store.apps = await scanApps(); store.changed(); } catch (e) { console.error('scan app', e.message); }
}

async function refreshUsage() {
  try {
    const summary = await usage.refresh();
    if (!summary) return;
    const { sessions, ...rest } = summary;
    store.usage = rest;
    // Le sessioni del terminale mostrano la spesa stimata dal transcript; quelle di AiBro usano il costo dell'SDK.
    for (const s of store.sessions.values()) if (s.source !== 'app' && sessions[s.id] != null) s.costUsd = sessions[s.id];
    store.changed();
  } catch (e) { console.error('consumi', e.message); }
}

// Notifica i run appena falliti e quelli visti in corso che ora sono andati a buon fine.
function notifyActions(runs, firstRun) {
  for (const r of runs) {
    const prev = runStates.get(r.id);
    const state = `${r.status}|${r.conclusion}|${r.attempt}`;
    runStates.set(r.id, state);
    if (firstRun || prev === state || r.status !== 'completed') continue;
    const name = `${r.repo} · ${r.workflow} (${r.branch})`;
    if (FAILED.has(r.conclusion)) {
      notify(`❌ Action fallita · ${r.repo}`, `${r.workflow} su ${r.branch}\n${r.title}`, () => shell.openExternal(r.url));
    } else if (r.conclusion === 'success' && prev && !prev.startsWith('completed')) {
      notify('✅ Action completata', name, () => shell.openExternal(r.url));
    }
  }
}

function scheduleGithub() {
  clearTimeout(githubTimer);
  const busy = store.github.actions.some((r) => r.status !== 'completed');
  githubTimer = setTimeout(refreshGithub, busy ? GITHUB_BUSY_INTERVAL_MS : GITHUB_INTERVAL_MS);
}

async function refreshGithub() {
  const token = githubToken();
  if (!token) { store.github = { ...store.github, configured: false }; store.changed(); scheduleGithub(); return; }
  try {
    const data = await fetchGithub(token, { repos: config.githubRepos || [] });
    const fresh = [...data.notifications, ...data.reviews].filter((x) => !seenGithub.has(x.id));
    const firstRun = !store.github.updatedAt;
    fresh.forEach((x) => seenGithub.add(x.id));
    notifyActions(data.actions, firstRun);
    store.github = { configured: true, ...data, error: null, updatedAt: Date.now() };
    if (!firstRun && fresh.length) {
      notify(`GitHub · ${fresh.length} novità`, fresh.slice(0, 3).map((x) => `${x.repo}: ${x.title}`).join('\n'));
    }
  } catch (e) {
    store.github = { ...store.github, configured: true, error: e.message };
  }
  store.changed();
  scheduleGithub();
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.handle('state', () => store.snapshot());
  ipcMain.handle('config', () => ({
    alwaysOnTop: config.alwaysOnTop,
    notifyDone: config.notifyDone,
    opacity: clampOpacity(config.opacity),
    collapseAfterSec: config.collapseAfterSec,
    collapseEdge: config.collapseEdge,
    hasGithubToken: !!githubToken(),
    githubRepos: config.githubRepos || [],
  }));
  ipcMain.handle('config:set', (_e, patch) => {
    if ('alwaysOnTop' in patch) { config.alwaysOnTop = !!patch.alwaysOnTop; win.setAlwaysOnTop(config.alwaysOnTop || dock.collapsed); }
    if ('notifyDone' in patch) config.notifyDone = !!patch.notifyDone;
    if ('opacity' in patch) { config.opacity = clampOpacity(patch.opacity); win.setOpacity(config.opacity); }
    if ('collapseAfterSec' in patch) { config.collapseAfterSec = clampDelay(patch.collapseAfterSec); dock.idleSince = Date.now(); }
    if ('collapseEdge' in patch && EDGES.includes(patch.collapseEdge)) config.collapseEdge = patch.collapseEdge;
    if ('githubRepos' in patch) {
      config.githubRepos = [...new Set((patch.githubRepos || []).map((r) => r.trim()).filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r)))];
      refreshGithub();
    }
    saveConfig();
    return config.githubRepos;
  });

  ipcMain.handle('approval:resolve', (_e, { id, behavior, always, message }) => {
    const a = store.approvals.get(id);
    if (!a) return false;
    const decision = behavior === 'allow'
      ? { behavior: 'allow', ...(always && a.suggestions?.length ? { updatedPermissions: a.suggestions } : {}) }
      : { behavior: 'deny', message: message || "Rifiutato dall'utente in AiBro" };
    return store.resolveApproval(id, decision);
  });

  ipcMain.handle('session:messages', async (_e, id) => {
    const s = store.sessions.get(id);
    if (!s) return [];
    if (s.source === 'app') return runner.messages(id);
    try { return await runner.history(id); } catch (e) { return [{ role: 'error', text: `Cronologia non disponibile: ${e.message}` }]; }
  });
  ipcMain.handle('session:send', (_e, { id, text }) => runner.send(id, text));
  ipcMain.handle('session:interrupt', (_e, id) => runner.interrupt(id));
  ipcMain.handle('session:close', (_e, id) => {
    const s = store.sessions.get(id);
    if (s?.source === 'app') runner.close(id); else store.removeSession(id);
  });
  ipcMain.handle('session:start', (_e, opts) => runner.start(opts));
  ipcMain.handle('session:resume', (_e, { sessionId, cwd, prompt, title }) => runner.start({ resumeId: sessionId, cwd, prompt, title }));
  ipcMain.handle('sessions:recent', () => runner.recentSessions());
  ipcMain.handle('pick-folder', async () => {
    dock.dialog = true; // il dialogo prende il focus: la finestra non deve contrarsi
    try {
      const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
      return r.canceled ? null : r.filePaths[0];
    } finally {
      dock.dialog = false;
    }
  });

  ipcMain.handle('apps:focus', (_e, pid) => focusApp(pid));
  ipcMain.handle('apps:refresh', refreshApps);
  ipcMain.handle('usage:refresh', refreshUsage);

  ipcMain.handle('github:set-token', async (_e, token) => {
    if (token) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Cifratura non disponibile su questo sistema');
      config.githubToken = safeStorage.encryptString(token.trim()).toString('base64');
    } else {
      delete config.githubToken;
    }
    saveConfig();
    seenGithub.clear();
    runStates.clear();
    store.github = { configured: false, notifications: [], reviews: [], actions: [], error: null, updatedAt: null };
    await refreshGithub();
  });
  ipcMain.handle('github:refresh', refreshGithub);
  ipcMain.handle('github:mark-read', async (_e, id) => {
    const token = githubToken();
    if (!token) return;
    await markRead(token, id);
    store.github.notifications = store.github.notifications.filter((n) => n.id !== id);
    store.changed();
  });
  ipcMain.handle('github:rerun', async (_e, { repo, runId }) => {
    const token = githubToken();
    if (!token) throw new Error('Token GitHub non configurato');
    await rerunFailed(token, repo, runId);
    setTimeout(refreshGithub, 3000);
  });
  ipcMain.handle('open-url',(_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });

  ipcMain.handle('hooks:install', () => { store.hooks = hooksInstaller.install(); store.changed(); return store.hooks; });
  ipcMain.handle('hooks:uninstall', () => { store.hooks = hooksInstaller.uninstall(); store.changed(); return store.hooks; });

  ipcMain.handle('window:hide', () => win.hide());
  ipcMain.handle('window:expand', () => { if (dock.collapsed) expandWindow(); });
}

// ---------- Avvio ----------

app.on('second-instance', () => showWindow());

app.whenReady().then(async () => {
  try {
    hookServer = await startHookServer(store);
  } catch (e) {
    dialog.showErrorBox('AiBro', `Impossibile avviare il server degli hook: ${e.message}`);
  }
  try { store.hooks = hooksInstaller.refresh(); } catch (e) { console.error('hook', e.message); store.hooks = hooksInstaller.status(); }
  registerIpc();
  createWindow();
  createTray();
  win.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) showWindow(); });

  refreshApps();
  refreshGithub();
  refreshUsage();
  setInterval(refreshApps, APPS_INTERVAL_MS);
  setInterval(refreshUsage, USAGE_INTERVAL_MS);
  setInterval(tickDock, COLLAPSE_POLL_MS);
  setInterval(() => store.pruneEnded(), 60 * 1000);
});

app.on('before-quit', () => {
  quitting = true;
  // Le richieste in sospeso tornano al terminale (risposta vuota).
  for (const a of [...store.approvals.values()]) store.dropApproval(a.id);
  runner.closeAll();
  hookServer?.close();
});

app.on('window-all-closed', (e) => e.preventDefault());
