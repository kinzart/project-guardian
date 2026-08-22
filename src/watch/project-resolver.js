import { isUnderRoot } from '../discovery/scanner.js';

// Longest-prefix match among the projects the watcher was started with. A new project appearing
// on disk after `guardian watch` started is out of scope for V0.3 (see SPEC_V0.3.md) — it
// simply resolves to null here until the next `guardian scan`.
export function resolveProject(absPath, projects) {
  let best = null;
  for (const project of projects) {
    if (!isUnderRoot(absPath, project.root_path)) continue;
    if (!best || project.root_path.length > best.root_path.length) best = project;
  }
  return best;
}
