/* global aibro */
const $ = (id) => document.getElementById(id);

let state = { sessions: [], approvals: [], apps: [], github: {}, hooks: {} };
let tab = 'sessions';
let openSessionId = null;
let openSessionUpdatedAt = 0;

// Costruttore DOM: il testo passa sempre da textContent, mai da innerHTML.
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v; // via CSSOM: la CSP blocca gli attributi style
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function ago(ts) {
  if (!ts) return '';
  const t = typeof ts === 'string' ? Date.parse(ts) : ts;
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'ora';
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} g`;
}

const STATUS_LABEL = {
  running: 'Al lavoro',
  waiting: 'Attende approvazione',
  'waiting-input': 'Attende una risposta',
  idle: 'In attesa',
  ended: 'Chiusa',
};

// ---------- Viste ----------

function showView(name) {
  for (const v of ['main', 'session', 'new', 'settings']) $(`view-${v}`).classList.toggle('hidden', v !== name);
  if (name !== 'session') openSessionId = null;
}

function showTab(name) {
  tab = name;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  for (const t of ['sessions', 'github', 'apps', 'usage']) $(`tab-${t}`).classList.toggle('hidden', t !== name);
  if (name === 'usage') aibro.refreshUsage();
}

// ---------- Render ----------

function render() {
  renderSummary();
  renderApprovals();
  renderSessions();
  renderGithub();
  renderApps();
  renderUsage();
  if (openSessionId) renderSessionHeader();
}

function renderSummary() {
  const active = state.sessions.filter((s) => s.status !== 'ended');
  const pills = [h('span', { class: 'pill' }, `${active.length} attive`)];
  if (state.approvals.length) pills.push(h('span', { class: 'pill amber' }, `${state.approvals.length} da approvare`));
  const input = active.filter((s) => s.status === 'waiting-input').length;
  if (input) pills.push(h('span', { class: 'pill blue' }, `${input} in attesa`));
  $('summary').replaceChildren(...pills);
  $('count-sessions').textContent = active.length || '';
  const gh = (state.github.notifications?.length || 0) + (state.github.reviews?.length || 0);
  const failedRuns = (state.github.actions || []).filter((r) => FAILED.has(r.conclusion)).length;
  $('count-github').textContent = gh || '';
  $('count-github').classList.toggle('fail', failedRuns > 0);
  if (failedRuns) {
    $('count-github').textContent = `${gh ? `${gh} · ` : ''}${failedRuns} ✗`;
    pills.push(h('span', { class: 'pill red', onclick: () => { showView('main'); showTab('github'); } }, `${failedRuns} Actions fallite`));
    $('summary').replaceChildren(...pills);
  }
  $('count-apps').textContent = state.apps.length || '';
}

function toolPreview(tool, input) {
  if (!input || typeof input !== 'object') return '';
  if (input.command) return input.command;
  if (input.file_path && (input.new_string || input.content)) {
    const body = input.new_string ?? input.content;
    return `${input.file_path}\n\n${String(body).slice(0, 1200)}`;
  }
  if (input.file_path) return input.file_path;
  if (input.url) return input.url;
  return JSON.stringify(input, null, 2).slice(0, 1500);
}

function renderApprovals() {
  const cards = state.approvals.map((a) => {
    const resolve = (behavior, always = false) => aibro.resolveApproval({ id: a.id, behavior, always });
    return h('div', { class: 'approval', 'data-id': a.id },
      h('div', { class: 'approval-head' },
        h('div', {}, h('b', {}, a.tool), ' · ', a.sessionTitle || 'Sessione'),
        h('span', { class: 'muted small' }, ago(a.createdAt))),
      a.reason ? h('div', { class: 'muted small' }, a.reason) : null,
      h('pre', {}, toolPreview(a.tool, a.input)),
      h('div', { class: 'approval-actions' },
        h('button', { class: 'primary', onclick: () => resolve('allow') }, 'Consenti'),
        a.suggestions?.length ? h('button', { class: 'ghost', onclick: () => resolve('allow', true), title: 'Non chiedere più per questo comando in questa sessione' }, 'Consenti sempre') : null,
        h('button', { class: 'danger', onclick: () => resolve('deny') }, 'Rifiuta'),
        h('button', { class: 'link', onclick: () => openSession(a.sessionId) }, 'Apri sessione')));
  });
  $('approvals').replaceChildren(...cards);
}

function sessionItem(s) {
  const line = s.status === 'running' || s.status === 'waiting' ? (s.activity || STATUS_LABEL[s.status])
    : s.status === 'waiting-input' ? STATUS_LABEL[s.status]
      : (s.lastMessage || s.lastPrompt || STATUS_LABEL[s.status]);
  return h('div', { class: `item ${s.status === 'ended' ? 'ended' : ''}`, onclick: () => openSession(s.id), title: s.cwd || '' },
    h('span', { class: `dot ${s.status}` }),
    h('div', { class: 'body' },
      h('div', { class: 'title' },
        h('span', {}, s.title || s.id.slice(0, 8)),
        h('span', { class: `chip ${s.source === 'app' ? 'app' : ''}` }, s.source === 'app' ? 'AIBRO' : 'CLI')),
      h('div', { class: 'line' }, String(line).split('\n')[0])),
    h('span', { class: 'time' }, ago(s.updatedAt)));
}

function renderSessions() {
  const el = $('tab-sessions');
  const parts = [];
  if (!state.hooks.installed) {
    parts.push(h('div', { class: 'banner' },
      h('div', {}, h('b', {}, 'Collega Claude Code'), h('div', { class: 'muted small' }, 'Installa gli hook per vedere qui le sessioni aperte nei terminali e approvare le richieste.')),
      h('button', { class: 'primary', onclick: () => aibro.installHooks() }, 'Installa hook')));
  }
  const active = state.sessions.filter((s) => s.status !== 'ended');
  const ended = state.sessions.filter((s) => s.status === 'ended');
  if (!state.sessions.length) {
    parts.push(h('div', { class: 'empty' }, 'Nessuna sessione AI attiva.', h('br'), h('span', { class: 'small' }, 'Avvia claude in un terminale o crea una sessione qui.')));
  }
  if (active.length) parts.push(h('div', { class: 'list' }, active.map(sessionItem)));
  if (ended.length) parts.push(h('div', { class: 'section-title' }, 'Chiuse di recente'), h('div', { class: 'list' }, ended.map(sessionItem)));
  parts.push(h('button', { class: 'ghost new-btn', onclick: openNew }, '+ Nuova sessione Claude Code'));
  el.replaceChildren(...parts);
}

function githubItem(x, canMarkRead) {
  return h('div', { class: 'item', onclick: () => aibro.openUrl(x.url), title: x.url },
    h('div', { class: 'body' },
      h('div', { class: 'title' }, h('span', {}, x.title)),
      h('div', { class: 'line' }, `${x.repo} · ${x.reason || (x.author ? `di ${x.author}` : x.type || '')}`)),
    h('span', { class: 'time' }, ago(x.updatedAt)),
    canMarkRead ? h('button', { class: 'icon-btn', title: 'Segna come letta', onclick: (e) => { e.stopPropagation(); aibro.markGithubRead(x.id); } }, '✓') : null);
}

const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

function runStatus(r) {
  if (r.status !== 'completed') return { cls: 'run-progress', icon: '●', label: r.status === 'queued' || r.status === 'waiting' ? 'In coda' : 'In corso' };
  if (r.conclusion === 'success') return { cls: 'run-ok', icon: '✓', label: 'Riuscita' };
  if (FAILED.has(r.conclusion)) return { cls: 'run-fail', icon: '✗', label: r.conclusion === 'timed_out' ? 'Timeout' : 'Fallita' };
  if (r.conclusion === 'action_required') return { cls: 'run-progress', icon: '!', label: 'Richiede azione' };
  return { cls: 'run-skip', icon: '⊘', label: r.conclusion === 'cancelled' ? 'Annullata' : 'Saltata' };
}

function actionItem(r) {
  const st = runStatus(r);
  const rerun = FAILED.has(r.conclusion)
    ? h('button', {
      class: 'ghost small',
      title: 'Rilancia i job falliti',
      onclick: async (e) => {
        e.stopPropagation();
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = '…';
        try { await aibro.rerunAction({ repo: r.repo, runId: r.id }); btn.textContent = 'Rilanciata'; } catch (err) { btn.textContent = 'Errore'; btn.title = err.message; }
      },
    }, 'Rilancia')
    : null;
  return h('div', { class: 'item', onclick: () => aibro.openUrl(r.url), title: `${st.label} · ${r.title}` },
    h('span', { class: `run-icon ${st.cls}` }, st.icon),
    h('div', { class: 'body' },
      h('div', { class: 'title' }, h('span', {}, r.workflow), h('span', { class: 'chip' }, r.branch || '')),
      h('div', { class: 'line' }, `${r.repo} · #${r.runNumber} ${r.title}`)),
    h('span', { class: 'time' }, ago(r.updatedAt)),
    rerun);
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Cosa resta da fare sul repository locale, nell'ordine in cui va fatto: risolvere, committare, pushare, scaricare.
function localRepoTodo(r) {
  if (r.error) return { cls: 'run-fail', icon: '✗', lines: [r.error] };
  const lines = [];
  const changes = r.changed + r.untracked;
  if (r.conflicts) lines.push(`${plural(r.conflicts, 'conflitto', 'conflitti')} da risolvere`);
  if (changes) {
    const detail = [r.staged && `${r.staged} in stage`, r.untracked && plural(r.untracked, 'non tracciato', 'non tracciati')].filter(Boolean).join(', ');
    lines.push(`${plural(changes, 'file modificato', 'file modificati')}${detail ? ` (${detail})` : ''}: da committare`);
  }
  if (r.ahead) lines.push(`${plural(r.ahead, 'commit', 'commit')} da pushare${r.upstream ? '' : ' (branch non ancora sul remoto)'}`);
  if (r.behind) lines.push(`${plural(r.behind, 'commit', 'commit')} sul remoto: puoi fare pull`);
  if (!r.upstream && !r.ahead && r.branch) lines.push('Branch senza remoto collegato');
  if (!lines.length) return { cls: 'run-ok', icon: '✓', lines: ['Tutto committato e allineato al remoto'] };
  return { cls: r.conflicts ? 'run-fail' : 'git-todo', icon: r.conflicts ? '!' : '●', lines };
}

