// Polling di GitHub: notifiche non lette, PR in attesa della tua review ed esito delle Actions.
const API = 'https://api.github.com';
const AUTO_REPOS_MAX = 10;
const AUTO_REPOS_DAYS = 7;
const RUNS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Cache ETag: le risposte 304 non consumano il rate limit di GitHub.
const etagCache = new Map();

function htmlUrl(apiUrl, repoUrl) {
  if (!apiUrl) return repoUrl;
  return apiUrl
    .replace('https://api.github.com/repos/', 'https://github.com/')
    .replace(/\/pulls\/(\d+)$/, '/pull/$1')
    .replace(/\/commits\/([0-9a-f]+)$/, '/commit/$1');
}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'aibro',
  };
}

async function gh(token, pathAndQuery) {
  const cached = etagCache.get(pathAndQuery);
  const res = await fetch(API + pathAndQuery, {
    headers: { ...headers(token), ...(cached ? { 'If-None-Match': cached.etag } : {}) },
  });
  if (res.status === 304 && cached) return cached.data;
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const etag = res.headers.get('etag');
  if (etag) etagCache.set(pathAndQuery, { etag, data });
  return data;
}

async function autoRepos(token) {
  const repos = await gh(token, `/user/repos?sort=pushed&per_page=${AUTO_REPOS_MAX}&affiliation=owner,collaborator,organization_member`);
  const since = Date.now() - AUTO_REPOS_DAYS * 24 * 60 * 60 * 1000;
  return repos.filter((r) => !r.archived && Date.parse(r.pushed_at) > since).map((r) => r.full_name);
}

// Ultimo run per ogni coppia workflow + branch, così un vecchio errore già corretto non resta in vista.
async function fetchActions(token, repos) {
  const results = await Promise.allSettled(repos.map(async (repo) => {
    const data = await gh(token, `/repos/${repo}/actions/runs?per_page=15&exclude_pull_requests=true`);
    return data.workflow_runs.map((r) => ({
      id: String(r.id),
      repo,
      workflow: r.name,
      title: r.display_title,
      branch: r.head_branch,
      event: r.event,
      status: r.status, // queued | in_progress | completed | waiting | ...
      conclusion: r.conclusion, // success | failure | cancelled | skipped | timed_out | action_required | null
      actor: r.actor?.login,
      runNumber: r.run_number,
      attempt: r.run_attempt,
      url: r.html_url,
      updatedAt: r.updated_at,
    }));
  }));
  const latest = new Map();
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') { errors.push(`${repos[i]}: ${r.reason.message}`); return; }
    for (const run of r.value) {
      if (Date.now() - Date.parse(run.updatedAt) > RUNS_MAX_AGE_MS) continue;
      if (run.conclusion === 'skipped' || run.conclusion === 'neutral') continue;
      const key = `${run.repo}|${run.workflow}|${run.branch}`;
      const prev = latest.get(key);
      if (!prev || Date.parse(run.updatedAt) > Date.parse(prev.updatedAt)) latest.set(key, run);
    }
  });
  const runs = [...latest.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 25);
  return { runs, errors };
}

async function fetchGithub(token, { repos = [] } = {}) {
  const watched = repos.length ? repos : await autoRepos(token).catch(() => []);
  const [notifs, reviews, actions] = await Promise.all([
    gh(token, '/notifications?per_page=30'),
    gh(token, '/search/issues?per_page=20&q=' + encodeURIComponent('is:open is:pr review-requested:@me archived:false')),
    fetchActions(token, watched),
  ]);
  return {
    notifications: notifs.map((n) => ({
      id: n.id,
      title: n.subject.title,
      type: n.subject.type,
      reason: n.reason,
      repo: n.repository.full_name,
      url: htmlUrl(n.subject.url, n.repository.html_url),
      updatedAt: n.updated_at,
    })),
    reviews: reviews.items.map((i) => ({
      id: String(i.id),
      title: i.title,
      repo: i.repository_url.replace(`${API}/repos/`, ''),
      url: i.html_url,
      author: i.user?.login,
      updatedAt: i.updated_at,
    })),
    actions: actions.runs,
    actionsErrors: actions.errors,
    watchedRepos: watched,
    autoRepos: !repos.length,
  };
}

async function markRead(token, threadId) {
  await fetch(`${API}/notifications/threads/${encodeURIComponent(threadId)}`, {
    method: 'PATCH',
    headers: headers(token),
  });
}

// Rilancia solo i job falliti (serve il permesso Actions: write).
async function rerunFailed(token, repo, runId) {
  const res = await fetch(`${API}/repos/${repo}/actions/runs/${encodeURIComponent(runId)}/rerun-failed-jobs`, {
    method: 'POST',
    headers: headers(token),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

module.exports = { fetchGithub, markRead, rerunFailed };
