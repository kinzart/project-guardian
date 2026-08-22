// Project family / canonical / related-root heuristics (V0.1.1 inventory hygiene).
//
// Guardian must never blindly merge directories that merely share a name — each candidate
// stays its own project record with its own evidence. This module only *annotates* a probable
// relationship (project_family / canonical_project / related_roots) so a human can tell "these
// four look like the same project in different places" without Guardian inventing a merge.

// Suffixes that usually mark a copy/version of something rather than a distinct project.
const VERSION_SUFFIX_RE = /[\s_-]*\(?v(?:ers[aã]o|ersion)?\.?\s*\d+\)?\s*$/i;
const COPY_SUFFIX_RE = /[\s_-]*\(?(copy|c[oó]pia|clone|backup|old|duplicate)\)?\s*\d*\s*$/i;

// Normalized names shorter than this, or matching a common generic word, are too ambiguous to
// safely group by name alone (risk of unrelated projects colliding on "app", "test", ...).
const MIN_FAMILY_KEY_LENGTH = 4;
const GENERIC_NAME_STOPWORDS = new Set(['app', 'src', 'test', 'demo', 'main', 'project', 'new', 'temp', 'tmp', 'sample']);

export function normalizeProjectName(name) {
  let n = String(name || '').trim().toLowerCase();
  n = n.replace(VERSION_SUFFIX_RE, '');
  n = n.replace(COPY_SUFFIX_RE, '');
  n = n.replace(/[^a-z0-9]+/g, ' ').trim();
  return n;
}

function isUsableFamilyKey(key) {
  return key.length >= MIN_FAMILY_KEY_LENGTH && !GENERIC_NAME_STOPWORDS.has(key);
}

// Directory-name patterns along a path that hint the directory is a generated output, a
// scratch workspace, or a version/copy of something else, rather than an independently
// maintained project root.
const OUTPUT_DIR_NAMES = new Set(['outputs', 'output', 'generated', 'dist-copy', 'build-output']);
const WORKSPACE_DIR_NAMES = new Set(['work', 'workspace', 'tmp', 'temp', 'scratch']);
const ARCHIVE_DIR_NAMES = new Set(['archive', '_archive', 'backups', 'backup']);
const VERSION_DIR_RE = /(^|[-_ ])v\d+$/i;
const COPY_DIR_RE = /(copy|c[oó]pia|clone|duplicate)/i;

// Inspects every path segment (most specific / deepest first) and returns the first relation
// hint it recognizes: 'version' | 'output' | 'workspace' | 'copy' | 'related' (no hint found).
export function inferRelationType(candidatePath) {
  const segments = candidatePath.split(/[\\/]/).filter(Boolean).reverse();
  for (const seg of segments) {
    const lower = seg.toLowerCase();
    if (VERSION_DIR_RE.test(lower)) return 'version';
    if (OUTPUT_DIR_NAMES.has(lower)) return 'output';
    if (WORKSPACE_DIR_NAMES.has(lower)) return 'workspace';
    if (ARCHIVE_DIR_NAMES.has(lower)) return 'copy';
    if (COPY_DIR_RE.test(lower)) return 'copy';
  }
  return 'related';
}

const CONFIDENCE_RANK = { HIGH: 3, MEDIUM: 2, LOW: 1, NONE: 0 };

// candidates: [{ id, name, root_path, confidence, evidenceScore, hasDefinitiveEvidence }]
// Returns a Map<id, { project_family, canonical_project, is_canonical, relation_type, related_roots? }>
// for every candidate that belongs to a group of 2+ sharing a usable normalized name. Candidates
// with no family (unique name, or name too generic/short to trust) are simply absent from the map.
export function groupFamilies(candidates) {
  const byKey = new Map();
  for (const c of candidates) {
    const key = normalizeProjectName(c.name);
    if (!isUsableFamilyKey(key)) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(c);
  }

  const result = new Map();
  for (const [key, group] of byKey.entries()) {
    if (group.length < 2) continue;

    const ranked = [...group].sort((a, b) => {
      if (a.hasDefinitiveEvidence !== b.hasDefinitiveEvidence) return a.hasDefinitiveEvidence ? -1 : 1;
      const confDelta = (CONFIDENCE_RANK[b.confidence] || 0) - (CONFIDENCE_RANK[a.confidence] || 0);
      if (confDelta !== 0) return confDelta;
      return (b.evidenceScore || 0) - (a.evidenceScore || 0);
    });
    const canonical = ranked[0];

    const relatedRoots = [];
    for (const member of group) {
      const isCanonical = member.id === canonical.id;
      const relationType = isCanonical ? 'canonical' : inferRelationType(member.root_path);
      result.set(member.id, {
        project_family: key,
        canonical_project: canonical.id,
        is_canonical: isCanonical,
        relation_type: relationType,
      });
      if (!isCanonical) relatedRoots.push({ id: member.id, path: member.root_path, relation_type: relationType });
    }
    result.get(canonical.id).related_roots = relatedRoots;
  }
  return result;
}

// True when a candidate's own path suggests it is a generated/temporary/copy location AND it
// lacks the kind of evidence (.git, .memory) that would justify treating it as independently
// maintained anyway. Such a candidate is still recorded (never dropped) but must not be read as
// a confidently independent project without a human double-checking it.
export function isNestedCandidate(candidatePath, hasDefinitiveEvidence) {
  if (hasDefinitiveEvidence) return false;
  return inferRelationType(candidatePath) !== 'related';
}
