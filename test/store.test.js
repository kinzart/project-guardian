import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JsonFileStore } from '../src/store/JsonFileStore.js';

test('JsonFileStore round-trips projects, sources, observations, scans', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'guardian-store-'));
  const dbPath = path.join(dir, 'guardian.db.json');
  try {
    const store = new JsonFileStore(dbPath);
    await store.init();
    assert.ok(existsSync(dbPath), 'store file is created on init');

    const project = { id: 'p1', name: 'demo', root_path: 'C:\\demo', fingerprint: 'abc', status: { activity_state: 'ACTIVE', completion_state: 'UNKNOWN' } };
    await store.upsertProject(project);

    const fetchedById = await store.getProject('p1');
    assert.deepEqual(fetchedById, project);

    const fetchedByPath = await store.getProject('C:\\demo');
    assert.deepEqual(fetchedByPath, project);

    await store.addSource({ project_id: 'p1', source_type: 'git', path: 'C:\\demo\\.git', last_modified: null, metadata: {} });
    const sources = await store.listSourcesForProject('p1');
    assert.equal(sources.length, 1);
    assert.equal(sources[0].source_type, 'git');

    await store.addObservation({ project_id: 'p1', kind: 'markdown_heading', value: 'Demo', source_path: 'C:\\demo\\README.md', observed_at: new Date().toISOString() });
    const observations = await store.listObservationsForProject('p1');
    assert.equal(observations.length, 1);

    await store.recordScan({ scan_id: 's1', started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:00:01.000Z', roots: [], projects_found: 1, projects_unchanged: 0, errors: 0, duration_ms: 1000 });
    const lastScan = await store.getLastScan();
    assert.equal(lastScan.scan_id, 's1');

    await store.close();

    // Re-open from disk to prove persistence, not just in-memory state.
    const reopened = new JsonFileStore(dbPath);
    await reopened.init();
    const projects = await reopened.listProjects();
    assert.equal(projects.length, 1);
    assert.equal(projects[0].name, 'demo');
    await reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('JsonFileStore upsertProject merges fields rather than replacing wholesale', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'guardian-store-'));
  const dbPath = path.join(dir, 'guardian.db.json');
  try {
    const store = new JsonFileStore(dbPath);
    await store.init();
    await store.upsertProject({ id: 'p1', name: 'demo', root_path: 'C:\\demo', detected_at: '2026-01-01T00:00:00.000Z' });
    await store.upsertProject({ id: 'p1', last_seen: '2026-01-02T00:00:00.000Z' });
    const project = await store.getProject('p1');
    assert.equal(project.name, 'demo');
    assert.equal(project.detected_at, '2026-01-01T00:00:00.000Z');
    assert.equal(project.last_seen, '2026-01-02T00:00:00.000Z');
    await store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
