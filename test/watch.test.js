import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JsonFileStore } from '../src/store/JsonFileStore.js';
import { runScan } from '../src/discovery/scanner.js';
import { ScanLogger } from '../src/util/logger.js';
import { Watcher } from '../src/watch/watcher.js';
import { createWatchFixtureRoot, cleanupFixtureRoot } from './helpers/fixtures.js';

const BASE_CONFIG = {
  exclude: ['node_modules', '.git', 'dist', 'build', 'coverage', '.cache', '.next', '.nuxt', 'vendor', 'venv', '.venv', '__pycache__'],
  excludePaths: [],
  maxDepth: 8,
  maxDirectoriesVisited: 50000,
  confidenceThresholds: { high: 55, medium: 30, low: 10 },
  activityThresholds: { activeHours: 48, warmDays: 7, staleDays: 30 },
  watch: { debounceMs: 120, settleMs: 1500 },
};

async function waitFor(conditionFn, { timeout = 4000, interval = 50 } = {}) {
  const start = Date.now();
  for (;;) {
    const result = await conditionFn();
    if (result) return result;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, interval));
  }
}

async function setup(extraConfig = {}) {
  const fixture = createWatchFixtureRoot();
  const dbDir = mkdtempSync(path.join(os.tmpdir(), 'guardian-watch-db-'));
  const logsDir = mkdtempSync(path.join(os.tmpdir(), 'guardian-watch-logs-'));
  const reportsDir = mkdtempSync(path.join(os.tmpdir(), 'guardian-watch-reports-'));
  const store = new JsonFileStore(path.join(dbDir, 'guardian.db.json'));
  await store.init();
  const logger = new ScanLogger(logsDir, 'watch-setup-scan');
  await runScan({ config: BASE_CONFIG, store, logger, roots: [fixture.root] });

  const config = { ...BASE_CONFIG, ...extraConfig, watch: { ...BASE_CONFIG.watch, ...(extraConfig.watch || {}) } };
  const guardianSelfPaths = [path.join(fixture.root, '__guardian_data__'), path.join(fixture.root, '__guardian_reports__'), path.join(fixture.root, '__guardian_logs__')];

  return {
    fixture,
    store,
    config,
    reportsDir,
    guardianSelfPaths,
    cleanup: () => {
      rmSync(dbDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      rmSync(logsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      rmSync(reportsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      try { cleanupFixtureRoot(fixture.root); } catch (err) { if (err?.code !== 'EBUSY') throw err; }
    },
  };
}

function byName(projects, name) {
  return projects.find((p) => p.name === name);
}

test('watch: a plain code change refreshes activity but does not recompute intelligence', async () => {
  const { fixture, store, config, reportsDir, guardianSelfPaths, cleanup } = await setup();
  try {
    const watcher = new Watcher({ store, config, reportsDir, guardianSelfPaths });
    const projects = await store.listProjects();
    await watcher.start(projects);

    writeFileSync(path.join(fixture.projectB, 'src', 'app.js'), 'export const y = 3;\n');

    await waitFor(() => watcher.stats.refreshes >= 1);
    await watcher.stop();

    assert.equal(watcher.stats.intelligenceRecomputed, 0, 'a code-only change must not recompute intelligence');
    const events = await store.listWatchEvents({});
    const projectSourceChanged = events.filter((e) => e.event_type === 'PROJECT_SOURCE_CHANGED');
    assert.ok(projectSourceChanged.length >= 1);
    assert.equal(projectSourceChanged[0].intelligence_recomputed, false);
  } finally {
    cleanup();
  }
});

test('watch: an AUM handoff change triggers a targeted intelligence recompute', async () => {
  const { fixture, store, config, reportsDir, guardianSelfPaths, cleanup } = await setup();
  try {
    const watcher = new Watcher({ store, config, reportsDir, guardianSelfPaths });
    const projects = await store.listProjects();
    await watcher.start(projects);

    writeFileSync(path.join(fixture.projectA, '.memory', 'handoff.md'), '# Handoff\n\n## Last Summary\n\nSwitched providers.\n');

    await waitFor(() => watcher.stats.intelligenceRecomputed >= 1);
    await watcher.stop();

    const projectA = byName(await store.listProjects(), 'watch-project-a');
    const snapshot = await store.getIntelligence(projectA.id);
    assert.match(snapshot.current_focus.value || '', /Switched providers/);
  } finally {
    cleanup();
  }
});

test('watch: debounce + coalescing — several files touched within the window produce exactly one refresh', async () => {
  const { fixture, store, config, reportsDir, guardianSelfPaths, cleanup } = await setup();
  try {
    const watcher = new Watcher({ store, config, reportsDir, guardianSelfPaths });
    const projects = await store.listProjects();
    await watcher.start(projects);

    writeFileSync(path.join(fixture.projectA, 'README.md'), '# Watch Project A (edited)\n');
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(path.join(fixture.projectA, 'src', 'index.js'), 'export const x = 2;\n');

    await waitFor(() => watcher.stats.refreshes >= 1);
    await new Promise((r) => setTimeout(r, 300)); // make sure a second, unwanted flush doesn't sneak in
    await watcher.stop();

    assert.equal(watcher.stats.refreshes, 1, 'two files touched within the debounce window must coalesce into one refresh');

    const events = await store.listWatchEvents({});
    const changed = events.find((e) => e.event_type === 'PROJECT_SOURCE_CHANGED');
    assert.ok(changed.paths.length >= 2, 'the coalesced event lists every changed path');
    assert.ok(changed.raw_event_count >= changed.paths.length);
  } finally {
    cleanup();
  }
});

test('watch: atomic save (temp file + rename) is treated as one change to the real file', async () => {
  const { fixture, store, config, reportsDir, guardianSelfPaths, cleanup } = await setup();
  try {
    const watcher = new Watcher({ store, config, reportsDir, guardianSelfPaths });
    const projects = await store.listProjects();
    await watcher.start(projects);

    const target = path.join(fixture.projectA, '.memory', 'handoff.md');
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, '# Handoff\n\n## Last Summary\n\nAtomic save test.\n');
    renameSync(tmp, target);

    await waitFor(() => watcher.stats.refreshes >= 1);
    await new Promise((r) => setTimeout(r, 300));
    await watcher.stop();

    assert.equal(watcher.stats.refreshes, 1, 'an atomic save must not appear as separate delete+create refreshes');
    const events = await store.listWatchEvents({});
    const changed = events.find((e) => e.event_type === 'PROJECT_SOURCE_CHANGED');
    assert.ok(!changed.paths.some((p) => p.endsWith('.tmp')), 'the temp filename must never appear in the persisted event');
  } finally {
    cleanup();
  }
});

test('watch: node_modules and swap-file changes never trigger a refresh', async () => {
  const { fixture, store, config, reportsDir, guardianSelfPaths, cleanup } = await setup();
  try {
    const watcher = new Watcher({ store, config, reportsDir, guardianSelfPaths });
    const projects = await store.listProjects();
    await watcher.start(projects);

    mkdirSync(path.join(fixture.projectB, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(path.join(fixture.projectB, 'node_modules', 'pkg', 'index.js'), 'module.exports = {};\n');
    writeFileSync(path.join(fixture.projectB, 'README.md.swp'), 'swap\n');

    await new Promise((r) => setTimeout(r, 800));
    await watcher.stop();

    assert.equal(watcher.stats.refreshes, 0, 'node_modules/.swp changes must never reach a refresh');
  } finally {
    cleanup();
  }
});

test('watch: Guardian\'s own self paths never trigger a refresh (no self-loop)', async () => {
  const { fixture, store, config, reportsDir, guardianSelfPaths, cleanup } = await setup();
  try {
    const watcher = new Watcher({ store, config, reportsDir, guardianSelfPaths });
    const projects = await store.listProjects();
    await watcher.start(projects);

    mkdirSync(guardianSelfPaths[0], { recursive: true });
    writeFileSync(path.join(guardianSelfPaths[0], 'guardian.db.json'), '{}');

    await new Promise((r) => setTimeout(r, 800));
    await watcher.stop();

    assert.equal(watcher.stats.eventsReceived >= 0, true);
    assert.equal(watcher.stats.refreshes, 0, "Guardian's own data/reports/logs writes must never self-trigger a refresh");
  } finally {
    cleanup();
  }
});

test('watch: a change in project A never touches project B', async () => {
  const { fixture, store, config, reportsDir, guardianSelfPaths, cleanup } = await setup();
  try {
    const watcher = new Watcher({ store, config, reportsDir, guardianSelfPaths });
    const projects = await store.listProjects();
    const bBefore = byName(projects, 'watch-project-b');

    await watcher.start(projects);
    writeFileSync(path.join(fixture.projectA, 'src', 'index.js'), 'export const x = 99;\n');
    await waitFor(() => watcher.stats.refreshes >= 1);
    await new Promise((r) => setTimeout(r, 300));
    await watcher.stop();

    assert.equal(watcher.stats.refreshes, 1);
    const bAfter = byName(await store.listProjects(), 'watch-project-b');
    assert.equal(bAfter.last_seen, bBefore.last_seen, "project B's last_seen must be untouched by project A's change");
  } finally {
    cleanup();
  }
});

test('watch: a family member update refreshes the rollup without re-analyzing the sibling', async () => {
  const { fixture, store, config, reportsDir, guardianSelfPaths, cleanup } = await setup();
  try {
    const projectsBefore = await store.listProjects();
    const output = byName(projectsBefore, 'Report Tool');
    assert.ok(output?.project_family, 'sanity: the two Report Tool copies formed a family');
    const family = output.project_family;
    const canonicalBefore = projectsBefore.find((p) => p.project_family === family && p.is_canonical);
    const canonicalLastSeenBefore = canonicalBefore.last_seen;

    const watcher = new Watcher({ store, config, reportsDir, guardianSelfPaths });
    await watcher.start(projectsBefore);

    writeFileSync(path.join(fixture.familyOutput, 'README.md'), '# Report Tool output copy (touched)\n');
    await waitFor(() => watcher.stats.refreshes >= 1);
    await new Promise((r) => setTimeout(r, 300));
    await watcher.stop();

    const rollup = await store.getFamilyRollup(family);
    assert.ok(rollup, 'family rollup was refreshed');

    const projectsAfter = await store.listProjects();
    const canonicalAfter = projectsAfter.find((p) => p.project_family === family && p.is_canonical);
    assert.equal(canonicalAfter.last_seen, canonicalLastSeenBefore, "the sibling (canonical) member's last_seen must be untouched");
  } finally {
    cleanup();
  }
});

test('watch: a protected (.env-shaped) change never triggers a refresh and never appears by name', async () => {
  const { fixture, store, config, reportsDir, guardianSelfPaths, cleanup } = await setup();
  try {
    const watcher = new Watcher({ store, config, reportsDir, guardianSelfPaths });
    const projects = await store.listProjects();
    await watcher.start(projects);

    writeFileSync(path.join(fixture.projectSecret, '.env'), 'API_KEY=changed-should-never-be-read\n');

    await waitFor(async () => (await store.listWatchEvents({})).some((e) => e.event_type === 'PROTECTED_SOURCE_CHANGED'));
    await new Promise((r) => setTimeout(r, 300));
    await watcher.stop();

    assert.equal(watcher.stats.refreshes, 0, 'a protected file change must never trigger a project refresh');

    const events = await store.listWatchEvents({});
    const dump = JSON.stringify(events);
    assert.doesNotMatch(dump, /\.env/);
    assert.doesNotMatch(dump, /changed-should-never-be-read/);

    const protectedEvent = events.find((e) => e.event_type === 'PROTECTED_SOURCE_CHANGED');
    assert.ok(protectedEvent);
    assert.deepEqual(protectedEvent.paths, []);
  } finally {
    cleanup();
  }
});

test('watch: failure isolation — a missing root is marked MISSING/DEGRADED, other roots keep working, root can come back', async () => {
  const { fixture, store, config, reportsDir, guardianSelfPaths, cleanup } = await setup();
  try {
    const watcher = new Watcher({ store, config, reportsDir, guardianSelfPaths, rootCheckMs: 150 });
    const projects = await store.listProjects();
    await watcher.start(projects);

    rmSync(fixture.ephemeral, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

    await waitFor(() => watcher.health().status === 'DEGRADED');
    const health1 = watcher.health();
    const ephemeralProject = byName(projects, 'watch-project-ephemeral');
    assert.equal(health1.rootStatus[ephemeralProject.root_path], 'MISSING');

    // The other roots must keep working while one is missing.
    writeFileSync(path.join(fixture.projectA, 'src', 'index.js'), 'export const x = 123;\n');
    await waitFor(() => watcher.stats.refreshes >= 1);

    const events1 = await store.listWatchEvents({});
    assert.ok(events1.some((e) => e.event_type === 'PROJECT_ROOT_MISSING'));

    // Root comes back.
    mkdirSync(fixture.ephemeral, { recursive: true });
    writeFileSync(path.join(fixture.ephemeral, 'package.json'), JSON.stringify({ name: 'watch-project-ephemeral' }));
    writeFileSync(path.join(fixture.ephemeral, 'README.md'), '# Ephemeral (back)\n');

    await waitFor(() => watcher.health().rootStatus[ephemeralProject.root_path] === 'OK');
    const events2 = await store.listWatchEvents({});
    assert.ok(events2.some((e) => e.event_type === 'PROJECT_ROOT_AVAILABLE'));

    await watcher.stop();
    // Windows can take a moment to fully release fs.watch's underlying handles after close();
    // give it a beat before the fixture cleanup below tries to rmdir the same tree.
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    cleanup();
  }
});

test('watch: graceful stop records a STOPPED session, and the watcher can be restarted', async () => {
  const { store, config, reportsDir, guardianSelfPaths, cleanup } = await setup();
  try {
    const projects = await store.listProjects();
    const watcher1 = new Watcher({ store, config, reportsDir, guardianSelfPaths });
    const sessionId1 = await watcher1.start(projects);
    await watcher1.stop();

    const session1 = await store.getWatchSession(sessionId1);
    assert.equal(session1.status, 'STOPPED');
    assert.ok(session1.stopped_at);

    const watcher2 = new Watcher({ store, config, reportsDir, guardianSelfPaths });
    const sessionId2 = await watcher2.start(projects);
    assert.notEqual(sessionId2, sessionId1);
    await watcher2.stop();

    const session2 = await store.getWatchSession(sessionId2);
    assert.equal(session2.status, 'STOPPED');

    const latest = await store.getLatestWatchSession();
    assert.equal(latest.session_id, sessionId2);
  } finally {
    cleanup();
  }
});

test('watch: event persistence and querying — listWatchEvents filters by project and since', async () => {
  const { fixture, store, config, reportsDir, guardianSelfPaths, cleanup } = await setup();
  try {
    const watcher = new Watcher({ store, config, reportsDir, guardianSelfPaths });
    const projects = await store.listProjects();
    const projectA = byName(projects, 'watch-project-a');
    await watcher.start(projects);

    writeFileSync(path.join(fixture.projectA, 'src', 'index.js'), 'export const x = 7;\n');
    await waitFor(() => watcher.stats.refreshes >= 1);
    await watcher.stop();

    const allEvents = await store.listWatchEvents({});
    assert.ok(allEvents.length >= 1);

    const projectEvents = await store.listWatchEvents({ projectId: projectA.id });
    assert.ok(projectEvents.every((e) => e.project_id === projectA.id));
    assert.ok(projectEvents.length >= 1);

    const futureEvents = await store.listWatchEvents({ sinceIso: new Date(Date.now() + 3600_000).toISOString() });
    assert.equal(futureEvents.length, 0);
  } finally {
    cleanup();
  }
});