function gitButton(label, title, action) {
  return h('button', {
    class: 'ghost small',
    title,
    onclick: async (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = '…';
      try { await action(); btn.textContent = 'Fatto'; } catch (err) { btn.textContent = 'Errore'; btn.title = err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); btn.disabled = false; }
    },
  }, label);
}

function localRepoItem(r) {
  const todo = localRepoTodo(r);
  const fetched = ago(r.fetchedAt);
  return h('div', { class: 'item', onclick: () => aibro.gitOpenFolder(r.path), title: `${r.path}\nSessioni: ${r.sessions.join(', ')}${fetched ? `\nUltimo fetch: ${fetched === 'ora' ? 'ora' : `${fetched} fa`}` : ''}` },
    h('span', { class: `run-icon ${todo.cls}` }, todo.icon),
    h('div', { class: 'body' },
      h('div', { class: 'title' }, h('span', {}, r.github || r.name), h('span', { class: 'chip' }, r.branch || 'HEAD staccato')),
      todo.lines.map((l) => h('div', { class: 'line' }, l))),
    r.behind && !r.error ? gitButton('Pull', 'git pull --ff-only', () => aibro.gitPull(r.path)) : null,
    r.ahead && !r.error ? gitButton('Push', 'git push', () => aibro.gitPush(r.path)) : null);
}

