const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, Notification, screen, shell, dialog, safeStorage } = require('electron');
const path = require('path');
const { Store } = require('./store');
const { startHookServer } = require('./hookServer');
const { AgentRunner } = require('./agentRunner');
const hooksInstaller = require('./hooksInstaller');
const { scanApps, focusApp } = require('./desktopApps');
const { fetchGithub, markRead, rerunFailed } = require('./github');
const git = require('./git');
const { overlayBadge } = require('./icons');
const { UsageTracker } = require('./usage');
const { CONFIG_FILE, APP_ICON, readJson, writeJson } = require('./paths');

const WIN_W = 380;
const WIN_H = 600;
const MIN_W = 320;
const MIN_H = 360;
const APPS_INTERVAL_MS = 10 * 1000;
const GITHUB_INTERVAL_MS = 60 * 1000;
const GITHUB_BUSY_INTERVAL_MS = 20 * 1000; // con Actions in corso
const USAGE_INTERVAL_MS = 30 * 1000;
const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);
const LOCAL_REPOS_INTERVAL_MS = 10 * 1000; // git status è locale; il fetch dal remoto ha un suo intervallo in git.js
const LOCAL_REPOS_MAX = 10;
const BUDDY_SIZE = 64;
const BUDDY_DRAG_MS = 16;
const BUDDY_NAP_MS = 30 * 1000; // sessioni ferme da tanto così: il buddy si addormenta
const BUDDY_TICK_MS = 1000;

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
let config = readJson(CONFIG_FILE, { alwaysOnTop: true, notifyDone: true });
// Opzioni della vecchia contrazione sul bordo, sostituita dal buddy.
for (const k of ['collapseAfterSec', 'collapseEdge', 'collapsedOpacity']) delete config[k];
const clampOpacity = (v) => Math.min(1, Math.max(0.3, Number(v) || 1));
let win = null;
let buddy = null;
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
  const remember = () => { config.bounds = win.getContentBounds(); saveConfig(); };
  win.on('moved', remember);
  win.on('resized', remember);
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
}

function showWindow(focus = true) {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  if (focus) { win.show(); win.focus(); } else win.showInactive();
}

function toggleWindow() {
  if (win.isVisible() && win.isFocused()) win.hide();
  else showWindow();
}

// ---------- Buddy ----------
// La bolla trasparente sempre in primo piano che sostituisce la finestra all'avvio: si trascina col tasto sinistro,
// col destro apre la finestra. L'espressione riassume lo stato delle sessioni.

const mood = { current: 'neutro', busyAt: Date.now(), done: null, pokedAt: 0 };

function defaultBuddyPos() {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - BUDDY_SIZE - 24, y: wa.y + wa.height - BUDDY_SIZE - 24 };
}

