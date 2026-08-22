import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JsonFileStore } from '../src/store/JsonFileStore.js';
import { runScan } from '../src/discovery/scanner.js';
import { ScanLogger } from '../src/util/logger.js';
import { createHygieneFixtureRoot, cleanupFixtureRoot } from './helpers/fixtures.js';

// Mirrors the shipped guardian.config.json defaults relevant to hygiene (exclude + excludePaths).
const CONFIG = {
  exclude: [
    'node_modules', '.git', 'dist', 'build', 'coverage', '.cache', '.next', '.nuxt', 'vendor',
    'venv', '.venv', '__pycache__', '.npm', '.nvm', '.yarn', '.pnpm-store', '.cargo', '.rustup',
    '.gradle', '.m2', '.nuget', '.gem', '.rvm', '.conda', '.docker', '.eclipse', '.android',
    '.vscode-server',
  ],
  excludePaths: ['.vscode/extensions', '.vscode-insiders/extensions'],
  maxDepth: 8,
  maxDirectoriesVisited: 50000,
  confidenceThresholds: { high: 55, medium: 30, low: 10 },
  activityThresholds: { activeHours: 48, warmDays: 7, staleDays: 30 },
};

async function scanHygieneFixture(fixtureRoot) {
  const dbDir = mkdtempSync(path.join(os.tmpdir(), 'guardian-db-'));
  const logsDir = mkdtempSync(path.join(os.tmpdir(), 'guardian-logs-'));
  const store = new JsonFileStore(path.join(dbDir, 'guardian.db.json'));
  await store.init();
  const logger = new ScanLogger(logsDir, 'hygiene-scan');
  const scan = await runScan({ config: CONFIG, store, logger, roots: [fixtureRoot] });
  return {
    store,
    scan,
    cleanup: () => {
      rmSync(dbDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      rmSync(logsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

test('scanner: .vscode/extensions and package-manager caches are never classified as projects', async () => {
  const fixtureRoot = createHygieneFixtureRoot();
  const { store, cleanup } = await scanHygieneFixture(fixtureRoot);
  try {
    const projects = await store.listProjects();

    const extensionHit = projects.find((p) => p.root_path.replace(/\\/g, '/').includes('.vscode/extensions'));
    assert.equal(extensionHit, undefined, 'a .vscode/extensions entry must never be detected as a project');

    const npmCacheHit = projects.find((p) => p.root_path.replace(/\\/g, '/').includes('/.npm/'));
    assert.equal(npmCacheHit, undefined, 'a package-manager cache entry must never be detected as a project');

    // The exclusions must not be so broad that a real project next to the noise is missed.
    const legit = projects.find((p) => p.name === 'legit-tool');
    assert.ok(legit, 'a real project sitting next to tooling noise must still be detected');
  } finally {
    cleanup();
    cleanupFixtureRoot(fixtureRoot);
  }
});

test('scanner: project family — canonical (.git) is distinguished from output/version/workspace duplicates, nothing is dropped', async () => {
  const fixtureRoot = createHygieneFixtureRoot();
  const { store, cleanup } = await scanHygieneFixture(fixtureRoot);
  try {
    const projects = await store.listProjects();
    const widgets = projects.filter((p) => p.name === 'Widget App');
    assert.equal(widgets.length, 4, 'all four Widget App directories remain separate project records — nothing is merged or dropped');

    const canonical = widgets.find((p) => p.is_canonical);
    assert.ok(canonical, 'one member of the family is marked canonical');
    assert.equal(canonical.has_git, true, 'the .git-backed copy is chosen as canonical');
    assert.equal(canonical.related_roots.length, 3);

    const byRelation = Object.fromEntries(widgets.filter((p) => !p.is_canonical).map((p) => [p.relation_type, p]));
    assert.equal(byRelation.output.canonical_project, canonical.id);
    assert.equal(byRelation.version.canonical_project, canonical.id);
    assert.equal(byRelation.workspace.canonical_project, canonical.id);

    for (const p of widgets) {
      assert.equal(p.project_family, canonical.project_family);
    }
  } finally {
    cleanup();
    cleanupFixtureRoot(fixtureRoot);
  }
});

test('scanner: nested-root suppression — a lone manifest under an outputs/ ancestor is flagged, not silently promoted, and never deleted', async () => {
  const fixtureRoot = createHygieneFixtureRoot();
  const { store, cleanup } = await scanHygieneFixture(fixtureRoot);
  try {
    const projects = await store.listProjects();
    const nested = projects.find((p) => p.name === 'generated-thing');

    assert.ok(nested, 'the candidate is still recorded — Guardian never deletes information');
    assert.equal(nested.nested_candidate, true);
    assert.equal(nested.path_relation_hint, 'output');
    assert.equal(nested.has_git, false);
    assert.equal(nested.has_aum, false);

    const outerContainer = projects.find((p) => p.root_path.endsWith('nested-output-only'));
    assert.equal(outerContainer, undefined, 'the weak-evidence-only container itself still does not qualify as a project');
  } finally {
    cleanup();
    cleanupFixtureRoot(fixtureRoot);
  }
});

test('scanner: a project that stops matching (newly excluded) is pruned from the store on the next scan', async () => {
  const fixtureRoot = createHygieneFixtureRoot();
  const dbDir = mkdtempSync(path.join(os.tmpdir(), 'guardian-db-'));
  const logsDir = mkdtempSync(path.join(os.tmpdir(), 'guardian-logs-'));
  try {
    const store = new JsonFileStore(path.join(dbDir, 'guardian.db.json'));
    await store.init();

    // First scan with the old (pre-hygiene) config: no excludePaths, so the .vscode/extensions
    // entry gets in as a false positive, same as it did on the real machine before this fix.
    const looseConfig = { ...CONFIG, excludePaths: [], exclude: ['node_modules', '.git'] };
    const logger1 = new ScanLogger(logsDir, 'scan-1');
    await runScan({ config: looseConfig, store, logger: logger1, roots: [fixtureRoot] });
    const afterFirst = await store.listProjects();
    assert.ok(afterFirst.some((p) => p.name === 'some-ext'), 'sanity check: the false positive was captured under the old config');

    // Second scan with the hygiene config applied: the false positive must be pruned, not left
    // behind as a ghost record.
    const logger2 = new ScanLogger(logsDir, 'scan-2');
    const secondScan = await runScan({ config: CONFIG, store, logger: logger2, roots: [fixtureRoot] });
    const afterSecond = await store.listProjects();

    assert.equal(afterSecond.some((p) => p.name === 'some-ext'), false, 'the now-excluded false positive must be pruned, not linger as a ghost record');
    assert.ok(secondScan.projects_pruned >= 1);

    await store.close();
  } finally {
    cleanupFixtureRoot(fixtureRoot);
    rmSync(dbDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(logsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('scanner: completion_detail is populated with source/evidence/updated_at only when non-UNKNOWN, never invented', async () => {
  const fixtureRoot = createHygieneFixtureRoot();
  const { store, cleanup } = await scanHygieneFixture(fixtureRoot);
  try {
    const projects = await store.listProjects();
    const legit = projects.find((p) => p.name === 'legit-tool');
    assert.ok(legit);
    assert.equal(legit.status.completion_state, 'UNKNOWN');
    assert.equal(legit.completion_detail.source, null);
    assert.equal(legit.completion_detail.evidence, null);
    assert.equal(legit.completion_detail.updated_at, null);
  } finally {
    cleanup();
    cleanupFixtureRoot(fixtureRoot);
  }
});
