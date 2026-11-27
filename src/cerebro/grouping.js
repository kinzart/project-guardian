import path from 'node:path';
import { stableProjectId } from '../util/paths.js';

const norm = (p) => String(p).toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
const under = (child, parent) => norm(child).startsWith(`${norm(parent)}/`);

// A folder detected only because it holds many media/doc files (no project file, no repo).
export function isLooseMedia(p) {
  return Array.isArray(p.evidence) && p.evidence.length > 0 && !p.evidence.some((e) => String(e).startsWith('strong:'));
}

function firstLevelFolder(p, roots) {
  const root = roots.filter((r) => norm(p.root_path) === norm(r) || under(p.root_path, r)).sort((a, b) => norm(b).length - norm(a).length)[0];
  if (!root) return p.root_path;
  const rel = norm(p.root_path).slice(norm(root).length).replace(/^\/+/, '');
  if (!rel) return p.root_path;
  const first = String(p.root_path).replace(/\\/g, '/').slice(String(root).replace(/\\/g, '/').replace(/\/+$/, '').length).replace(/^\/+/, '').split('/')[0];
  const sep = String(root).includes('\\') ? '\\' : '/';
  return `${String(root).replace(/[\\/]+$/, '')}${sep}${first}`;
}

// Loose media folders are not projects: they become content of the nearest real project above
// them, or else of the first-level folder of their drive/root (shown as one "pasta" item).
// Returns the items to show, what each item contains, and what each item sits inside.
export function groupProjects(projects, roots = []) {
  const real = projects.filter((p) => !isLooseMedia(p));
  const loose = projects.filter(isLooseMedia);
  const childrenOf = new Map();
  const folders = new Map();
  const add = (id, child) => { if (!childrenOf.has(id)) childrenOf.set(id, []); childrenOf.get(id).push(child); };
  for (const m of loose) {
    const owner = real.filter((r) => under(m.root_path, r.root_path)).sort((a, b) => b.root_path.length - a.root_path.length)[0];
    if (owner) { add(owner.id, m); continue; }
    const folderPath = firstLevelFolder(m, roots);
    const key = norm(folderPath);
    if (!folders.has(key)) {
      folders.set(key, { id: `pasta-${stableProjectId(folderPath)}`, name: path.basename(folderPath.replace(/\\/g, '/')) || folderPath, root_path: folderPath, evidence: ['folder'], is_folder: true, status: {}, kind: null, latest_entry: null, project_family: null });
    }
    add(folders.get(key).id, m);
  }
  for (const f of folders.values()) {
    const kids = childrenOf.get(f.id) || [];
    const counts = new Map(); for (const k of kids) counts.set(k.kind, (counts.get(k.kind) || 0) + 1);
    f.kind = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'media';
    f.latest_entry = kids.map((k) => k.latest_entry).filter(Boolean).sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)))[0] || null;
    f.last_file_activity = kids.map((k) => k.last_file_activity).filter(Boolean).sort().pop() || null;
  }
  const items = [...real, ...[...folders.values()].filter((f) => !real.some((r) => norm(r.root_path) === norm(f.root_path)))];
  // a real project at exactly the folder path absorbs that folder's children
  for (const f of folders.values()) {
    const same = real.find((r) => norm(r.root_path) === norm(f.root_path));
    if (same) for (const k of childrenOf.get(f.id) || []) add(same.id, k);
  }
  const parentOf = new Map();
  for (const it of items) {
    const parent = items.filter((o) => o.id !== it.id && under(it.root_path, o.root_path)).sort((a, b) => b.root_path.length - a.root_path.length)[0];
    if (parent) parentOf.set(it.id, parent);
  }
  return { items, childrenOf, parentOf };
}
