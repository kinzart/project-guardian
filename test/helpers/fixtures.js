import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

function write(root, relPath, content) {
  const full = path.join(root, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function gitInit(dir) {
  const opts = { cwd: dir, stdio: 'ignore' };
  execFileSync('git', ['init', '-q'], opts);
  execFileSync('git', ['config', 'user.email', 'fixture@example.com'], opts);
  execFileSync('git', ['config', 'user.name', 'Fixture Bot'], opts);
  execFileSync('git', ['add', '-A'], opts);
  execFileSync('git', ['commit', '-q', '-m', 'fixture init'], opts);
}

export function createFixtureRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'guardian-fixtures-'));

  // fixture-aum-git: strong .git + .memory evidence, should be HIGH confidence.
  const aumGit = path.join(root, 'fixture-aum-git');
  write(aumGit, 'README.md', '# Aum Git Fixture\n\nStatus: In Progress\n');
  write(aumGit, '.memory/BRIEF.md', '# Brief\n\nStatus: In Progress\n');
  write(aumGit, '.memory/handoff.md', '# Handoff\n\nNext steps here.\n');
  write(aumGit, '.memory/state.json', JSON.stringify({ status: 'in-progress', updated_at: new Date().toISOString() }));
  write(
    aumGit,
    '.memory/events.jsonl',
    `${JSON.stringify({ timestamp: new Date(Date.now() - 3600_000).toISOString(), event: 'edit' })}\n`,
  );
  write(aumGit, 'package.json', JSON.stringify({ name: 'aum-git-fixture', version: '1.0.0' }));
  gitInit(aumGit);

  // fixture-node-no-aum: package.json + README + src, no .memory, no .git.
  const nodeNoAum = path.join(root, 'fixture-node-no-aum');
  write(nodeNoAum, 'package.json', JSON.stringify({ name: 'node-no-aum-fixture' }));
  write(nodeNoAum, 'README.md', '# Node No AUM\n');
  write(nodeNoAum, 'src/index.js', 'export const x = 1;\n');

  // fixture-python: pyproject.toml + README + tests/.
  const pyFixture = path.join(root, 'fixture-python');
  write(pyFixture, 'pyproject.toml', '[project]\nname = "python-fixture"\n');
  write(pyFixture, 'README.md', '# Python Fixture\n');
  write(pyFixture, 'tests/test_basic.py', 'def test_ok():\n    assert True\n');

  // fixture-docs-only: a single lone README.md — must NOT be classified as a project.
  const docsOnly = path.join(root, 'fixture-docs-only');
  write(docsOnly, 'README.md', '# Just docs\n\nNothing else here.\n');

  // fixture-secret-files: real project evidence PLUS secret-shaped files that must never be
  // read or persisted.
  const secretFiles = path.join(root, 'fixture-secret-files');
  write(secretFiles, 'package.json', JSON.stringify({ name: 'secret-fixture' }));
  write(secretFiles, 'README.md', '# Secret Fixture\n');
  write(secretFiles, '.env', 'API_KEY=super-secret-value\n');
  write(secretFiles, '.env.local', 'DB_PASSWORD=another-secret\n');
  write(secretFiles, 'credentials.json', '{"token":"should-never-be-read"}');
  write(secretFiles, 'secrets.yaml', 'password: should-never-be-read\n');
  write(secretFiles, 'id_rsa', '-----BEGIN OPENSSH PRIVATE KEY-----\nFAKEFAKEFAKE\n-----END OPENSSH PRIVATE KEY-----\n');

  // fixture-huge-node-modules: real project evidence with a large node_modules tree that must
  // never be walked into.
  const hugeNm = path.join(root, 'fixture-huge-node-modules');
  write(hugeNm, 'package.json', JSON.stringify({ name: 'huge-nm-fixture' }));
  write(hugeNm, 'README.md', '# Huge node_modules fixture\n');
  for (let i = 0; i < 300; i += 1) {
    write(hugeNm, `node_modules/pkg-${i}/index.js`, `module.exports = ${i};\n`);
    write(hugeNm, `node_modules/pkg-${i}/package.json`, JSON.stringify({ name: `pkg-${i}` }));
  }

  // fixture-corrupt-memory: .memory present but state.json/events.jsonl are malformed. Scanner
  // must not crash and must still list the project with reduced confidence info.
  const corruptMemory = path.join(root, 'fixture-corrupt-memory');
  write(corruptMemory, 'README.md', '# Corrupt Memory Fixture\n');
  write(corruptMemory, '.memory/BRIEF.md', '# Brief\n');
  write(corruptMemory, '.memory/state.json', '{ this is not valid json ');
  write(corruptMemory, '.memory/events.jsonl', 'not-json-at-all\nneither is this\n');

  return root;
}