function createBuddy() {
  const saved = config.buddyPos;
  const pos = saved && boundsOnScreen({ ...saved, width: BUDDY_SIZE, height: BUDDY_SIZE }) ? saved : defaultBuddyPos();
  buddy = new BrowserWindow({
    ...pos,
    width: BUDDY_SIZE,
    height: BUDDY_SIZE,
    useContentSize: true,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    focusable: false, // non ruba il focus alle altre finestre quando lo si tocca
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: 'AiBro',
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  buddy.setAlwaysOnTop(true, 'floating');
  buddy.loadFile(path.join(__dirname, '..', 'ui', 'buddy.html'));
  buddy.webContents.on('will-navigate', (e) => e.preventDefault());
  buddy.on('close', (e) => { if (!quitting) e.preventDefault(); });
  buddy.once('ready-to-show', () => buddy.showInactive());
}

// quest: qualcuno aspetta l'utente. work: una sessione sta lavorando. neutro: appena finito senza successo, o a riposo.
// happy: l'ultima sessione ha finito bene. nap: tutto fermo da più di BUDDY_NAP_MS.
function computeMood() {
  const now = Date.now();
  const live = [...store.sessions.values()].filter((s) => s.status !== 'ended');
  // idle_prompt arriva quando una sessione finita resta ferma: non è una domanda, è riposo.
  const asking = store.approvals.size || live.some((s) => s.status === 'waiting'
    || (s.status === 'waiting-input' && s.inputKind !== 'idle_prompt')
    || (s.status === 'running' && /^AskUserQuestion\b/.test(s.activity || '')));
  if (asking) { mood.busyAt = now; return 'quest'; }
  if (live.some((s) => s.status === 'running')) { mood.busyAt = now; return 'work'; }
  const quietSince = Math.max(mood.busyAt, mood.done?.at || 0, mood.pokedAt);
  if (now - quietSince >= BUDDY_NAP_MS) return 'nap';
  return mood.done?.ok && mood.done.at >= mood.busyAt ? 'happy' : 'neutro';
}

function updateMood() {
  const m = computeMood();
  if (m === mood.current) return;
  mood.current = m;
  buddy?.webContents.send('buddy-mood', m);
}

// Il trascinamento segue il cursore dal processo principale: funziona anche tra monitor con DPI diversi.
const drag = { timer: null, offset: null, last: null };

function startBuddyDrag() {
  stopBuddyDrag();
  const p = screen.getCursorScreenPoint();
  const [x, y] = buddy.getPosition();
  drag.offset = { x: p.x - x, y: p.y - y };
  drag.last = { ...p, t: Date.now() };
  drag.v = { x: 0, y: 0 };
  // Toccarlo lo sveglia (da sveglio non torna felice per una sessione finita prima del sonnellino).
  if (mood.current === 'nap') mood.done = null;
  mood.pokedAt = Date.now();
  updateMood();
  drag.timer = setInterval(() => {
    const c = screen.getCursorScreenPoint();
    const now = Date.now();
    const dt = Math.max(1, now - drag.last.t) / 1000;
    const moved = c.x !== drag.last.x || c.y !== drag.last.y;
    // Velocità smorzata: tra due letture il cursore spesso non si è mosso.
    drag.v.x = drag.v.x * 0.7 + ((c.x - drag.last.x) / dt) * 0.3;
    drag.v.y = drag.v.y * 0.7 + ((c.y - drag.last.y) / dt) * 0.3;
    drag.last = { ...c, t: now };
    if (moved) buddy.setBounds({ x: c.x - drag.offset.x, y: c.y - drag.offset.y, width: BUDDY_SIZE, height: BUDDY_SIZE });
    buddy.webContents.send('buddy-motion', { vx: drag.v.x, vy: drag.v.y, moving: true });
  }, BUDDY_DRAG_MS);
}

function stopBuddyDrag() {
  if (!drag.timer) return;
  clearInterval(drag.timer);
  drag.timer = null;
  buddy.webContents.send('buddy-motion', { vx: 0, vy: 0, moving: false });
  const [x, y] = buddy.getPosition();
  config.buddyPos = { x, y };
  saveConfig();
  mood.pokedAt = Date.now();
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
      click: (i) => { config.alwaysOnTop = i.checked; win.setAlwaysOnTop(i.checked); saveConfig(); },
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

// La finestra non si apre più da sola: lo stato lo mostra il buddy, la notifica porta alla finestra.
store.on('attention', (ev) => {
  if (ev.kind === 'approval') {
    if (win.isVisible()) win.webContents.send('focus-approval', ev.approvalId);
    notify(`Approvazione richiesta · ${sessionTitle(ev.sessionId)}`, `Vuole usare ${ev.tool}`, () => win.webContents.send('focus-approval', ev.approvalId));
  } else if (ev.kind === 'input') {
    notify(`${sessionTitle(ev.sessionId)} attende una risposta`, ev.message);
  } else if (ev.kind === 'done') {
    mood.done = { at: Date.now(), ok: !!ev.ok };
    refreshLocalRepos(); // a fine turno l'agente ha spesso appena modificato o committato
    if (config.notifyDone && !(win.isVisible() && win.isFocused())) {
      notify(`${sessionTitle(ev.sessionId)} ha finito`, ev.message, () => win.webContents.send('open-session', ev.sessionId));
    }
  }
  updateMood();
});

store.on('change', () => {
  updateTray();
  updateMood();
  checkSessionRepos();
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

// Repo GitHub delle cartelle delle sessioni, dalla più recente. Comprende le sessioni appena terminate:
// le Actions partono spesso dopo il push finale.
async function sessionRepos() {
  const cwds = [...new Set([...store.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((s) => s.cwd).filter(Boolean))];
  const repos = await Promise.all(cwds.map(git.githubRepoOf));
  return [...new Set(repos.filter(Boolean))];
}

// Stato git delle cartelle delle sessioni (raggruppate per repository): cosa c'è da committare, pushare, scaricare.
const localPoll = { busy: false, last: '' };

async function refreshLocalRepos() {
  if (localPoll.busy) return;
  localPoll.busy = true;
  try {
    const sessions = [...store.sessions.values()].filter((s) => s.cwd).sort((a, b) => b.updatedAt - a.updatedAt);
    const byRoot = new Map();
    for (const s of sessions) {
      const root = await git.repoRoot(s.cwd);
      if (!root) continue;
      if (!byRoot.has(root)) byRoot.set(root, { cwd: s.cwd, sessions: [] });
      byRoot.get(root).sessions.push(s.title || path.basename(s.cwd));
    }
    const repos = await Promise.all([...byRoot].slice(0, LOCAL_REPOS_MAX).map(async ([root, { cwd, sessions: titles }]) => {
      const base = { path: root, name: path.basename(root), github: await git.githubRepoOf(cwd), sessions: [...new Set(titles)] };
      try { return { ...base, ...(await git.repoStatus(root)) }; } catch (e) { return { ...base, error: e.message }; }
    }));
    const json = JSON.stringify(repos);
    if (json !== localPoll.last) { localPoll.last = json; store.localRepos = repos; store.changed(); }
  } finally {
    localPoll.busy = false;
  }
}

// Una sessione in un repo nuovo aggiorna subito le Actions invece di aspettare il prossimo giro.
const githubPoll = { busy: false, sessionRepos: '' }; // sessionRepos: quelli usati nell'ultimo aggiornamento

async function checkSessionRepos() {
  if (githubPoll.busy || !store.github.configured) return;
  if ((await sessionRepos()).join() !== githubPoll.sessionRepos) refreshGithub();
}

async function refreshGithub() {
  const token = githubToken();
  if (!token) { store.github = { ...store.github, configured: false }; store.changed(); scheduleGithub(); return; }
  githubPoll.busy = true;
  try {
    const repos = await sessionRepos();
    githubPoll.sessionRepos = repos.join();
    const data = await fetchGithub(token, { repos: config.githubRepos || [], sessionRepos: repos });
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
  } finally {
    githubPoll.busy = false;
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
    hasGithubToken: !!githubToken(),
    githubRepos: config.githubRepos || [],
  }));
  ipcMain.handle('config:set', (_e, patch) => {
    if ('alwaysOnTop' in patch) { config.alwaysOnTop = !!patch.alwaysOnTop; win.setAlwaysOnTop(config.alwaysOnTop); }
    if ('notifyDone' in patch) config.notifyDone = !!patch.notifyDone;
    if ('opacity' in patch) { config.opacity = clampOpacity(patch.opacity); win.setOpacity(config.opacity); }
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
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
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
  const localRepo = (root) => {
    if (!store.localRepos.some((r) => r.path === root)) throw new Error('Repository non monitorato');
    return root;
  };
  const afterGit = async () => { await refreshLocalRepos(); setTimeout(refreshGithub, 3000); };
  ipcMain.handle('git:push', async (_e, root) => { await git.push(localRepo(root)); await afterGit(); });
  ipcMain.handle('git:pull', async (_e, root) => { await git.pull(localRepo(root)); await afterGit(); });
  ipcMain.handle('git:open-folder', (_e, root) => shell.openPath(localRepo(root)));
  ipcMain.handle('open-url',(_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });

  ipcMain.handle('hooks:install', () => { store.hooks = hooksInstaller.install(); store.changed(); return store.hooks; });
  ipcMain.handle('hooks:uninstall', () => { store.hooks = hooksInstaller.uninstall(); store.changed(); return store.hooks; });

  ipcMain.handle('window:hide', () => win.hide());

  ipcMain.handle('buddy:open', () => showWindow());
  // Doppio clic: chiude la finestra aperta, altrimenti la apre.
  ipcMain.handle('buddy:toggle', () => { if (win.isVisible()) win.hide(); else showWindow(); });
  ipcMain.handle('buddy:mood', () => mood.current);
  ipcMain.handle('buddy:drag', (_e, on) => (on ? startBuddyDrag() : stopBuddyDrag()));
  // Gli angoli trasparenti della finestra quadrata lasciano passare i clic; i movimenti arrivano comunque.
  ipcMain.handle('buddy:ignore-mouse', (_e, ignore) => buddy.setIgnoreMouseEvents(!!ignore, { forward: true }));
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
  createBuddy();
  createTray();
  mood.current = computeMood();
  setInterval(updateMood, BUDDY_TICK_MS);

  refreshApps();
  refreshGithub();
  refreshUsage();
  setInterval(refreshApps, APPS_INTERVAL_MS);
  setInterval(refreshUsage, USAGE_INTERVAL_MS);
  refreshLocalRepos();
  setInterval(refreshLocalRepos, LOCAL_REPOS_INTERVAL_MS);
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
