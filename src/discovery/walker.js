import { readdirSync } from 'node:fs';
import path from 'node:path';
import { isSecretDirName } from '../util/secrets.js';

function isExcludedName(name, excludeSet) {
  return excludeSet.has(name.toLowerCase());
}

// excludePathPatterns are pre-normalized (forward slashes, lowercase) relative path suffixes,
// e.g. ".vscode/extensions" — used for tooling/editor directories that must be excluded only
// in a specific nested location, not by bare directory name (a real project may legitimately
// have its own "extensions" folder; only ".vscode/extensions" is noise).
function isExcludedByPath(dirPath, name, excludePathPatterns) {
  if (excludePathPatterns.length === 0) return false;
  const full = `${dirPath}/${name}`.replace(/\\/g, '/').toLowerCase();
  return excludePathPatterns.some((pattern) => full.endsWith(pattern));
}

// Pre-order pruned directory walk. Never descends into an excluded name, an excluded compound
// path, a secret-shaped dirname, or (when shouldDescend returns false) a directory the caller
// has already decided is a terminal project root. Never reads file contents — only readdir +
// isDirectory().
//
// options.shouldDescend(dirPath, entries, depth) -> boolean, called after the directory is
// yielded, decides whether children are queued.
export function* walkPruned(
  roots,
  { exclude = [], excludePaths = [], maxDepth = 8, maxDirectoriesVisited = 50000, shouldDescend = () => true, onError = () => {} },
) {
  const excludeSet = new Set(exclude.map((e) => String(e).toLowerCase()));
  const excludePathPatterns = excludePaths.map((p) => p.replace(/\\/g, '/').toLowerCase());
  let visited = 0;
  const queue = roots.map((root) => ({ dirPath: root, depth: 0 }));

  while (queue.length > 0) {
    const { dirPath, depth } = queue.shift();

    if (visited >= maxDirectoriesVisited) {
      onError({ path: dirPath, message: 'maxDirectoriesVisited limit reached, stopping walk' });
      return;
    }

    let entries;
    try {
      entries = readdirSync(dirPath, { withFileTypes: true });
    } catch (err) {
      onError({ path: dirPath, message: `readdir failed: ${err.message}` });
      continue;
    }

    visited += 1;
    yield { dirPath, entries, depth };

    if (depth >= maxDepth) continue;
    if (!shouldDescend(dirPath, entries, depth)) continue;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (isExcludedName(entry.name, excludeSet)) continue;
      if (isSecretDirName(entry.name)) continue;
      if (isExcludedByPath(dirPath, entry.name, excludePathPatterns)) continue;
      queue.push({ dirPath: path.join(dirPath, entry.name), depth: depth + 1 });
    }
  }
}