function renderGithub() {
  const g = state.github;
  const el = $('tab-github');
  const local = state.localRepos || [];
  const localParts = [
    h('div', { class: 'section-title' }, 'Repository locali delle sessioni'),
    local.length ? h('div', { class: 'list' }, local.map(localRepoItem)) : h('div', { class: 'muted small' }, 'Nessuna sessione in una cartella con git.'),
  ];
  if (!g.configured) {
    el.replaceChildren(...localParts, h('div', { class: 'banner' },
      h('div', {}, h('b', {}, 'Collega GitHub'), h('div', { class: 'muted small' }, 'Inserisci un personal access token nelle impostazioni per vedere Actions, notifiche e review richieste.')),
      h('button', { class: 'primary', onclick: openSettings }, 'Apri impostazioni')));
    return;
  }
  const parts = [...localParts];
  if (g.error) parts.push(h('div', { class: 'error' }, g.error));
  const runs = g.actions || [];
  const failed = runs.filter((r) => FAILED.has(r.conclusion)).length;
  parts.push(h('div', { class: 'section-title' }, `Actions${failed ? ` · ${failed} fallite` : ''}`));
  if (runs.length) parts.push(h('div', { class: 'list' }, runs.map(actionItem)));
  else {
    parts.push(h('div', { class: 'muted small' }, g.watchedRepos?.length
      ? 'Nessun run negli ultimi 7 giorni.'
      : 'Nessun repository con push recenti: aggiungine qualcuno nelle impostazioni.'));
  }
  if (g.actionsErrors?.length) parts.push(h('div', { class: 'error', title: g.actionsErrors.join('\n') }, `${g.actionsErrors.length} repository non leggibili (passa sopra per i dettagli)`));
  const source = { sessions: 'Repo delle sessioni', manual: 'Repo dalle impostazioni', auto: 'Repo con push recenti' }[g.watchSource] || 'Repo monitorati';
  parts.push(h('div', { class: 'muted small' }, `${source}: ${(g.watchedRepos || []).join(', ') || '—'}`));
  parts.push(h('div', { class: 'section-title' }, `Review richieste (${g.reviews?.length || 0})`));
  parts.push(g.reviews?.length ? h('div', { class: 'list' }, g.reviews.map((x) => githubItem(x, false))) : h('div', { class: 'muted small' }, 'Nessuna PR in attesa della tua review.'));
  parts.push(h('div', { class: 'section-title' }, `Notifiche (${g.notifications?.length || 0})`));
  parts.push(g.notifications?.length ? h('div', { class: 'list' }, g.notifications.map((x) => githubItem(x, true))) : h('div', { class: 'muted small' }, 'Nessuna notifica non letta.'));
  const when = ago(g.updatedAt);
  parts.push(h('div', { class: 'muted small', style: 'margin-top:10px' }, `Aggiornato ${when === 'ora' ? 'ora' : `${when} fa`} · `,
    h('button', { class: 'link', onclick: () => aibro.refreshGithub() }, 'aggiorna')));
  el.replaceChildren(...parts);
}

