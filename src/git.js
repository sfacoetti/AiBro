// Git locale delle cartelle delle sessioni: repository GitHub del remote, stato (modifiche, commit da
// pushare o da scaricare), fetch periodico, push e pull.
const { execFile } = require('child_process');
const path = require('path');

const FETCH_EVERY_MS = 3 * 60 * 1000;
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }; // niente richieste di credenziali bloccanti

function run(cwd, args, timeout = 10000) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { windowsHide: true, timeout, env, maxBuffer: 10 * 1024 * 1024 }, (err, out, errOut) => {
      if (err) reject(new Error((errOut || err.message).trim().split('\n').slice(-3).join('\n')));
      else resolve(out.trim());
    });
  });
}
const tryRun = (cwd, args) => run(cwd, args).catch(() => '');

function parseGithub(url) {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url || '');
  return m ? `${m[1]}/${m[2]}` : null;
}

// Preferisce origin, poi il primo remote che punta a GitHub.
async function lookupGithub(cwd) {
  const origin = parseGithub(await tryRun(cwd, ['remote', 'get-url', 'origin']));
  if (origin) return origin;
  for (const name of (await tryRun(cwd, ['remote'])).split(/\s+/).filter(Boolean)) {
    const repo = parseGithub(await tryRun(cwd, ['remote', 'get-url', name]));
    if (repo) return repo;
  }
  return null;
}

const githubCache = new Map(); // cwd -> Promise<owner/repo|null>
const rootCache = new Map(); // cwd -> Promise<cartella radice del repo|null>

function githubRepoOf(cwd) {
  if (!cwd) return Promise.resolve(null);
  if (!githubCache.has(cwd)) githubCache.set(cwd, lookupGithub(cwd));
  return githubCache.get(cwd);
}

function repoRoot(cwd) {
  if (!cwd) return Promise.resolve(null);
  if (!rootCache.has(cwd)) rootCache.set(cwd, tryRun(cwd, ['rev-parse', '--show-toplevel']).then((r) => (r ? path.normalize(r) : null)));
  return rootCache.get(cwd);
}

// git status --porcelain=v2 --branch: intestazioni "# branch.*" e una riga per file.
function parseStatus(out) {
  const st = { branch: null, upstream: null, ahead: 0, behind: 0, staged: 0, unstaged: 0, changed: 0, untracked: 0, conflicts: 0 };
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.head ')) st.branch = line.slice(14);
    else if (line.startsWith('# branch.upstream ')) st.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) { st.ahead = +m[1]; st.behind = +m[2]; }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      st.changed++; // un file in stage e poi modificato ancora conta una volta sola
      if (line[2] !== '.') st.staged++;
      if (line[3] !== '.') st.unstaged++;
    } else if (line.startsWith('u ')) st.conflicts++;
    else if (line.startsWith('? ')) st.untracked++;
  }
  if (st.branch === '(detached)') st.branch = null;
  return st;
}

const fetchedAt = new Map(); // radice -> ultimo fetch riuscito o tentato

async function repoStatus(root) {
  const last = fetchedAt.get(root) || 0;
  if (Date.now() - last >= FETCH_EVERY_MS) {
    fetchedAt.set(root, Date.now());
    await run(root, ['fetch', '--quiet', '--no-tags'], 30000).catch(() => {}); // offline: resta lo stato dell'ultimo fetch
  }
  const st = parseStatus(await run(root, ['status', '--porcelain=v2', '--branch']));
  // Commit locali su un branch mai pubblicato: tutti da pushare.
  if (!st.upstream && st.branch) st.ahead = Number(await tryRun(root, ['rev-list', '--count', 'HEAD', '--not', '--remotes'])) || 0;
  return { ...st, fetchedAt: fetchedAt.get(root) };
}

async function push(root) {
  const st = parseStatus(await run(root, ['status', '--porcelain=v2', '--branch']));
  if (!st.branch) throw new Error('Nessun branch attivo (HEAD staccato)');
  await run(root, st.upstream ? ['push'] : ['push', '-u', 'origin', st.branch], 120000);
}

async function pull(root) {
  await run(root, ['pull', '--ff-only'], 120000);
  fetchedAt.set(root, Date.now());
}

module.exports = { githubRepoOf, repoRoot, repoStatus, push, pull };
