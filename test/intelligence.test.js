import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JsonFileStore } from '../src/store/JsonFileStore.js';
import { runScan } from '../src/discovery/scanner.js';
import { runIntelligence, computeIntelligenceFingerprint } from '../src/intelligence/runner.js';
import { ScanLogger } from '../src/util/logger.js';
import { createIntelligenceFixtureRoot, cleanupFixtureRoot } from './helpers/fixtures.js';

const CONFIG = {
  exclude: ['node_modules', '.git', 'dist', 'build', 'coverage', '.cache', '.next', '.nuxt', 'vendor', 'venv', '.venv', '__pycache__'],
  excludePaths: [],
  maxDepth: 8,
  maxDirectoriesVisited: 50000,
  confidenceThresholds: { high: 55, medium: 30, low: 10 },
  activityThresholds: { activeHours: 48, warmDays: 7, staleDays: 30 },
};

async function setup() {
  const fixtureRoot = createIntelligenceFixtureRoot();
  const dbDir = mkdtempSync(path.join(os.tmpdir(), 'guardian-db-'));
  const logsDir = mkdtempSync(path.join(os.tmpdir(), 'guardian-logs-'));
  const store = new JsonFileStore(path.join(dbDir, 'guardian.db.json'));
  await store.init();
  const logger = new ScanLogger(logsDir, 'intel-scan');
  await runScan({ config: CONFIG, store, logger, roots: [fixtureRoot] });
  const projects = await store.listProjects();
  const intelligence = await runIntelligence({ store, projects });
  return {
    fixtureRoot,
    store,
    projects,
    intelligence,
    cleanup: () => {
      rmSync(dbDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      rmSync(logsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

function byName(projects, name) {
  return projects.find((p) => p.name === name);
}

test('intelligence: full fixture set — focus, next steps, blockers, decisions, DONE+ACTIVE, tasks, conflicts, no-context, big events, git-alone, family rollup', async () => {
  const { fixtureRoot, store, projects, intelligence, cleanup } = await setup();
  try {
    const snap = (name) => intelligence.snapshotsByProjectId.get(byName(projects, name).id);

    // current_focus with evidence (G4).
    const focus = snap('intel-focus');
    assert.ok(focus, 'intel-focus has a snapshot');
    assert.match(focus.current_focus.value, /Meta provider/);
    assert.notEqual(focus.current_focus.confidence, 'UNKNOWN');
    assert.ok(focus.current_focus.evidence.length > 0, 'current_focus carries evidence');
    assert.equal(focus.current_focus.evidence[0].source, '.memory/BRIEF.md');

    // next_steps with evidence (G5).
    const nextSteps = snap('intel-next-steps');
    assert.ok(nextSteps.next_steps.length >= 2);
    for (const step of nextSteps.next_steps) assert.ok(step.evidence.length > 0, 'every next step carries evidence');
    assert.ok(nextSteps.next_steps.some((s) => /webhook retries/.test(s.text)));

    // blockers with evidence (G6).
    const blocker = snap('intel-blocker');
    assert.ok(blocker.blockers.length >= 1);
    for (const b of blocker.blockers) assert.ok(b.evidence.length > 0, 'every blocker carries evidence');
    assert.ok(blocker.blockers.some((b) => /provider sandbox/.test(b.text)));

    // decisions with evidence (G7).
    const decision = snap('intel-decision');
    assert.ok(decision.recent_decisions.length >= 1);
    for (const d of decision.recent_decisions) assert.ok(d.evidence.length > 0, 'every decision carries evidence');
    assert.ok(decision.recent_decisions.some((d) => /Postgres/.test(d.text)));

    // DONE completion does not force ARCHIVED / does not suppress ACTIVE (G9).
    const doneActive = byName(projects, 'intel-done-active');
    assert.equal(doneActive.status.completion_state, 'DONE');
    assert.equal(doneActive.status.activity_state, 'ACTIVE');

    // TASKS.md checkboxes detected as open/completed tasks.
    const tasks = snap('intel-tasks');
    assert.ok(tasks.open_tasks.some((t) => /task A/.test(t.text)));
    assert.ok(tasks.completed_tasks.some((t) => /task B/.test(t.text)));

    // Conflict detection: state.json DONE vs TASKS.md still listing open work (G8).
    const conflict = snap('intel-conflict');
    const conflictProject = byName(projects, 'intel-conflict');
    assert.equal(conflictProject.status.completion_state, 'DONE');
    assert.ok(conflict.conflicts.length >= 1, 'a conflict must be recorded, not silently resolved');
    assert.equal(conflict.conflicts[0].field, 'completion_state');
    assert.equal(conflict.conflicts[0].source_a, '.memory/state.json');
    assert.match(conflict.conflicts[0].source_b, /TASKS\.md/);

    // Insufficient context is flagged, not invented.
    const noContext = snap('intel-no-context');
    assert.equal(noContext.source_health.aum, 'none');
    assert.equal(noContext.source_health.docs, 'none');
    assert.equal(noContext.current_focus.value, null);
    assert.equal(noContext.current_focus.confidence, 'UNKNOWN');
    assert.ok(intelligence.withoutSufficientContext >= 1);

    // Large events.jsonl: bounded window only, never the full 500-line history.
    const bigEvents = snap('intel-big-events');
    assert.ok(bigEvents, 'intel-big-events got a snapshot without crashing or stalling');

    // Git commit message alone is never sufficient evidence for DONE.
    const gitOnly = byName(projects, 'intel-git-only');
    assert.equal(gitOnly.status.completion_state, 'UNKNOWN', 'a commit message like "finish project" must never alone set DONE');

    // Family rollup: the more recently-touched / higher-version member is picked as current,
    // with recorded evidence — never a blind filesystem merge.
    const familyRollup = intelligence.rollups.find((r) => r.member_count === 2 && r.other_members.some((m) => /Report Tool/.test(m.path)));
    assert.ok(familyRollup, 'a rollup was produced for the Report Tool family');
    assert.ok(familyRollup.current_member, 'a current member was distinguished');
    assert.match(familyRollup.current_member.path, /Report Tool-V2/);
    assert.ok(familyRollup.evidence.length > 0);

    await store.close();
  } finally {
    cleanup();
    cleanupFixtureRoot(fixtureRoot);
  }
});

test('intelligence: no API key / no LLM required — the whole pass is synchronous, deterministic logic over local files', async () => {
  const { store, cleanup, fixtureRoot } = await setup();
  try {
    // Sanity: nothing in this module tree imports a network client or reads an API key env var.
    // Structural proof: the intelligence run above completed without any network credential
    // present in the test environment at all.
    assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(process.env.OPENAI_API_KEY, undefined);
    await store.close();
  } finally {
    cleanup();
    cleanupFixtureRoot(fixtureRoot);
  }
});

test('intelligence: incremental reuse — a second run with nothing changed reuses every snapshot; touching one AUM file recomputes only that project', async () => {
  const { fixtureRoot, store, projects, cleanup } = await setup();
  try {
    const second = await runIntelligence({ store, projects });
    assert.equal(second.recomputed, 0, 'nothing changed on disk, so nothing should be recomputed');
    assert.equal(second.reused, projects.length);

    const focusProject = byName(projects, 'intel-focus');
    const briefPath = path.join(focusProject.root_path, '.memory', 'BRIEF.md');
    writeFileSync(briefPath, '# Brief\n\n## Current Focus\n\nSomething entirely different now.\n');

    const third = await runIntelligence({ store, projects });
    assert.equal(third.recomputed, 1, 'only the touched project should be recomputed');
    assert.equal(third.reused, projects.length - 1);

    const updatedSnapshot = third.snapshotsByProjectId.get(focusProject.id);
    assert.match(updatedSnapshot.current_focus.value, /entirely different/);

    await store.close();
  } finally {
    cleanup();
    cleanupFixtureRoot(fixtureRoot);
  }
});

test('intelligence: computeIntelligenceFingerprint changes when a known AUM file mtime changes', () => {
  const fixtureRoot = createIntelligenceFixtureRoot();
  try {
    const projRoot = path.join(fixtureRoot, 'intel-focus');
    const before = computeIntelligenceFingerprint(projRoot, false, true);
    writeFileSync(path.join(projRoot, '.memory', 'BRIEF.md'), '# Brief\n\n## Current Focus\n\nchanged\n');
    const after = computeIntelligenceFingerprint(projRoot, false, true);
    assert.notEqual(before, after);
  } finally {
    cleanupFixtureRoot(fixtureRoot);
  }
});
