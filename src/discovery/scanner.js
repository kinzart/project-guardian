import { statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import { walkPruned } from './walker.js';
import { scoreDirectory, confidenceForScore, extensionOf, KIND_BY_EXTENSION, MEDIA_KIND_BY_EXTENSION } from './evidence.js';
import { inspectGit } from '../inspectors/gitInspector.js';
import { inspectAum } from '../inspectors/aumInspector.js';
import { inspectMarkdown } from '../inspectors/markdownInspector.js';
import { classify } from '../activity/classify.js';
import { stableProjectId } from '../util/paths.js';
import { groupFamilies, inferRelationType, isNestedCandidate } from './family.js';

const PROJECT_TYPE_RULES = [
  ['package.json', 'node'],
  ['pyproject.toml', 'python'],
  ['requirements.txt', 'python'],
  ['Cargo.toml', 'rust'],
  ['go.mod', 'go'],
  ['composer.json', 'php'],
  ['pom.xml', 'java'],
  ['build.gradle', 'java'],
];

function deriveProjectTypes(entryNames) {
  const types = new Set();
  for (const [fileName, type] of PROJECT_TYPE_RULES) {
    if (entryNames.has(fileName)) types.add(type);
  }
  if (entryNames.has('.sln') || [...entryNames].some((n) => n.toLowerCase().endsWith('.csproj'))) {
    types.add('dotnet');
  }
  if (types.size === 0 && entryNames.has('.git')) types.add('git-only');
  if (types.size === 0 && entryNames.has('.memory')) types.add('aum-only');
  if (types.size === 0) types.add('unknown');
  return Array.from(types);
}

function safeReadPrefix(filePath, maxBytes) {
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const bytesRead = readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString('utf8', 0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

// What kind of work this folder holds: a creative project file wins, then code manifests,
// then the majority media type among top-level files.
export function deriveKind(entries, projectTypes) {
  const counts = new Map();
  for (const e of entries) {
    if (e.isDirectory()) continue;
    const ext = extensionOf(e.name);
    if (KIND_BY_EXTENSION[ext]) return KIND_BY_EXTENSION[ext];
    const media = MEDIA_KIND_BY_EXTENSION[ext];
    if (media) counts.set(media, (counts.get(media) || 0) + 1);
  }
  if (projectTypes.some((t) => t !== 'unknown')) return 'code';
  let best = null;
  for (const [kind, n] of counts) if (!best || n > best[1]) best = [kind, n];
  return best ? best[0] : 'other';
}

function deriveName(dirPath, entryNames, metadataOnly = false) {
  if (!metadataOnly && entryNames.has('package.json')) {
    try {
      const text = safeReadPrefix(path.join(dirPath, 'package.json'), 4096);
      const parsed = JSON.parse(text);
      if (typeof parsed.name === 'string' && parsed.name.trim()) return parsed.name.trim();
    } catch {
      // fall through to basename
    }
  }
  return path.basename(dirPath);
}

export function isUnderRoot(candidatePath, rootPath) {
  const normalize = (p) => p.toLowerCase().replace(/[\\/]+$/, '').split(/[\\/]+/).join('/');
  const candidate = normalize(candidatePath);
  const root = normalize(rootPath);
  return candidate === root || candidate.startsWith(`${root}/`);
}

function computeFingerprint(dirPath, entries) {
  let maxMtimeMs = 0;
  let latestName = null;
  let latestEntryMs = 0;
  const bump = (mtimeMs, name) => {
    if (mtimeMs > maxMtimeMs) maxMtimeMs = mtimeMs;
    if (name && mtimeMs > latestEntryMs) { latestEntryMs = mtimeMs; latestName = name; }
  };

  for (const entry of entries) {
    if (entry.name === '.git') {
      // The .git directory's own mtime (and .git/index) is mutated by git itself as a side
      // effect of read-only commands like `status`/`log` refreshing their stat cache, which
      // would make the fingerprint change on every scan even when nothing real happened.
      // HEAD only changes on an actual commit/checkout, so it's a stable signal instead.
      try {
        bump(statSync(path.join(dirPath, '.git', 'HEAD')).mtimeMs);
      } catch {
        // .git present but HEAD unreadable (corrupt repo) — ignore for fingerprint purposes
      }
      continue;
    }
    try {
      bump(statSync(path.join(dirPath, entry.name)).mtimeMs, entry.name);
    } catch {
      // unreadable entry, ignore for fingerprint purposes
    }
  }
  return {
    fingerprint: `${entries.length}:${Math.round(maxMtimeMs)}`,
    latestEntry: latestName ? { name: latestName, mtime: new Date(latestEntryMs).toISOString() } : null,
  };
}

export async function runScan({ config, store, logger, roots }) {
  const scanId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  const projectDirs = [];
  const metadataOnlyRoots = config.metadataOnlyRoots || [];
  const shouldDescend = (dirPath, entries) => {
    const { score, evidence } = scoreDirectory(entries);
    const confidence = confidenceForScore(score, config.confidenceThresholds);
    if (confidence !== 'NONE') {
      projectDirs.push({ dirPath, entries, score, evidence, confidence });
      return false;
    }
    return true;
  };

  const walkErrors = [];
  for (const _ of walkPruned(roots, {
    exclude: config.exclude,
    excludePaths: config.excludePaths || [],
    maxDepth: config.maxDepth,
    maxDirectoriesVisited: config.maxDirectoriesVisited,
    shouldDescend,
    onError: (e) => {
      walkErrors.push(e);
      logger.warn(e.message, { path: e.path });
    },
  })) {
    // draining the generator performs the walk; collection happens in shouldDescend
  }

  // Cheap pre-pass (readdir results already in hand, no inspectors run yet): derive name/id and
  // a "definitive evidence" flag (.git or .memory only — a lone manifest file doesn't count) for
  // every candidate, so project-family grouping and nested-candidate hints can be computed
  // before the expensive per-project inspection loop below.
  const baseInfos = projectDirs.map(({ dirPath, entries, score, evidence, confidence }) => {
    const entryNames = new Set(entries.map((e) => e.name));
    const hasDefinitiveEvidence = evidence.some((e) => e.tier === 'strong' && (e.name === '.git' || e.name === '.memory'));
    return {
      dirPath,
      entries,
      entryNames,
      score,
      evidence,
      confidence,
      id: stableProjectId(dirPath),
      name: deriveName(dirPath, entryNames, metadataOnlyRoots.some((r) => isUnderRoot(dirPath, r))),
      hasDefinitiveEvidence,
    };
  });

  const familyMap = groupFamilies(
    baseInfos.map((b) => ({
      id: b.id,
      name: b.name,
      root_path: b.dirPath,
      confidence: b.confidence,
      evidenceScore: b.score,
      hasDefinitiveEvidence: b.hasDefinitiveEvidence,
    })),
  );

  let projectsUnchanged = 0;
  let projectsProcessed = 0;

  for (const { dirPath, entries, entryNames, score, evidence, confidence, id, name, hasDefinitiveEvidence } of baseInfos) {
    const { fingerprint, latestEntry } = computeFingerprint(dirPath, entries);
    const metadataOnly = metadataOnlyRoots.some((r) => isUnderRoot(dirPath, r));
    const existing = await store.getProject(id);

    // Family/nested-candidate annotations are pure in-memory heuristics over this scan's
    // candidate set (no I/O), so they're cheap to recompute every scan — including for
    // unchanged projects — rather than letting them go stale between incremental hits.
    const familyInfo = familyMap.get(id) || null;
    const familyFields = {
      project_family: familyInfo?.project_family ?? null,
      canonical_project: familyInfo?.canonical_project ?? null,
      is_canonical: familyInfo?.is_canonical ?? null,
      relation_type: familyInfo?.relation_type ?? null,
      related_roots: familyInfo?.related_roots ?? null,
      path_relation_hint: inferRelationType(dirPath),
      nested_candidate: isNestedCandidate(dirPath, hasDefinitiveEvidence),
    };

    if (existing && existing.fingerprint === fingerprint) {
      await store.upsertProject({
        ...existing,
        kind: existing.kind ?? deriveKind(entries, existing.project_type || []),
        metadata_only: metadataOnly,
        latest_entry: latestEntry,
        last_seen: startedAt,
        ...familyFields,
      });
      projectsUnchanged += 1;
      continue;
    }

    const errors = [];
    let git = null;
    if (!metadataOnly && entryNames.has('.git')) {
      try {
        git = await inspectGit(dirPath);
        if (git.errors?.length) errors.push(...git.errors.map((e) => `git: ${e}`));
      } catch (err) {
        errors.push(`git: ${err.message}`);
      }
    }

    let aum = null;
    if (!metadataOnly && entryNames.has('.memory')) {
      try {
        aum = inspectAum(dirPath);
        if (aum.errors?.length) errors.push(...aum.errors.map((e) => `aum: ${e}`));
      } catch (err) {
        errors.push(`aum: ${err.message}`);
      }
    }

    let markdown = null;
    if (!metadataOnly) {
      try {
        markdown = inspectMarkdown(dirPath);
      } catch (err) {
        errors.push(`markdown: ${err.message}`);
      }
    }

    let rootMtimeIso = null;
    try {
      rootMtimeIso = statSync(dirPath).mtime.toISOString();
    } catch {
      // ignore
    }

    const activity = classify({ git, aum, markdown, rootMtimeIso }, config.activityThresholds, startedAtMs);

    const projectTypes = deriveProjectTypes(entryNames);
    const project = {
      id,
      name,
      kind: deriveKind(entries, projectTypes),
      metadata_only: metadataOnly,
      latest_entry: latestEntry,
      root_path: dirPath,
      detected_at: existing?.detected_at || startedAt,
      last_seen: startedAt,
      confidence,
      evidence_score: score,
      evidence: evidence.map((e) => `${e.tier}:${e.name}(+${e.weight})`),
      project_type: projectTypes,
      has_git: entryNames.has('.git'),
      has_aum: entryNames.has('.memory'),
      last_git_activity: git?.lastCommitDate || null,
      last_file_activity: rootMtimeIso,
      activity_score_hours: activity.activityScoreHours,
      status: {
        activity_state: activity.activityState,
        completion_state: activity.completionState,
      },
      status_confidence: {
        activity_evidence: activity.activityEvidence,
        completion_evidence: activity.completionEvidence,
      },
      completion_detail: {
        source: activity.completionSource,
        evidence: activity.completionEvidence[0] || null,
        updated_at: activity.completionUpdatedAt,
      },
      ...familyFields,
      fingerprint,
      errors,
    };

    await store.upsertProject(project);

    if (git) {
      await store.addSource({
        project_id: id,
        source_type: 'git',
        path: path.join(dirPath, '.git'),
        last_modified: git.lastCommitDate || null,
        metadata: { branch: git.branch, dirty: git.dirty, recentCommitCount: git.recentCommitCount, remotes: git.remotes },
      });
    }
    if (aum?.present) {
      await store.addSource({
        project_id: id,
        source_type: 'aum',
        path: path.join(dirPath, '.memory'),
        last_modified: null,
        metadata: { files: Object.keys(aum.files || {}) },
      });
      for (const [fileName, info] of Object.entries(aum.files || {})) {
        await store.addObservation({
          project_id: id,
          kind: 'aum_state',
          value: JSON.stringify({ fileName, ...info }),
          source_path: path.join(dirPath, '.memory', fileName),
          observed_at: startedAt,
        });
      }
    }
    if (markdown) {
      for (const [fileName, info] of Object.entries(markdown)) {
        await store.addSource({
          project_id: id,
          source_type: 'markdown',
          path: path.join(dirPath, fileName),
          last_modified: info.mtime,
          metadata: { title: info.title, statusLine: info.statusLine },
        });
        if (info.title || info.statusLine) {
          await store.addObservation({
            project_id: id,
            kind: 'markdown_heading',
            value: info.title || info.statusLine,
            source_path: path.join(dirPath, fileName),
            observed_at: startedAt,
          });
        }
      }
    }

    projectsProcessed += 1;
  }

  // Prune stale records: a project previously stored but no longer found as a candidate under
  // one of this scan's roots (e.g. it now falls under a newly-added exclude rule, or the
  // directory itself is gone). Skipped entirely if the walk hit any error — including the
  // maxDirectoriesVisited safety cap — since an incomplete walk must never be mistaken for
  // "this project no longer exists" and cause a false deletion.
  let projectsPruned = 0;
  if (walkErrors.length === 0) {
    const candidateRootPaths = new Set(baseInfos.map((b) => b.dirPath));
    const existingProjects = await store.listProjects();
    for (const p of existingProjects) {
      if (candidateRootPaths.has(p.root_path)) continue;
      if (!roots.some((r) => isUnderRoot(p.root_path, r))) continue;
      await store.removeProject(p.id);
      projectsPruned += 1;
      logger.info('pruned stale project no longer detected under scanned roots', { path: p.root_path });
    }
  }

  const finishedAt = new Date().toISOString();
  const scan = {
    scan_id: scanId,
    started_at: startedAt,
    finished_at: finishedAt,
    roots,
    projects_found: projectDirs.length,
    projects_unchanged: projectsUnchanged,
    projects_processed: projectsProcessed,
    projects_pruned: projectsPruned,
    errors: walkErrors.length + logger.errorCount,
    duration_ms: Date.now() - startedAtMs,
  };

  await store.recordScan(scan);
  return scan;
}