export function cleanupFixtureRoot(root) {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

// Separate fixture tree for V0.1.1 inventory-hygiene scenarios (tooling noise, project
// families/duplicates, nested-output-only candidates). Kept apart from createFixtureRoot() so
// existing V0.1 assertions (exact-ish project counts, name lookups) stay unaffected.
export function createHygieneFixtureRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'guardian-hygiene-'));

  // Editor/tooling noise that must never be classified as a personal project.
  write(
    path.join(root, 'tooling-noise'),
    '.vscode/extensions/publisher.some-ext-1.0.0/package.json',
    JSON.stringify({ name: 'some-ext', version: '1.0.0' }),
  );
  write(path.join(root, 'tooling-noise'), '.vscode/extensions/publisher.some-ext-1.0.0/README.md', '# Some Ext\n');
  write(
    path.join(root, 'tooling-noise'),
    '.npm/_cacache/content-v2/aa/bb/package.json',
    JSON.stringify({ name: 'npm-cache-entry' }),
  );

  // A real project ("legit-tool") sitting next to the noise, to prove exclusions aren't overly
  // broad (it must still be detected).
  const legitTool = path.join(root, 'legit-tool');
  write(legitTool, 'package.json', JSON.stringify({ name: 'legit-tool' }));
  write(legitTool, 'README.md', '# Legit Tool\n');
  write(legitTool, 'src/index.js', 'export const x = 1;\n');

  // Project family: four locations sharing the same declared name, one of them the "real"
  // canonical copy (has .git), the others output/workspace/version-shaped duplicates.
  const familyRoot = path.join(root, 'family');
  const canonical = path.join(familyRoot, 'canonical', 'Widget App');
  write(canonical, 'package.json', JSON.stringify({ name: 'Widget App' }));
  write(canonical, 'README.md', '# Widget App\n');
  gitInit(canonical);

  const outputCopy = path.join(familyRoot, 'outputs', 'Widget App');
  write(outputCopy, 'package.json', JSON.stringify({ name: 'Widget App' }));
  write(outputCopy, 'README.md', '# Widget App (output)\n');

  const versionCopy = path.join(familyRoot, 'outputs', 'Widget App-V2');
  write(versionCopy, 'package.json', JSON.stringify({ name: 'Widget App' }));
  write(versionCopy, 'README.md', '# Widget App v2\n');

  const workspaceCopy = path.join(familyRoot, 'work', 'Widget App');
  write(workspaceCopy, 'package.json', JSON.stringify({ name: 'Widget App' }));
  write(workspaceCopy, 'README.md', '# Widget App (wip)\n');

  // Nested-root suppression case: the outer directory itself has only weak secondary evidence
  // (a lone README), so the walker keeps descending, and a generated-output subfolder with just
  // a package.json must not be silently promoted to a fully independent project.
  const nestedOuter = path.join(root, 'nested-output-only');
  write(nestedOuter, 'README.md', '# Nested Output Only\n\nJust a container folder.\n');
  const nestedInner = path.join(nestedOuter, 'outputs', 'generated-thing');
  write(nestedInner, 'package.json', JSON.stringify({ name: 'generated-thing' }));

  return root;
}

