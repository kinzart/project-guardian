import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { stableProjectId } from '../util/paths.js';

const norm = (p) => String(p).toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
const under = (child, parent) => norm(child).startsWith(`${norm(parent)}/`);
function splitPath(p) { return String(p).replace(/\\/g, '/').replace(/\/+$/, '').split('/'); }
function joinLike(sample, parts) { return parts.join(String(sample).includes('\\') ? '\\' : '/'); }

// A folder detected only because it holds many media/doc files or a notes file (no project file, no repo).
export function isLooseMedia(p) {
  return Array.isArray(p.evidence) && p.evidence.length > 0 && !p.evidence.some((e) => String(e).startsWith('strong:'));
}
const hasStrong = (p) => !Array.isArray(p.evidence) || p.evidence.some((e) => String(e).startsWith('strong:'));

function rootOf(p, roots) {
  return roots.filter((r) => norm(p) === norm(r) || under(p, r)).sort((a, b) => norm(b).length - norm(a).length)[0] || null;
}

// The folder that represents "the project" for a path, following the person's rule: the first
// level under a scanned root is an area ("pasta do geral", e.g. D:\APPS E PROGRAMAS) and the
// folders right below it are the projects; anything deeper is content of that project. When the
// first-level folder is itself a real project (repo, manifest, DAW file), it is the project.
export function projectFolderFor(p, roots, strongTopLevel, strongPaths = []) {
  const root = rootOf(p, roots);
  if (!root) return { folder: p, area: null };
  const rootParts = splitPath(root).length;
  const parts = splitPath(p);
  const depth = parts.length - rootParts;
  if (depth <= 0) return { folder: p, area: null };
  const top = joinLike(p, parts.slice(0, rootParts + 1));
  if (depth === 1 || strongTopLevel.has(norm(top))) return { folder: top, area: null };
  // A container without its own project files that holds two or more real projects in
  // different subfolders (e.g. PLATAFORMA with MIX MASTER and CORTADOR) is an area too.
  // Inside such a container only the real projects become projects of their own; everything
  // else (outputs, recordings, caches) stays content of the container.
  let level = rootParts + 2;
  let area = top;
  while (level < parts.length) {
    const nf = norm(parts.slice(0, level).join('/'));
    if (strongPaths.includes(nf)) break;
    // only direct children that are themselves real projects count (not outputs deeper inside)
    const kids = new Set(strongPaths.filter((sp) => sp.startsWith(`${nf}/`) && !sp.slice(nf.length + 1).includes('/')).map((sp) => sp.slice(nf.length + 1)));
    if (kids.size < 2 || !kids.has(parts[level].toLowerCase())) break;
    area = joinLike(p, parts.slice(0, level));
    level += 1;
  }
  return { folder: joinLike(p, parts.slice(0, level)), area };
}

