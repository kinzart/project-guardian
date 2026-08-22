// Targeted single-project refresh for `guardian watch` (V0.3). Deliberately separate from
// src/discovery/scanner.js's full-walk loop: this never re-walks the filesystem or re-scores
// evidence — it only re-runs the same inspectors scanner.js already trusts (git/aum/markdown),
// reclassifies activity/completion, and recomputes intelligence when its own fingerprint
// changed. A brand new project still requires `guardian scan` (see SPEC_V0.3.md).

import { statSync } from 'node:fs';
import { inspectGit } from '../inspectors/gitInspector.js';
import { inspectAum } from '../inspectors/aumInspector.js';
import { inspectMarkdown } from '../inspectors/markdownInspector.js';
import { classify } from '../activity/classify.js';
import { analyzeAum } from '../intelligence/aumIntelligence.js';
import { analyzeMarkdown } from '../intelligence/markdownIntelligence.js';
import { analyzeGit } from '../intelligence/gitIntelligence.js';
import { buildProjectIntelligenceSnapshot } from '../intelligence/snapshot.js';
import { buildFamilyRollup } from '../intelligence/familyRollup.js';
import { computeIntelligenceFingerprint } from '../intelligence/runner.js';

export async function getFamilyMembers(store, projectFamily) {
  const all = await store.listProjects();
  return all.filter((p) => p.project_family === projectFamily);
}

// result: { project, intelligenceRecomputed, familyRollupUpdated, errors }
export async function refreshProject({ store, project, config, reason = 'ACTIVITY_ONLY', familyMembers = [], now = new Date() }) {
  const dirPath = project.root_path;
  const errors = [];

  let git = null;
  if (project.has_git) {
    try {
      git = await inspectGit(dirPath);
      if (git.errors?.length) errors.push(...git.errors.map((e) => `git: ${e}`));
    } catch (err) {
      errors.push(`git: ${err.message}`);
    }
  }

  let aum = null;
  if (project.has_aum) {
    try {
      aum = inspectAum(dirPath);
      if (aum.errors?.length) errors.push(...aum.errors.map((e) => `aum: ${e}`));
    } catch (err) {
      errors.push(`aum: ${err.message}`);
    }
  }

  let markdown = null;
  try {
    markdown = inspectMarkdown(dirPath);
  } catch (err) {
    errors.push(`markdown: ${err.message}`);
  }

  let rootMtimeIso = null;
  try {
    rootMtimeIso = statSync(dirPath).mtime.toISOString();
  } catch {
    // root may be transiently unavailable — handled by the watcher's root-missing tracking,
    // not here; a refresh just carries on with whatever it could read.
  }

  const activity = classify({ git, aum, markdown, rootMtimeIso }, config.activityThresholds, now.getTime());

  const updatedProject = {
    ...project,
    last_seen: now.toISOString(),
    last_git_activity: git?.lastCommitDate ?? project.last_git_activity,
    last_file_activity: rootMtimeIso ?? project.last_file_activity,
    activity_score_hours: activity.activityScoreHours,
    status: { activity_state: activity.activityState, completion_state: activity.completionState },
    status_confidence: { activity_evidence: activity.activityEvidence, completion_evidence: activity.completionEvidence },
    completion_detail: {
      source: activity.completionSource,
      evidence: activity.completionEvidence[0] || null,
      updated_at: activity.completionUpdatedAt,
    },
    errors,
  };
  await store.upsertProject(updatedProject);

  let intelligenceRecomputed = false;
  const fingerprint = computeIntelligenceFingerprint(dirPath, updatedProject.has_git, updatedProject.has_aum);
  const existingIntel = await store.getIntelligence(project.id);

  if (reason !== 'ACTIVITY_ONLY' && (!existingIntel || existingIntel.fingerprint !== fingerprint)) {
    const aumIntel = updatedProject.has_aum ? analyzeAum(dirPath) : { present: false };
    const mdIntel = analyzeMarkdown(dirPath);
    const gitIntel = updatedProject.has_git ? await analyzeGit(dirPath) : null;
    const snapshot = buildProjectIntelligenceSnapshot({ project: updatedProject, aum: aumIntel, markdown: mdIntel, git: gitIntel, fingerprint, now });
    await store.upsertIntelligence(snapshot);
    intelligenceRecomputed = true;
  }

  let familyRollupUpdated = false;
  if (updatedProject.project_family) {
    const members = familyMembers.length ? familyMembers : await getFamilyMembers(store, updatedProject.project_family);
    const memberList = members.map((m) => (m.id === updatedProject.id ? updatedProject : m));
    const withSnapshots = await Promise.all(
      memberList.map(async (m) => ({ project: m, snapshot: await store.getIntelligence(m.id) })),
    );
    const rollup = buildFamilyRollup(updatedProject.project_family, withSnapshots);
    await store.upsertFamilyRollup(rollup);
    familyRollupUpdated = true;
  }

  return { project: updatedProject, intelligenceRecomputed, familyRollupUpdated, errors };
}
