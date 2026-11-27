import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scoreDirectory, confidenceForScore } from '../src/discovery/evidence.js';
import { JsonFileStore } from '../src/store/JsonFileStore.js';
import { runScan } from '../src/discovery/scanner.js';
import { ScanLogger } from '../src/util/logger.js';

const THRESH = { high: 55, medium: 30, low: 10 };
const CONFIG = { exclude: ['node_modules', '.git'], maxDepth: 8, maxDirectoriesVisited: 50000, confidenceThresholds: THRESH, activityThresholds: { activeHours: 48, warmDays: 7, staleDays: 30 } };
const file = (name) => ({ name, isDirectory: () => false });

async function scan(root, extra = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cerebro-db-'));
  const store = new JsonFileStore(path.join(dir, 'db.json')); await store.init();
  const logger = new ScanLogger(dir, 'scan');
  await runScan({ config: { ...CONFIG, ...extra }, store, logger, roots: [root] });
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('evidence: a DAW project file is strong evidence', () => {
  const { score } = scoreDirectory([file('mix.song')]);
  assert.ok(score >= 30);
});

test('evidence: ten media files make a LOW project, nine do not', () => {
  const ten = Array.from({ length: 10 }, (_, i) => file(`take${i}.wav`));
  assert.equal(confidenceForScore(scoreDirectory(ten).score, THRESH), 'LOW');
  assert.equal(confidenceForScore(scoreDirectory(ten.slice(1)).score, THRESH), 'NONE');
});

test('scanner: music project gets kind=music and latest_entry', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cerebro-root-'));
  const proj = path.join(root, 'Album'); mkdirSync(proj);
  writeFileSync(path.join(proj, 'old.wav'), 'x'); utimesSync(path.join(proj, 'old.wav'), new Date('2025-01-01'), new Date('2025-01-01'));
  writeFileSync(path.join(proj, 'mix_v3.song'), 'x');
  const { store, cleanup } = await scan(root);
  try {
    const [p] = await store.listProjects();
    assert.equal(p.kind, 'music');
    assert.equal(p.latest_entry.name, 'mix_v3.song');
    assert.equal(p.metadata_only, false);
  } finally { cleanup(); rmSync(root, { recursive: true, force: true }); }
});

test('scanner: metadata-only roots never open files', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cerebro-drive-'));
  const proj = path.join(root, 'Doc'); mkdirSync(proj);
  writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'from-manifest' }));
  writeFileSync(path.join(proj, 'README.md'), '# SECRET TITLE\n');
  const { store, cleanup } = await scan(root, { metadataOnlyRoots: [root] });
  try {
    const [p] = await store.listProjects();
    assert.equal(p.metadata_only, true);
    assert.equal(p.name, 'Doc');
    const sources = await store.listSourcesForProject(p.id);
    assert.equal(sources.length, 0);
  } finally { cleanup(); rmSync(root, { recursive: true, force: true }); }
});