function renderApps() {
  const el = $('tab-apps');
  const parts = [h('div', { class: 'muted small', style: 'margin-bottom:8px' }, 'App AI aperte sul desktop. ChatGPT, Claude e Copilot non espongono le loro conversazioni: da qui puoi vederle e portarle in primo piano.')];
  if (!state.apps.length) parts.push(h('div', { class: 'empty' }, 'Nessuna app AI aperta.'));
  else {
    parts.push(h('div', { class: 'list' }, state.apps.map((a) => h('div', { class: 'item', onclick: () => aibro.focusApp(a.pid), title: 'Porta in primo piano' },
      h('span', { class: 'dot running' }),
      h('div', { class: 'body' }, h('div', { class: 'title' }, h('span', {}, a.label)), h('div', { class: 'line' }, a.title))))));
  }
  el.replaceChildren(...parts);
}

// ---------- Consumi ----------

function fmtCost(usd) {
  if (!usd) return '$0';
  if (usd < 0.01) return '<$0.01';
  return `$${usd < 100 ? usd.toFixed(2) : Math.round(usd).toLocaleString('it-IT')}`;
}

function fmtTokens(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

const totalTokens = (t) => t.input + t.output + t.cacheWrite + t.cacheRead;

function modelLabel(id) {
  return id.replace(/^claude-/, '').replace(/-(\d+)-(\d)$/, '-$1.$2').replace(/-(\d[\d.]*)$/, ' $1')
    .replace(/^\w/, (c) => c.toUpperCase());
}

function usageTile(label, t) {
  return h('div', { class: 'tile' },
    h('div', { class: 'tile-label' }, label),
    h('div', { class: 'tile-value' }, fmtCost(t.cost)),
    h('div', { class: 'tile-sub' }, `${fmtTokens(totalTokens(t))} token · ${t.messages} risposte`));
}

function dailyChart(daily) {
  const max = Math.max(...daily.map((d) => d.cost), 0.01);
  const total = daily.reduce((s, d) => s + d.cost, 0);
  const idle = `Ultimi 14 giorni · ${fmtCost(total)}`;
  const readout = h('div', { class: 'chart-readout' }, idle);
  const dayLabel = (d) => new Date(`${d.day}T00:00`).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
  const cols = daily.map((d, i) => h('div', {
    class: 'bar-col',
    onmouseenter: () => { readout.textContent = `${dayLabel(d)} · ${fmtCost(d.cost)} · ${fmtTokens(totalTokens(d))} token`; },
    onmouseleave: () => { readout.textContent = idle; },
  },
  h('div', { class: 'bar', style: `height:${d.cost ? Math.max(2, (d.cost / max) * 100) : 0}%` }),
  h('div', { class: 'bar-label' }, (daily.length - 1 - i) % 2 ? '' : String(Number(d.day.slice(8))))));
  return h('div', { class: 'chart' }, readout, h('div', { class: 'bars' }, cols));
}

function breakdown(title, rows, label) {
  if (!rows.length) return [];
  const max = Math.max(...rows.map((r) => r.cost), 0.01);
  return [
    h('div', { class: 'section-title' }, title),
    h('div', { class: 'list' }, rows.map((r) => h('div', { class: 'brk', title: `${r.name}\n${fmtTokens(totalTokens(r))} token · ${r.messages} risposte` },
      h('div', { class: 'brk-head' }, h('span', {}, label(r)), h('b', {}, fmtCost(r.cost))),
      h('div', { class: 'brk-track' }, h('div', { class: 'brk-fill', style: `width:${(r.cost / max) * 100}%` }))))),
  ];
}

let usageRenderedAt = null;

function renderUsage() {
  const u = state.usage;
  const el = $('tab-usage');
  $('count-usage').textContent = u?.totals.today.cost ? fmtCost(u.totals.today.cost) : '';
  if (!u) { el.replaceChildren(h('div', { class: 'empty' }, 'Lettura dei transcript di Claude Code…')); return; }
  // Lo stato cambia spesso mentre le sessioni lavorano: ridisegna solo con dati nuovi (non perde l'hover sul grafico).
  if (u.updatedAt === usageRenderedAt) return;
  usageRenderedAt = u.updatedAt;
  const m = u.totals.month;
  const when = ago(u.updatedAt);
  el.replaceChildren(
    h('div', { class: 'tiles' }, usageTile('Oggi', u.totals.today), usageTile('7 giorni', u.totals.week), usageTile('30 giorni', m)),
    dailyChart(u.daily),
    h('div', { class: 'section-title' }, 'Token · 30 giorni'),
    h('div', { class: 'token-grid' },
      [['Input', m.input], ['Output', m.output], ['Scrittura cache', m.cacheWrite], ['Lettura cache', m.cacheRead]]
        .map(([k, v]) => h('div', {}, h('span', { class: 'muted' }, k), h('b', {}, fmtTokens(v))))),
    ...breakdown('Per modello · 30 giorni', u.models, (r) => modelLabel(r.name)),
    ...breakdown('Per progetto · 30 giorni', u.projects, (r) => r.label),
    u.unpriced.length ? h('div', { class: 'muted small' }, `Senza tariffa (costo non conteggiato): ${u.unpriced.join(', ')}`) : null,
    h('div', { class: 'muted small', style: 'margin-top:10px' },
      'Spesa stimata con le tariffe API Anthropic dai transcript di Claude Code. Con un abbonamento Pro/Max non corrisponde a quanto paghi. ',
      `Aggiornato ${when === 'ora' ? 'ora' : `${when} fa`} · `,
      h('button', { class: 'link', onclick: () => aibro.refreshUsage() }, 'aggiorna')));
}

// ---------- Dettaglio sessione ----------

function currentSession() {
  return state.sessions.find((s) => s.id === openSessionId);
}

function renderSessionHeader() {
  const s = currentSession();
  if (!s) { showView('main'); return; }
  $('sess-title').textContent = s.title || s.id;
  $('sess-dot').className = `dot ${s.status}`;
  $('sess-dot').title = STATUS_LABEL[s.status] || s.status;
  $('sess-sub').textContent = `${STATUS_LABEL[s.status] || s.status} · ${s.cwd || ''}${s.costUsd ? ` · $${s.costUsd.toFixed(3)}` : ''}`;
  const isApp = s.source === 'app';
  $('btn-interrupt').classList.toggle('hidden', !(isApp && s.status === 'running'));
  $('resume-note').classList.toggle('hidden', isApp);
  const busyInTerminal = !isApp && (s.status === 'running' || s.status === 'waiting');
  $('input').disabled = busyInTerminal || (isApp && s.status === 'ended');
  $('btn-send').disabled = $('input').disabled;
  $('input').placeholder = busyInTerminal ? 'La sessione sta lavorando nel terminale…'
    : isApp ? 'Scrivi alla sessione… (Invio per inviare)' : 'Continua questa sessione da qui…';
  if (!isApp && s.updatedAt !== openSessionUpdatedAt) {
    openSessionUpdatedAt = s.updatedAt;
    loadMessages();
  }
}

function renderMessages(messages) {
  const s = currentSession();
  const box = $('messages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const items = messages.map((m) => h('div', { class: `msg ${m.role} ${m.past ? 'past' : ''}` }, m.text));
  if (s?.activity && (s.status === 'running' || s.status === 'waiting')) items.push(h('div', { class: 'activity' }, s.activity));
  if (!items.length) items.push(h('div', { class: 'empty' }, s?.lastPrompt ? `Ultimo prompt: ${s.lastPrompt}` : 'Nessun messaggio.'));
  box.replaceChildren(...items);
  if (atBottom) box.scrollTop = box.scrollHeight;
}

async function loadMessages() {
  const id = openSessionId;
  const msgs = await aibro.sessionMessages(id);
  if (id === openSessionId) renderMessages(msgs);
}

function openSession(id) {
  openSessionId = id;
  openSessionUpdatedAt = 0;
  $('messages').replaceChildren();
  showView('session');
  renderSessionHeader();
  if (currentSession()?.source === 'app') loadMessages();
  $('messages').scrollTop = $('messages').scrollHeight;
  $('input').focus();
}

async function sendMessage() {
  const text = $('input').value.trim();
  const s = currentSession();
  if (!text || !s) return;
  $('input').value = '';
  if (s.source === 'app') {
    await aibro.send({ id: s.id, text });
  } else {
    const newId = await aibro.resumeSession({ sessionId: s.id, cwd: s.cwd, prompt: text, title: s.title });
    openSession(newId);
  }
}

// ---------- Nuova sessione ----------

async function openNew() {
  showView('new');
  $('new-error').textContent = '';
  $('new-prompt').focus();
  const box = $('recent');
  try {
    const recent = await aibro.recentSessions();
    box.replaceChildren(...(recent.length ? recent.map((r) => h('div', {
      class: 'item',
      title: r.cwd || '',
      onclick: () => {
        const prompt = $('new-prompt').value.trim();
        if (!prompt) { $('new-error').textContent = 'Scrivi prima il messaggio con cui riprendere la sessione.'; $('new-prompt').focus(); return; }
        aibro.resumeSession({ sessionId: r.sessionId, cwd: r.cwd || $('new-cwd').value, prompt, title: r.title.slice(0, 60) }).then(openSession);
      },
    }, h('div', { class: 'body' }, h('div', { class: 'title' }, h('span', {}, r.title)), h('div', { class: 'line' }, r.cwd || '')),
    h('span', { class: 'time' }, ago(r.lastModified)))) : [h('div', { class: 'muted small' }, 'Nessuna sessione trovata.')]));
  } catch (e) {
    box.replaceChildren(h('div', { class: 'error' }, e.message));
  }
}

async function startNew() {
  const cwd = $('new-cwd').value.trim();
  const prompt = $('new-prompt').value.trim();
  if (!cwd || !prompt) { $('new-error').textContent = 'Indica cartella e primo messaggio.'; return; }
  $('btn-start').disabled = true;
  try {
    const id = await aibro.startSession({ cwd, prompt, permissionMode: $('new-mode').value });
    localStorage.setItem('lastCwd', cwd);
    $('new-prompt').value = '';
    openSession(id);
  } catch (e) {
    $('new-error').textContent = e.message;
  } finally {
    $('btn-start').disabled = false;
  }
}

// ---------- Impostazioni ----------

async function openSettings() {
  showView('settings');
  const cfg = await aibro.config();
  $('opt-ontop').checked = cfg.alwaysOnTop;
  $('opt-done').checked = cfg.notifyDone;
  $('opt-opacity').value = Math.round(cfg.opacity * 100);
  $('opt-opacity-value').textContent = `${$('opt-opacity').value}%`;
  $('gh-token').placeholder = cfg.hasGithubToken ? 'Token configurato — incollane uno nuovo per sostituirlo' : 'ghp_… / github_pat_…';
  $('gh-repos').value = cfg.githubRepos.join('\n');
  renderHooksStatus();
}

function renderHooksStatus() {
  const installed = state.hooks.installed;
  $('hooks-status').textContent = installed ? '✓ Hook installati' : state.hooks.partial ? 'Hook installati in parte' : 'Hook non installati';
  $('btn-hooks').textContent = installed ? 'Rimuovi' : 'Installa';
}

// ---------- Eventi ----------

function bind() {
  $('btn-hide').onclick = () => aibro.hide();
  $('btn-settings').onclick = openSettings;
  $('btn-back').onclick = () => showView('main');
  document.querySelectorAll('[data-back]').forEach((b) => { b.onclick = () => showView('main'); });
  document.querySelectorAll('.tabs button').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });

  $('btn-send').onclick = sendMessage;
  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  $('btn-interrupt').onclick = () => aibro.interrupt(openSessionId);
  $('btn-close-sess').onclick = async () => { await aibro.closeSession(openSessionId); showView('main'); };

  $('btn-pick').onclick = async () => { const p = await aibro.pickFolder(); if (p) $('new-cwd').value = p; };
  $('btn-start').onclick = startNew;
  $('new-cwd').value = localStorage.getItem('lastCwd') || '';

  $('btn-hooks').onclick = async () => {
    state.hooks = state.hooks.installed ? await aibro.uninstallHooks() : await aibro.installHooks();
    renderHooksStatus();
  };
  $('btn-gh-save').onclick = async () => {
    const t = $('gh-token').value.trim();
    if (!t) return;
    await aibro.setGithubToken(t);
    $('gh-token').value = '';
    openSettings();
  };
  $('btn-gh-repos').onclick = async () => {
    const saved = await aibro.setConfig({ githubRepos: $('gh-repos').value.split(/[\s,]+/) });
    $('gh-repos').value = saved.join('\n');
    $('gh-repos-msg').textContent = saved.length ? `Salvati ${saved.length} repository.` : 'Senza sessioni: repo con push recenti.';
  };
  $('btn-gh-clear').onclick =async () => { await aibro.setGithubToken(null); openSettings(); };
  $('opt-ontop').onchange = (e) => aibro.setConfig({ alwaysOnTop: e.target.checked });
  $('opt-done').onchange = (e) => aibro.setConfig({ notifyDone: e.target.checked });
  $('opt-opacity').oninput = (e) => {
    $('opt-opacity-value').textContent = `${e.target.value}%`;
    aibro.setConfig({ opacity: e.target.value / 100 });
  };

  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') showView('main'); });

  aibro.onState((s) => { state = s; render(); });
  aibro.onMessages(({ id, messages }) => { if (id === openSessionId) renderMessages(messages); });
  aibro.onFocusApproval((id) => {
    const el = document.querySelector(`.approval[data-id="${CSS.escape(id)}"]`);
    if (el) { el.scrollIntoView({ block: 'nearest' }); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  });
  aibro.onOpenSession(openSession);

  // I tempi relativi ("3 min") restano aggiornati.
  setInterval(render, 30 * 1000);
}

bind();
aibro.state().then((s) => { state = s; render(); });
