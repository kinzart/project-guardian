import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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

function snapshotMtimes(root) {
  const snapshot = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        walk(full);
      } else {
        snapshot.set(full, statSync(full).mtimeMs);
      }
    }
  };
  walk(root);
  return snapshot;
}

test('second scan of an unchanged tree is fully incremental', async () => {
  const fixtureRoot = createFixtureRoot();
  const dbDir = mkdtempSync(path.join(os.tmpdir(), 'guardian-db-'));
  const logsDir = mkdtempSync(path.join(os.tmpdir(), 'guardian-logs-'));
  try {
    const store = new JsonFileStore(path.join(dbDir, 'guardian.db.json'));
    await store.init();
    const logger = new ScanLogger(logsDir, 'scan-1');

    const firstScan = await runScan({ config: CONFIG, store, logger, roots: [fixtureRoot] });
    assert.ok(firstScan.projects_found > 0);
    assert.equal(firstScan.projects_unchanged, 0, 'first scan has nothing to reuse yet');

    const secondScan = await runScan({ config: CONFIG, store, logger, roots: [fixtureRoot] });
    assert.equal(secondScan.projects_found, firstScan.projects_found);
    assert.equal(secondScan.projects_unchanged, secondScan.projects_found, 'nothing changed on disk, so every project should be an incremental hit');
    assert.equal(secondScan.projects_processed, 0);

    await store.close();
  } finally {
    cleanupFixtureRoot(fixtureRoot);
    rmSync(dbDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(logsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('scanning never writes into the scanned fixture tree (read-many, write-only-inside-guardian)', async () => {
  const fixtureRoot = createFixtureRoot();
  const dbDir = mkdtempSync(path.join(os.tmpdir(), 'guardian-db-'));
  const logsDir = mkdtempSync(path.join(os.tmpdir(), 'guardian-logs-'));
  try {
    const before = snapshotMtimes(fixtureRoot);

    const store = new JsonFileStore(path.join(dbDir, 'guardian.db.json'));
    await store.init();
    const logger = new ScanLogger(logsDir, 'scan-1');
    await runScan({ config: CONFIG, store, logger, roots: [fixtureRoot] });
    await store.close();

    const after = snapshotMtimes(fixtureRoot);
    assert.equal(after.size, before.size, 'no files were added or removed in the fixture tree');
    for (const [file, mtime] of before) {
      assert.equal(after.get(file), mtime, `${file} mtime changed — scanner must never write into scanned projects`);
    }
  } finally {
    cleanupFixtureRoot(fixtureRoot);
    rmSync(dbDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(logsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
