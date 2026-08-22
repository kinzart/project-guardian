// Ignore rules + event-significance classification for `guardian watch` (V0.3). Reuses the same
// exclude list / secret deny-list the discovery walker already trusts — no separate policy to
// keep in sync by hand.

import path from 'node:path';
import { isSecretFileName, isSecretDirName } from '../util/secrets.js';
import { KNOWN_MARKDOWN_FILES } from '../inspectors/markdownInspector.js';

const TEMP_FILE_PATTERNS = [/\.tmp$/i, /\.swp$/i, /\.swo$/i, /~$/, /^~\$/, /\.crdownload$/i, /\.part$/i];

function isTempFile(name) {
  return TEMP_FILE_PATTERNS.some((re) => re.test(name));
}

function normalizeAbs(p) {
  return p.replace(/\\/g, '/').toLowerCase();
}

// True when absPath must never even generate a coalesced event: excluded directory, temp/swap
// file, or (for .git) anything other than the handful of files that actually signal activity.
export function isIgnoredChange(absPath, { projectRoot, excludeNames = [], excludePaths = [] }) {
  const rel = path.relative(projectRoot, absPath);
  const segments = rel.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) return true;
  const base = segments[segments.length - 1];

  if (isTempFile(base)) return true;

  // Checked against every segment, including the last: fs.watch can report an event whose
  // filename IS the excluded directory itself (e.g. "node_modules" being created), not just a
  // file nested inside it.
  const excludeSet = new Set(excludeNames.map((n) => n.toLowerCase()));
  for (const seg of segments) {
    if (excludeSet.has(seg.toLowerCase())) return true;
  }

  const patterns = excludePaths.map((p) => p.replace(/\\/g, '/').toLowerCase());
  const normalized = normalizeAbs(absPath);
  if (patterns.some((pattern) => normalized.endsWith(pattern))) return true;

  const gitIdx = segments.indexOf('.git');
  if (gitIdx !== -1) {
    const gitRel = segments[gitIdx + 1];
    // Only HEAD / index / refs/** are meaningful activity signals — never watch .git/objects or
    // a noisy .git/logs for their own sake (that's exactly the "thousands of watchers" trap).
    const allowed = gitRel === 'HEAD' || gitRel === 'index' || gitRel === 'refs';
    if (!allowed) return true;
  }

  return false;
}

// Secret-shaped paths are never even acknowledged by filename in an event — see
// SPEC_V0.3.md "Security". Checked before isIgnoredChange so a protected path is never silently
// folded into the ordinary ignore count either; it gets its own minimal, name-free event.
export function isProtectedChange(absPath) {
  const segments = absPath.split(/[\\/]+/).filter(Boolean);
  const base = segments[segments.length - 1] || '';
  return isSecretFileName(base) || segments.some((seg) => isSecretDirName(seg));
}

const INTELLIGENCE_DOC_FILES = new Set(KNOWN_MARKDOWN_FILES);
const MANIFEST_FILES = new Set(['package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'composer.json', 'pom.xml', 'build.gradle']);

export function classifySignificance(absPath, projectRoot) {
  const rel = path.relative(projectRoot, absPath).replace(/\\/g, '/');
  const segments = rel.split('/').filter(Boolean);
  const base = segments[segments.length - 1] || '';

  if (segments[0] === '.memory') return 'INTELLIGENCE_RELEVANT';
  if (INTELLIGENCE_DOC_FILES.has(base)) return 'INTELLIGENCE_RELEVANT';
  if (MANIFEST_FILES.has(base)) return 'DISCOVERY_RELEVANT';
  if (base.toLowerCase().endsWith('.csproj') || base.toLowerCase() === '.sln') return 'DISCOVERY_RELEVANT';
  // Anything else under the project root (source code, config, assets, .git/HEAD|index|refs) is
  // a genuine activity signal, just not one that changes what intelligence already extracted.
  return 'ACTIVITY_ONLY';
}
