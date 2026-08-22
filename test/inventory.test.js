import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JsonFileStore } from '../src/store/JsonFileStore.js';
import { renderInventory } from '../src/report/inventory.js';

function fakeProject(id, name, activityState, completionState) {
  return {
    id,
    name,
    root_path: `C:\\fake\\${name}`,
    confidence: 'HIGH',
    has_aum: false,
    has_git: false,
    status: { activity_state: activityState, completion_state: completionState },
    status_confidence: { activity_evidence: [`fake evidence for ${name}`], completion_evidence: [] },
    completion_detail: { source: null, evidence: null, updated_at: null },
    errors: [],
  };
}

// Regression guard for the session's item #5: a rendered report's summary counts must be
// computed from the exact same data as the per-project rows, so they can never contradict each
// other (previously this was only true "by convention", not enforced/tested).
test('renderInventory: the Summary completion counts always match a manual count of the per-project rows', async () => {
  const dbDir = mkdtempSync(path.join(os.tmpdir(), 'guardian-invtest-'));
  const reportsDir = mkdtempSync(path.join(os.tmpdir(), 'guardian-invtest-reports-'));
  try {
    const store = new JsonFileStore(path.join(dbDir, 'guardian.db.json'));
    await store.init();

    await store.upsertProject(fakeProject('p1', 'alpha', 'ACTIVE', 'DONE'));
    await store.upsertProject(fakeProject('p2', 'beta', 'ACTIVE', 'DONE'));
    await store.upsertProject(fakeProject('p3', 'gamma', 'WARM', 'IN_PROGRESS'));
    await store.upsertProject(fakeProject('p4', 'delta', 'DORMANT', 'UNKNOWN'));
    await store.upsertProject(fakeProject('p5', 'epsilon', 'STALE', 'DONE'));

    const { inventoryPath } = await renderInventory({ store, reportsDir, lastScan: null });
    const text = readFileSync(inventoryPath, 'utf8');

    const summaryMatch = text.match(/Completion: .*?DONE (\d+)/);
    assert.ok(summaryMatch, 'summary line with DONE count must be present');
    const summaryDoneCount = Number(summaryMatch[1]);

    const rowDoneCount = (text.match(/^Completion: DONE$/gm) || []).length;

    assert.equal(summaryDoneCount, 3, 'sanity check on the fixture data itself');
    assert.equal(summaryDoneCount, rowDoneCount, 'the report must never contradict its own data');

    await store.close();
  } finally {
    rmSync(dbDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(reportsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
