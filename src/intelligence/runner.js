// Orchestrates the V0.2 intelligence pass: for every project already in the store, decide
// whether its intelligence needs recomputing (a source file changed) or can be reused, then
// build the project + family-rollup snapshots. Kept entirely separate from src/discovery/
// scanner.js (the stable V0.1/V0.1.1 discovery pass) — this only reads what discovery already
// found, never re-walks the filesystem.

import { statSync } from 'node:fs';
import path from 'node:path';
import { analyzeAum } from './aumIntelligence.js';
import { analyzeMarkdown } from './markdownIntelligence.js';
import { analyzeGit } from './gitIntelligence.js';
import { buildProjectIntelligenceSnapshot } from './snapshot.js';
import { buildFamilyRollup } from './familyRollup.js';
import { KNOWN_MARKDOWN_FILES } from '../inspectors/markdownInspector.js';

function statMtime(p) {
  try {
    return Math.round(statSync(p).mtimeMs);
  } catch {
    return 0;
  }
}

// Deliberately independent of discovery's coarse project-level fingerprint (which only stats
// direct children of the project root and would miss a content-only edit to, say, BRIEF.md on
// some filesystems). Stats the exact known files intelligence actually reads, plus git HEAD
// (same rationale as discovery's fingerprint: HEAD only changes on a real commit/checkout,
// unlike .git's own mtime which git mutates as a read-side-effect).
export function computeIntelligenceFingerprint(rootPath, hasGit, hasAum) {
  const parts = [];
  if (hasAum) {
    for (const f of ['BRIEF.md', 'handoff.md', 'state.json', 'events.jsonl']) {
      parts.push(statMtime(path.join(rootPath, '.memory', f)));
    }
  }
  for (const f of KNOWN_MARKDOWN_FILES) {
    parts.push(statMtime(path.join(rootPath, f)));
  }
  if (hasGit) parts.push(statMtime(path.join(rootPath, '.git', 'HEAD')));
  return parts.join(':');
}

function hasNoContext(snapshot) {
  return snapshot.source_health.aum === 'none' && snapshot.source_health.docs === 'none' && snapshot.source_health.git === 'none';
}

export async function runIntelligence({ store, projects }) {
  let reused = 0;
  let recomputed = 0;
  let withoutSufficientContext = 0;
  const snapshotsByProjectId = new Map();

  for (const project of projects) {
    const fingerprint = computeIntelligenceFingerprint(project.root_path, project.has_git, project.has_aum);
    const existing = await store.getIntelligence(project.id);

    if (existing && existing.fingerprint === fingerprint) {
      reused += 1;
      snapshotsByProjectId.set(project.id, existing);
      if (hasNoContext(existing)) withoutSufficientContext += 1;
      continue;
    }

    const aum = project.has_aum ? analyzeAum(project.root_path) : { present: false };
    const markdown = analyzeMarkdown(project.root_path);
    const git = project.has_git ? await analyzeGit(project.root_path) : null;

    const snapshot = buildProjectIntelligenceSnapshot({ project, aum, markdown, git, fingerprint });
    await store.upsertIntelligence(snapshot);
    recomputed += 1;
    if (hasNoContext(snapshot)) withoutSufficientContext += 1;
    snapshotsByProjectId.set(project.id, snapshot);
  }

  const byFamily = new Map();
  for (const project of projects) {
    if (!project.project_family) continue;
    if (!byFamily.has(project.project_family)) byFamily.set(project.project_family, []);
    byFamily.get(project.project_family).push({ project, snapshot: snapshotsByProjectId.get(project.id) });
  }

  const rollups = [];
  for (const [familyKey, members] of byFamily.entries()) {
    const rollup = buildFamilyRollup(familyKey, members);
    await store.upsertFamilyRollup(rollup);
    rollups.push(rollup);
  }

  return { reused, recomputed, withoutSufficientContext, snapshotsByProjectId, rollups };
}
