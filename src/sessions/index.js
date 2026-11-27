import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { readCodexSession, readCodexTitles } from './codex.js';
import { readClaudeSession } from './claude.js';
import { readHermesSessions } from './hermes.js';

function listJsonl(dir, depth) {
  const out = [];
  if (!dir || !existsSync(dir)) return out;
  const walk = (d, level) => {
    let entries; try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory() && level < depth) walk(full, level + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(dir, 0);
  return out;
}

function loadCache(cachePath) {
  try { return JSON.parse(readFileSync(cachePath, 'utf8')); } catch { return {}; }
}

// Index all agent sessions on disk. Files whose size+mtime match the cache are not re-read.
export async function indexSessions({ codexHome, claudeHome, hermesHome, cachePath = null }) {
  const cache = cachePath ? loadCache(cachePath) : {};
  const next = {};
  const titles = codexHome ? readCodexTitles(path.join(codexHome, 'session_index.jsonl')) : new Map();
  const results = [];
  const sources = [
    ...listJsonl(codexHome && path.join(codexHome, 'sessions'), 4).map((f) => ['codex', f]),
    ...listJsonl(claudeHome && path.join(claudeHome, 'projects'), 1).map((f) => ['claude', f]),
  ];
  for (const [agent, file] of sources) {
    let st; try { st = statSync(file); } catch { continue; }
    const key = `${st.size}:${Math.round(st.mtimeMs)}`;
    let record;
    if (cache[file]?.key === key) record = cache[file].record;
    else {
      try { record = agent === 'codex' ? readCodexSession(file, titles) : readClaudeSession(file); } catch { record = null; }
    }
    next[file] = { key, record };
    if (record) results.push(record);
  }
  results.push(...await readHermesSessions(hermesHome));
  if (cachePath) {
    try { mkdirSync(path.dirname(cachePath), { recursive: true }); writeFileSync(cachePath, JSON.stringify(next)); } catch { /* cache is optional */ }
  }
  return results;
}

const norm = (p) => String(p).toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');

// Map sessions to the project whose root is the longest prefix of the session cwd. When the
// agent ran in a parent folder of the projects (e.g. D:\APPS\X with the project at X\app),
// the session is attached to the projects under that folder, if there are at most
// MAX_CHILD_MATCHES of them.
export const MAX_CHILD_MATCHES = 3;
export function mapSessionsToProjects(sessions, projects) {
  const roots = projects.map((p) => ({ id: p.id, root: norm(p.root_path) })).sort((a, b) => b.root.length - a.root.length);
  const map = new Map();
  for (const s of sessions) {
    if (!s.cwd) continue;
    const cwd = norm(s.cwd);
    const hit = roots.find((r) => cwd === r.root || cwd.startsWith(`${r.root}/`));
    const targets = hit ? [hit] : roots.filter((r) => r.root.startsWith(`${cwd}/`));
    if (!targets.length || targets.length > MAX_CHILD_MATCHES) continue;
    for (const t of targets) {
      if (!map.has(t.id)) map.set(t.id, []);
      map.get(t.id).push(s);
    }
  }
  for (const list of map.values()) list.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  return map;
}
