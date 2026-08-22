// Thin evidence-shaping wrapper around the stable, read-only gitInspector. Never used alone to
// determine completion_state — see SPEC_V0.2.md "Git context" and the caution comment on
// lastCommitMessage in src/inspectors/gitInspector.js.

import { inspectGit } from '../inspectors/gitInspector.js';

export async function analyzeGit(projectRoot) {
  const git = await inspectGit(projectRoot);
  return {
    branch: git.branch,
    lastCommit: git.lastCommitHash
      ? { hash: git.lastCommitHash, date: git.lastCommitDate, message: git.lastCommitMessage || null }
      : null,
    dirty: git.dirty,
    modifiedFiles: git.modifiedFiles,
    recentCommitCount: git.recentCommitCount,
    errors: git.errors,
  };
}
