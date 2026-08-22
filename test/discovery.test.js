import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scoreDirectory, confidenceForScore } from '../src/discovery/evidence.js';
import { walkPruned } from '../src/discovery/walker.js';
import { JsonFileStore } from '../src/store/JsonFileStore.js';
import { runScan } from '../src/discovery/scanner.js';
import { ScanLogger } from '../src/util/logger.js';
import { createFixtureRoot, cleanupFixtureRoot } from './helpers/fixtures.js';

const CONFIG = {
  exclude: ['node_modules', '.git', 'dist', 'build', 'coverage', '.cache', '.next', '.nuxt', 'vendor', 'venv', '.venv', '__pycache__'],
  maxDepth: 8,
  maxDirectoriesVisited: 50000,
  confidenceThresholds: { high: 55, medium: 30, low: 10 },
  activityThresholds: { activeHours: 48, warmDays: 7, staleDays: 30 },
};

async function scanFixtures(fixtureRoot) {
  const dbDir = mkdtempSync(path.join(os.tmpdir(), 'guardian-db-'));
  const logsDir = mkdtempSync(path.join(os.tmpdir(), 'guardian-logs-'));
  const store = new JsonFileStore(path.join(dbDir, 'guardian.db.json'));
  await store.init();
  const logger = new ScanLogger(logsDir, 'test-scan');
  const scan = await runScan({ config: CONFIG, store, logger, roots: [fixtureRoot] });
  return { store, scan, cleanup: () => { rmSync(dbDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); rmSync(logsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } };
}

test('evidence.scoreDirectory: a lone README.md is not enough to be a project', () => {
  const entries = [{ name: 'README.md', isDirectory: () => false }];
  const { score } = scoreDirectory(entries);
  assert.equal(confidenceForScore(score, CONFIG.confidenceThresholds), 'NONE');
});

test('evidence.scoreDirectory: .git + .memory + package.json scores HIGH', () => {
  const entries = [
    { name: '.git', isDirectory: () => true },
    { name: '.memory', isDirectory: () => true },
    { name: 'package.json', isDirectory: () => false },
    { name: 'README.md', isDirectory: () => false },
  ];
  const { score } = scoreDirectory(entries);
  assert.equal(confidenceForScore(score, CONFIG.confidenceThresholds), 'HIGH');
});

test('walker: never yields a path inside node_modules', () => {
  const fixtureRoot = createFixtureRoot();
  try {
    const seen = [];
    for (const { dirPath } of walkPruned([fixtureRoot], { exclude: CONFIG.exclude, maxDepth: CONFIG.maxDepth, shouldDescend: () => true })) {
      seen.push(dirPath);
    }
    const insideNodeModules = seen.filter((p) => p.split(path.sep).includes('node_modules'));
    assert.equal(insideNodeModules.length, 0, 'walker must never descend into node_modules');
  } finally {
    cleanupFixtureRoot(fixtureRoot);
  }
});

test('scanner: detects all fixture projects with expected confidence tiers, skips docs-only', async () => {
  const fixtureRoot = createFixtureRoot();
  const { store, scan, cleanup } = await scanFixtures(fixtureRoot);
  try {
    const projects = await store.listProjects();
    const byName = Object.fromEntries(projects.map((p) => [p.name, p]));

    assert.equal(byName['aum-git-fixture']?.confidence, 'HIGH');
    assert.equal(byName['aum-git-fixture']?.has_git, true);
    assert.equal(byName['aum-git-fixture']?.has_aum, true);

    assert.equal(byName['node-no-aum-fixture']?.confidence, 'MEDIUM');
    assert.equal(byName['node-no-aum-fixture']?.has_git, false);

    assert.equal(byName['fixture-python']?.confidence, 'MEDIUM');
    assert.ok(byName['fixture-python']?.project_type.includes('python'));

    assert.equal(byName['secret-fixture']?.confidence, 'MEDIUM');

    assert.equal(byName['huge-nm-fixture']?.confidence, 'MEDIUM');

    const docsOnlyDetected = projects.some((p) => p.root_path.endsWith('fixture-docs-only'));
    assert.equal(docsOnlyDetected, false, 'a directory with only a lone README.md must not be classified as a project');

    assert.ok(scan.projects_found >= 6);
  } finally {
    cleanup();
    cleanupFixtureRoot(fixtureRoot);
  }
});

test('scanner: corrupt .memory files do not crash the scan and completion stays UNKNOWN', async () => {
  const fixtureRoot = createFixtureRoot();
  const { store, scan, cleanup } = await scanFixtures(fixtureRoot);
  try {
    assert.equal(scan.errors >= 0, true); // scan completed and produced a report either way
    const projects = await store.listProjects();
    const corrupt = projects.find((p) => p.name === 'fixture-corrupt-memory');
    assert.ok(corrupt, 'project with corrupt AUM is still listed');
    assert.equal(corrupt.has_aum, true);
    assert.equal(corrupt.status.completion_state, 'UNKNOWN');
    assert.ok(corrupt.errors.length > 0, 'inspector errors are recorded on the project');
  } finally {
    cleanup();
    cleanupFixtureRoot(fixtureRoot);
  }
});

test('scanner: a single unreadable/erroring project does not stop other projects from being scanned', async () => {
  const fixtureRoot = createFixtureRoot();
  const { store, cleanup } = await scanFixtures(fixtureRoot);
  try {
    const projects = await store.listProjects();
    // fixture-corrupt-memory has inspector errors, but siblings must still be fully present.
    const healthy = projects.find((p) => p.name === 'aum-git-fixture');
    assert.ok(healthy);
    assert.equal(healthy.errors.length, 0);
  } finally {
    cleanup();
    cleanupFixtureRoot(fixtureRoot);
  }
});

test('scanner: huge node_modules tree is pruned and does not dominate scan time', async () => {
  const fixtureRoot = createFixtureRoot();
  const started = Date.now();
  const { store, cleanup } = await scanFixtures(fixtureRoot);
  const elapsed = Date.now() - started;
  try {
    const projects = await store.listProjects();
    const huge = projects.find((p) => p.name === 'huge-nm-fixture');
    assert.ok(huge);
    // 300 fake packages x 2 files = 600 files under node_modules; if the walker descended into
    // it the scan would take substantially longer than this generous bound.
    assert.ok(elapsed < 10000, `scan took ${elapsed}ms, node_modules pruning may not be working`);
  } finally {
    cleanup();
    cleanupFixtureRoot(fixtureRoot);
  }
});
