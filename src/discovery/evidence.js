// Evidence-based scoring for "is this directory a project?". A single lone .md file is
// deliberately never enough (max secondary-only score stays below the LOW threshold unless
// several secondary signals stack).

export const STRONG_EVIDENCE_WEIGHTS = {
  '.git': 50,
  '.memory': 50,
  'package.json': 30,
  'pyproject.toml': 30,
  'requirements.txt': 20,
  'Cargo.toml': 30,
  'go.mod': 30,
  'composer.json': 30,
  'pom.xml': 30,
  'build.gradle': 30,
};

// Matched by extension, checked separately against readdir entries.
export const STRONG_EVIDENCE_EXTENSIONS = {
  '.sln': 30,
  '.csproj': 30,
};

export const SECONDARY_EVIDENCE_WEIGHTS = {
  'README.md': 5,
  'AGENTS.md': 10,
  'CLAUDE.md': 10,
  'MINDMAP.md': 5,
  'TASKS.md': 5,
  'TODO.md': 5,
  src: 10,
  app: 10,
  tests: 5,
  docs: 5,
};

export function confidenceForScore(score, thresholds) {
  if (score >= thresholds.high) return 'HIGH';
  if (score >= thresholds.medium) return 'MEDIUM';
  if (score >= thresholds.low) return 'LOW';
  return 'NONE';
}

// entries: array of fs.Dirent-like { name, isDirectory() } for one directory (non-recursive).
export function scoreDirectory(entries) {
  const evidence = [];
  let score = 0;

  const byName = new Map(entries.map((e) => [e.name, e]));

  for (const [name, weight] of Object.entries(STRONG_EVIDENCE_WEIGHTS)) {
    if (byName.has(name)) {
      score += weight;
      evidence.push({ name, weight, tier: 'strong' });
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      for (const [ext, weight] of Object.entries(STRONG_EVIDENCE_EXTENSIONS)) {
        if (entry.name.toLowerCase().endsWith(ext)) {
          score += weight;
          evidence.push({ name: entry.name, weight, tier: 'strong' });
        }
      }
    }
  }

  for (const [name, weight] of Object.entries(SECONDARY_EVIDENCE_WEIGHTS)) {
    const entry = byName.get(name);
    if (entry) {
      score += weight;
      evidence.push({ name, weight, tier: 'secondary' });
    }
  }

  return { score, evidence };
}