// Fixture tree for V0.2 project-intelligence scenarios. Entirely synthetic — never uses real
// user projects, per spec instruction.
export function createIntelligenceFixtureRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'guardian-intel-'));

  // intel-focus: BRIEF.md declares current focus under an explicit heading.
  const focusProj = path.join(root, 'intel-focus');
  write(focusProj, 'package.json', JSON.stringify({ name: 'intel-focus' }));
  write(focusProj, '.memory/BRIEF.md', '# Brief\n\n## Current Focus\n\nValidate the real send-out through the Meta provider.\n');

  // intel-next-steps: handoff.md lists explicit pending work.
  const nextStepsProj = path.join(root, 'intel-next-steps');
  write(nextStepsProj, 'package.json', JSON.stringify({ name: 'intel-next-steps' }));
  write(nextStepsProj, '.memory/BRIEF.md', '# Brief\n');
  write(nextStepsProj, '.memory/handoff.md', '# Handoff\n\n## Pending\n\n- [ ] Wire up webhook retries\n- [ ] Add rate limiting\n');

  // intel-blocker: BRIEF.md declares an explicit blocker.
  const blockerProj = path.join(root, 'intel-blocker');
  write(blockerProj, 'package.json', JSON.stringify({ name: 'intel-blocker' }));
  write(blockerProj, '.memory/BRIEF.md', '# Brief\n\n## Blockers\n\nBLOCKED: aguardando acesso to the provider sandbox\n');

  // intel-decision: BRIEF.md records an explicit decision.
  const decisionProj = path.join(root, 'intel-decision');
  write(decisionProj, 'package.json', JSON.stringify({ name: 'intel-decision' }));
  write(decisionProj, '.memory/BRIEF.md', '# Brief\n\n## Decisions\n\nDecision: usar Postgres em vez de SQLite\n');

  // intel-done-active: completion DONE (state.json) while activity is ACTIVE (fresh git
  // commit) — proves DONE never forces ARCHIVED / never suppresses ACTIVE.
  const doneActiveProj = path.join(root, 'intel-done-active');
  write(doneActiveProj, 'package.json', JSON.stringify({ name: 'intel-done-active' }));
  write(doneActiveProj, '.memory/state.json', JSON.stringify({ status: 'done', updated_at: new Date().toISOString() }));
  write(doneActiveProj, 'README.md', '# Done Active Fixture\n');
  gitInit(doneActiveProj);

  // intel-tasks: TASKS.md with a mix of open/done checkboxes.
  const tasksProj = path.join(root, 'intel-tasks');
  write(tasksProj, 'package.json', JSON.stringify({ name: 'intel-tasks' }));
  write(tasksProj, 'TASKS.md', '# Tasks\n\n- [ ] task A\n- [x] task B\n');

  // intel-conflict: state.json says done, TASKS.md still lists open work — must surface as a
  // conflict, not be silently resolved.
  const conflictProj = path.join(root, 'intel-conflict');
  write(conflictProj, 'package.json', JSON.stringify({ name: 'intel-conflict' }));
  write(conflictProj, '.memory/state.json', JSON.stringify({ status: 'done', updated_at: new Date().toISOString() }));
  write(conflictProj, 'TASKS.md', '# Tasks\n\n- [ ] core implementation pending\n');

  // intel-no-context: strong discovery evidence (package.json) but nothing intelligence can
  // read from (no AUM, no docs, no git) — must be flagged "without sufficient context".
  const noContextProj = path.join(root, 'intel-no-context');
  write(noContextProj, 'package.json', JSON.stringify({ name: 'intel-no-context' }));
  write(noContextProj, 'src/index.js', 'export const x = 1;\n');

  // intel-big-events: events.jsonl with many lines — intelligence must only look at a bounded
  // recent window, never load/parse the whole history.
  const bigEventsProj = path.join(root, 'intel-big-events');
  write(bigEventsProj, 'package.json', JSON.stringify({ name: 'intel-big-events' }));
  const eventLines = [];
  for (let i = 0; i < 500; i += 1) {
    eventLines.push(JSON.stringify({ timestamp: new Date(Date.now() - (500 - i) * 1000).toISOString(), event: 'edit', message: `edit number ${i}` }));
  }
  write(bigEventsProj, '.memory/events.jsonl', `${eventLines.join('\n')}\n`);
  write(bigEventsProj, '.memory/BRIEF.md', '# Brief\n');

  // intel-git-only: a real git commit with a tempting message ("finish project") but no
  // explicit AUM/markdown status — completion_state must stay UNKNOWN, never inferred from the
  // commit message alone.
  const gitOnlyProj = path.join(root, 'intel-git-only');
  write(gitOnlyProj, 'package.json', JSON.stringify({ name: 'intel-git-only' }));
  write(gitOnlyProj, 'README.md', '# Git Only Fixture\n');
  const gitOnlyOpts = { cwd: gitOnlyProj, stdio: 'ignore' };
  mkdirSync(gitOnlyProj, { recursive: true });
  execFileSync('git', ['init', '-q'], gitOnlyOpts);
  execFileSync('git', ['config', 'user.email', 'fixture@example.com'], gitOnlyOpts);
  execFileSync('git', ['config', 'user.name', 'Fixture Bot'], gitOnlyOpts);
  execFileSync('git', ['add', '-A'], gitOnlyOpts);
  execFileSync('git', ['commit', '-q', '-m', 'finish project'], gitOnlyOpts);

  // intel-family: two members sharing a name, one clearly more recently active than the other
  // — the rollup must be able to say which one "appears to be the active variant".
  const familyOld = path.join(root, 'intel-family-outputs', 'Report Tool');
  write(familyOld, 'package.json', JSON.stringify({ name: 'Report Tool' }));
  write(familyOld, 'README.md', '# Report Tool (old copy)\n');
  const familyActive = path.join(root, 'intel-family-outputs', 'Report Tool-V2');
  write(familyActive, 'package.json', JSON.stringify({ name: 'Report Tool' }));
  write(familyActive, 'README.md', '# Report Tool v2\n');
  // Touch the V2 copy last so it is unambiguously the more recently active member.
  writeFileSync(path.join(familyActive, 'README.md'), '# Report Tool v2 (touched)\n');

  return root;
}

