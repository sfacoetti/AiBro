// Consumi di token e spesa stimata, letti dai transcript di Claude Code (~/.claude/projects/**/*.jsonl).
// Ogni risposta del modello porta usage e model: il costo è calcolato con le tariffe API Anthropic.
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const DAY_MS = 24 * 60 * 60 * 1000;

// $ per milione di token: [input, output, lettura cache]. Scrittura cache: 1,25× input (5 min), 2× input (1 h).
const PRICES = {
  'claude-fable-5-1': [10, 50, 0.25],
  'claude-mythos-5-1': [10, 50, 0.25],
  'claude-fable-5': [10, 50, 1],
  'claude-mythos-5': [10, 50, 1],
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-opus-5': [5, 25, 0.5],
  'claude-opus-4-8': [5, 25, 0.5],
  'claude-opus-4-7': [5, 25, 0.5],
  'claude-opus-4-6': [5, 25, 0.5],
  'claude-opus-4-5': [5, 25, 0.5],
  'claude-opus-4-1': [15, 75, 1.5],
  'claude-opus-4': [15, 75, 1.5],
  'claude-sonnet-5-5': [2, 10, 0.2],
  'claude-sonnet-5': [2, 10, 0.2],
  'claude-sonnet-4': [3, 15, 0.3],
  'claude-3-7-sonnet': [3, 15, 0.3],
  'claude-haiku-5-5': [0.1, 0.5, 0.01],
  'claude-haiku-4-5': [1, 5, 0.1],
  'claude-3-5-haiku': [0.8, 4, 0.08],
};
const PRICE_KEYS = Object.keys(PRICES).sort((a, b) => b.length - a.length);
const HAIKU_55_LONG = [0.5, 2.5, 0.05]; // prompt oltre 100K token

function priceOf(model) {
  const key = PRICE_KEYS.find((k) => model.startsWith(k));
  return key ? PRICES[key] : null;
}

function costOf(model, t, fast) {
  let p = priceOf(model);
  if (!p) return null;
  if (model.startsWith('claude-haiku-5-5') && t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h > 100000) p = HAIKU_55_LONG;
  const [inp, out, read] = p;
  const usd = (t.input * inp + t.output * out + t.cacheRead * read + t.cacheWrite5m * inp * 1.25 + t.cacheWrite1h * inp * 2) / 1e6;
  return fast ? usd * 2 : usd;
}

const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function parseLine(line) {
  if (!line.includes('"usage"')) return null;
  let j;
  try { j = JSON.parse(line); } catch { return null; }
  const m = j.message;
  if (j.type !== 'assistant' || !m?.usage || !m.model || m.model === '<synthetic>') return null;
  const u = m.usage;
  const cw = u.cache_creation || {};
  const cacheWrite1h = cw.ephemeral_1h_input_tokens || 0;
  const t = {
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheWrite1h,
    cacheWrite5m: cw.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens || 0) - cacheWrite1h),
  };
  const ts = Date.parse(j.timestamp) || 0;
  return {
    // Claude Code scrive una riga per ogni blocco della stessa risposta, con lo stesso usage.
    id: `${m.id}:${j.requestId || ''}`,
    ts,
    model: m.model,
    cwd: j.cwd || null,
    sessionId: j.sessionId || null,
    ...t,
    cost: costOf(m.model, t, u.speed === 'fast'),
  };
}

class UsageTracker {
  constructor() {
    this.files = new Map(); // percorso -> { offset, entries: Map id -> entry }
    this.busy = false;
  }

  // Legge solo i byte aggiunti dall'ultima scansione; un file accorciato viene riletto da capo.
  async readFile(file, size) {
    let f = this.files.get(file);
    if (!f || size < f.offset) { f = { offset: 0, entries: new Map() }; this.files.set(file, f); }
    if (size === f.offset) return;
    const fh = await fs.promises.open(file, 'r');
    try {
      const buf = Buffer.alloc(size - f.offset);
      const { bytesRead } = await fh.read(buf, 0, buf.length, f.offset);
      const end = buf.lastIndexOf(0x0a, bytesRead - 1);
      if (end < 0) return; // riga ancora incompleta
      for (const line of buf.toString('utf8', 0, end).split('\n')) {
        const e = parseLine(line);
        if (e) f.entries.set(e.id, e);
      }
      f.offset += end + 1;
    } finally {
      await fh.close();
    }
  }

  async refresh() {
    if (this.busy) return null;
    this.busy = true;
    try {
      let names = [];
      try { names = await fs.promises.readdir(PROJECTS_DIR, { recursive: true }); } catch { /* Claude Code mai usato */ }
      const seen = new Set();
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        const file = path.join(PROJECTS_DIR, name);
        seen.add(file);
        try {
          const st = await fs.promises.stat(file);
          await this.readFile(file, st.size);
        } catch { /* file rimosso durante la scansione */ }
        await new Promise(setImmediate); // non bloccare il processo principale
      }
      for (const file of this.files.keys()) if (!seen.has(file)) this.files.delete(file);
      return this.summary();
    } finally {
      this.busy = false;
    }
  }

  summary() {
    const all = new Map();
    for (const f of this.files.values()) for (const [id, e] of f.entries) all.set(id, e);

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const from = (days) => today.getTime() - (days - 1) * DAY_MS;
    const empty = () => ({ cost: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, messages: 0 });
    const add = (acc, e) => {
      acc.cost += e.cost || 0;
      acc.input += e.input;
      acc.output += e.output;
      acc.cacheWrite += e.cacheWrite5m + e.cacheWrite1h;
      acc.cacheRead += e.cacheRead;
      acc.messages += 1;
      return acc;
    };

    const totals = { today: empty(), week: empty(), month: empty() };
    const daily = new Map();
    for (let i = 13; i >= 0; i--) daily.set(dayKey(today.getTime() - i * DAY_MS), empty());
    const models = new Map();
    const projects = new Map();
    const sessions = {};
    const unpriced = new Set();

    for (const e of all.values()) {
      if (e.cost == null) unpriced.add(e.model);
      if (e.sessionId) sessions[e.sessionId] = (sessions[e.sessionId] || 0) + (e.cost || 0);
      if (e.ts < from(30)) continue;
      add(totals.month, e);
      if (e.ts >= from(7)) add(totals.week, e);
      if (e.ts >= from(1)) add(totals.today, e);
      const d = daily.get(dayKey(e.ts));
      if (d) add(d, e);
      const model = e.model.replace(/-\d{8}$/, '');
      add(models.get(model) || models.set(model, empty()).get(model), e);
      const proj = e.cwd || '(sconosciuto)';
      add(projects.get(proj) || projects.set(proj, empty()).get(proj), e);
    }

    const ranked = (map, n) => [...map].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.cost - a.cost).slice(0, n);
    return {
      updatedAt: Date.now(),
      totals,
      daily: [...daily].map(([day, v]) => ({ day, ...v })),
      models: ranked(models, 8),
      projects: ranked(projects, 8).map((p) => ({ ...p, label: path.basename(p.name) || p.name })),
      sessions,
      unpriced: [...unpriced],
    };
  }
}

module.exports = { UsageTracker };