// Folds every detected folder (and every folder an AI agent worked in) into its project folder.
// Returns the items to show, what each item contains (deeper folders) and the area of each item.
const listDirs = (dir) => { try { return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$')).map((e) => path.join(dir, e.name)); } catch { return []; } };

// `listRoots` (the Google Drive roots) get one item per project folder read straight from the disk
// (area → folders inside it; an area without subfolders is the project), because nothing inside
// a Drive is opened, so the scanner finds little evidence there.
export function groupProjects(projects, roots = [], allSessions = [], { exists = existsSync, listRoots = [], dirsOf = listDirs } = {}) {
  // sessions whose folder no longer exists don't create projects
  const sessions = allSessions.filter((s) => s.cwd && exists(s.cwd));
  const strongTopLevel = new Set();
  for (const p of projects) {
    const root = rootOf(p.root_path, roots);
    if (root && hasStrong(p) && splitPath(p.root_path).length === splitPath(root).length + 1) strongTopLevel.add(norm(p.root_path));
  }
  const byPath = new Map(projects.map((p) => [norm(p.root_path), p]));
  // Real projects and folders where an AI agent worked anchor the structure.
  const strongPaths = [...new Set([
    ...projects.filter((p) => !isLooseMedia(p) && Array.isArray(p.evidence)).map((p) => norm(p.root_path)),
    ...sessions.filter((s) => s.cwd && rootOf(s.cwd, roots)).map((s) => norm(s.cwd)),
  ])];
  const items = new Map();
  const areaOf = new Map();
  const childrenOf = new Map();
  const itemFor = (folder) => {
    const key = norm(folder);
    if (!items.has(key)) {
      const own = byPath.get(key);
      items.set(key, own ? { ...own } : { id: `pasta-${stableProjectId(folder)}`, name: splitPath(folder).pop() || folder, root_path: folder, evidence: ['folder'], is_folder: true, status: {}, kind: null, latest_entry: null, last_file_activity: null, project_family: null });
    }
    return items.get(key);
  };
  const add = (id, child) => { if (!childrenOf.has(id)) childrenOf.set(id, []); childrenOf.get(id).push(child); };

  for (const p of projects) {
    if (!rootOf(p.root_path, roots)) { itemFor(p.root_path); continue; }
    const { folder, area } = projectFolderFor(p.root_path, roots, strongTopLevel, strongPaths);
    const item = itemFor(folder);
    if (area) areaOf.set(item.id, area);
    if (norm(folder) !== norm(p.root_path)) add(item.id, p);
  }
  for (const s of sessions) {
    if (!s.cwd || !rootOf(s.cwd, roots)) continue;
    const { folder, area } = projectFolderFor(s.cwd, roots, strongTopLevel, strongPaths);
    if (norm(folder) === norm(rootOf(s.cwd, roots))) continue;
    if (splitPath(s.cwd).length === splitPath(rootOf(s.cwd, roots)).length + 1 && !strongTopLevel.has(norm(folder)) && !byPath.has(norm(folder))) continue; // agent ran in an area folder
    const item = itemFor(folder);
    if (area) areaOf.set(item.id, area);
    if (item.is_folder && item.kind === null) item.evidence = ['ai-session'];
  }

  for (const lr of listRoots) {
    if (!roots.some((r) => norm(r) === norm(lr))) continue;
    const areas = dirsOf(lr);
    if (!areas.length) continue;
    // The Drive root and areas without their own project files stop being items: their folders are.
    const dropped = [];
    for (const f of [lr, ...areas]) {
      const it = items.get(norm(f));
      if (it && (norm(f) === norm(lr) || (!strongTopLevel.has(norm(f)) && dirsOf(f).length))) { items.delete(norm(f)); dropped.push(it); }
    }
    for (const area of areas) {
      const inside = dirsOf(area);
      for (const folder of inside.length ? inside : [area]) {
        const key = norm(folder);
        if (items.has(key) || [...items.keys()].some((k) => key.startsWith(`${k}/`) || k.startsWith(`${key}/`))) continue;
        const item = itemFor(folder);
        if (folder !== area) areaOf.set(item.id, area);
      }
    }
    for (const d of dropped) {
      for (const k of childrenOf.get(d.id) || []) {
        const owner = [...items.values()].filter((it) => under(k.root_path, it.root_path)).sort((a, b) => norm(b.root_path).length - norm(a.root_path).length)[0];
        if (owner) add(owner.id, k);
      }
      childrenOf.delete(d.id);
    }
  }

  for (const item of items.values()) {
    const kids = childrenOf.get(item.id) || [];
    if (!item.kind) {
      const strongKid = kids.find((k) => hasStrong(k) && k.kind && k.kind !== 'other');
      const counts = new Map(); for (const k of kids) counts.set(k.kind, (counts.get(k.kind) || 0) + 1);
      item.kind = strongKid?.kind || [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || (item.evidence?.[0] === 'ai-session' ? 'code' : 'other');
    }
    const latest = [item.latest_entry, ...kids.map((k) => k.latest_entry)].filter(Boolean).sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)))[0];
    item.latest_entry = latest || null;
    item.last_file_activity = [item.last_file_activity, ...kids.map((k) => k.last_file_activity)].filter(Boolean).sort().pop() || null;
  }
  return { items: [...items.values()], childrenOf, areaOf };
}

// Path of a child relative to its project, for display: "SAIDAS › Sessoes › RICK › uirec-…".
export function relativeLabel(child, parent) {
  const c = splitPath(child.root_path); const p = splitPath(parent.root_path);
  return c.slice(p.length).join(' › ') || child.name;
}