// Fixture tree for V0.3 filesystem-watcher scenarios. Entirely synthetic — never a real user
// project. Returns { root, projectA, projectB, projectSecret, familyCanonical, familyOutput,
// ephemeral }.
export function createWatchFixtureRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'guardian-watch-'));

  const projectA = path.join(root, 'watch-project-a');
  write(projectA, 'package.json', JSON.stringify({ name: 'watch-project-a' }));
  write(projectA, 'README.md', '# Watch Project A\n');
  write(projectA, 'src/index.js', 'export const x = 1;\n');
  write(projectA, '.memory/BRIEF.md', '# Brief\n');
  write(projectA, '.memory/handoff.md', '# Handoff\n\n## Last Summary\n\nInitial state.\n');
  write(projectA, '.memory/state.json', JSON.stringify({ status: 'in-progress', updated_at: new Date().toISOString() }));
  gitInit(projectA);

  const projectB = path.join(root, 'watch-project-b');
  write(projectB, 'package.json', JSON.stringify({ name: 'watch-project-b' }));
  write(projectB, 'README.md', '# Watch Project B\n');
  write(projectB, 'src/app.js', 'export const y = 2;\n');

  const projectSecret = path.join(root, 'watch-project-secret');
  write(projectSecret, 'package.json', JSON.stringify({ name: 'watch-project-secret' }));
  write(projectSecret, 'README.md', '# Watch Project Secret\n');
  write(projectSecret, '.env', 'API_KEY=should-never-be-read\n');

  const familyCanonical = path.join(root, 'watch-family-canonical', 'Report Tool');
  write(familyCanonical, 'package.json', JSON.stringify({ name: 'Report Tool' }));
  write(familyCanonical, 'README.md', '# Report Tool canonical\n');
  gitInit(familyCanonical);

  const familyOutput = path.join(root, 'watch-family-outputs', 'Report Tool');
  write(familyOutput, 'package.json', JSON.stringify({ name: 'Report Tool' }));
  write(familyOutput, 'README.md', '# Report Tool output copy\n');

  const ephemeral = path.join(root, 'watch-project-ephemeral');
  write(ephemeral, 'package.json', JSON.stringify({ name: 'watch-project-ephemeral' }));
  write(ephemeral, 'README.md', '# Ephemeral\n');

  return { root, projectA, projectB, projectSecret, familyCanonical, familyOutput, ephemeral };
}
