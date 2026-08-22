import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isSecretFileName, isSecretDirName, isSecretPath } from '../src/util/secrets.js';
import { JsonFileStore } from '../src/store/JsonFileStore.js';
import { runScan } from '../src/discovery/scanner.js';
import { ScanLogger } from '../src/util/logger.js';
import { createFixtureRoot, cleanupFixtureRoot } from './helpers/fixtures.js';

test('isSecretFileName matches the required deny-list', () => {
  for (const name of ['.env', '.env.local', '.env.production', 'credentials.json', 'secrets.yaml', 'api.pem', 'id_rsa.key', 'id_rsa', 'id_ed25519', 'cookies.txt']) {
    assert.equal(isSecretFileName(name), true, `${name} should be flagged as secret`);
  }
  for (const name of ['README.md', 'package.json', 'index.js', 'envelope.js']) {
    assert.equal(isSecretFileName(name), false, `${name} should NOT be flagged as secret`);
  }
});

test('isSecretDirName matches wallet/credential-store directory names', () => {
  for (const name of ['wallet', 'my-wallet', '.ssh', '.aws', '.gnupg']) {
    assert.equal(isSecretDirName(name), true, `${name} should be flagged as secret dir`);
  }
  assert.equal(isSecretDirName('src'), false);
});

test('isSecretPath is the union of file and dir checks', () => {
  assert.equal(isSecretPath('.env'), true);
  assert.equal(isSecretPath('wallet'), true);
  assert.equal(isSecretPath('README.md'), false);
});

test('scanning fixture-secret-files never reads or persists secret content', async () => {
  const fixtureRoot = createFixtureRoot();
  const dbDir = mkdtempSync(path.join(os.tmpdir(), 'guardian-db-'));
  const logsDir = mkdtempSync(path.join(os.tmpdir(), 'guardian-logs-'));
  try {
    const store = new JsonFileStore(path.join(dbDir, 'guardian.db.json'));
    await store.init();
    const logger = new ScanLogger(logsDir, 'test-scan');

    const config = {
      exclude: ['node_modules', '.git'],
      maxDepth: 8,
      maxDirectoriesVisited: 50000,
      confidenceThresholds: { high: 55, medium: 30, low: 10 },
      activityThresholds: { activeHours: 48, warmDays: 7, staleDays: 30 },
    };

    await runScan({ config, store, logger, roots: [fixtureRoot] });

    const projects = await store.listProjects();
    const secretProject = projects.find((p) => p.name === 'secret-fixture');
    assert.ok(secretProject, 'the surrounding project is still detected');

    const dump = JSON.stringify(store.data);
    assert.doesNotMatch(dump, /super-secret-value/);
    assert.doesNotMatch(dump, /another-secret/);
    assert.doesNotMatch(dump, /should-never-be-read/);
    assert.doesNotMatch(dump, /BEGIN OPENSSH PRIVATE KEY/);

    const sources = await store.listSourcesForProject(secretProject.id);
    for (const source of sources) {
      assert.doesNotMatch(source.path, /\.env/);
      assert.doesNotMatch(source.path, /credentials\.json/);
      assert.doesNotMatch(source.path, /secrets\.yaml/);
      assert.doesNotMatch(source.path, /id_rsa/);
    }

    await store.close();
  } finally {
    cleanupFixtureRoot(fixtureRoot);
    rmSync(dbDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(logsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
