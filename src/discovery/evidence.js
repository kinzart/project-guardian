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
  // Creative project files (DAWs, video, design): a folder holding one is a project.
  '.song': 30,
  '.als': 30,
  '.flp': 30,
  '.cpr': 30,
  '.ptx': 30,
  '.rpp': 30,
  '.prproj': 30,
  '.aep': 30,
  '.psd': 30,
  '.ai': 30,
  '.blend': 30,
  '.kra': 30,
  '.fig': 30,
};

export const KIND_BY_EXTENSION = {
  '.song': 'music', '.als': 'music', '.flp': 'music', '.cpr': 'music', '.ptx': 'music', '.rpp': 'music',
  '.prproj': 'video', '.aep': 'video',
  '.psd': 'design', '.ai': 'design', '.blend': 'design', '.kra': 'design', '.fig': 'design',
};

export const MEDIA_KIND_BY_EXTENSION = {
  '.wav': 'music', '.mp3': 'music', '.flac': 'music', '.aif': 'music', '.aiff': 'music', '.ogg': 'music', '.m4a': 'music',
  '.mp4': 'video', '.mov': 'video', '.mkv': 'video', '.avi': 'video',
  '.jpg': 'media', '.jpeg': 'media', '.png': 'media', '.tif': 'media', '.tiff': 'media', '.raw': 'media', '.cr2': 'media', '.nef': 'media',
  '.pdf': 'docs', '.docx': 'docs', '.xlsx': 'docs', '.pptx': 'docs', '.txt': 'docs',
};

// A folder with at least this many top-level media/doc files counts as a (LOW) project.
export const MEDIA_FILE_THRESHOLD = 10;
export const MEDIA_EVIDENCE_WEIGHT = 10;

export function extensionOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i).toLowerCase() : '';
}

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

  const mediaCount = entries.filter((e) => !e.isDirectory() && MEDIA_KIND_BY_EXTENSION[extensionOf(e.name)]).length;
  if (mediaCount >= MEDIA_FILE_THRESHOLD) {
    score += MEDIA_EVIDENCE_WEIGHT;
    evidence.push({ name: 'media', weight: MEDIA_EVIDENCE_WEIGHT, tier: 'secondary' });
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
