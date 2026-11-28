export function duplicateKey(name) {
  return String(name)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\(\d+\)/g, ' ')
    .replace(/\b(copia|copy|final|old|backup|bkp|novo|new)\b/g, ' ')
    .replace(/\bv\d+\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '');
}

export function findDuplicateGroups(projects) {
  const groups = new Map();
  for (const p of projects) {
    const key = duplicateKey(p.name);
    if (key.length < 3) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  return [...groups.entries()]
    .map(([key, list]) => ({ key, projects: list.filter((p, i, a) => a.findIndex((q) => q.root_path === p.root_path) === i) }))
    .filter((g) => g.projects.length >= 2)
    .sort((a, b) => b.projects.length - a.projects.length);
}
