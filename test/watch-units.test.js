import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isIgnoredChange, isProtectedChange, classifySignificance } from '../src/watch/filters.js';
import { normalizeRawEvent } from '../src/watch/normalizer.js';
import { Coalescer } from '../src/watch/debounce.js';
import { resolveProject } from '../src/watch/project-resolver.js';

const PROJECT_ROOT = 'C:\\projects\\demo';
const EXCLUDE = ['node_modules', 'dist', '.git'];
const EXCLUDE_PATHS = ['.vscode/extensions'];

test('filters.isIgnoredChange: node_modules, dist, temp/swap files are ignored', () => {
  assert.equal(isIgnoredChange(path.join(PROJECT_ROOT, 'node_modules', 'x', 'index.js'), { projectRoot: PROJECT_ROOT, excludeNames: EXCLUDE, excludePaths: EXCLUDE_PATHS }), true);
  assert.equal(isIgnoredChange(path.join(PROJECT_ROOT, 'dist', 'bundle.js'), { projectRoot: PROJECT_ROOT, excludeNames: EXCLUDE, excludePaths: EXCLUDE_PATHS }), true);
  assert.equal(isIgnoredChange(path.join(PROJECT_ROOT, 'handoff.md.tmp'), { projectRoot: PROJECT_ROOT, excludeNames: EXCLUDE, excludePaths: EXCLUDE_PATHS }), true);
  assert.equal(isIgnoredChange(path.join(PROJECT_ROOT, 'file.swp'), { projectRoot: PROJECT_ROOT, excludeNames: EXCLUDE, excludePaths: EXCLUDE_PATHS }), true);
  assert.equal(isIgnoredChange(path.join(PROJECT_ROOT, '~$doc.docx'), { projectRoot: PROJECT_ROOT, excludeNames: EXCLUDE, excludePaths: EXCLUDE_PATHS }), true);
});

test('filters.isIgnoredChange: real source files are never ignored', () => {
  assert.equal(isIgnoredChange(path.join(PROJECT_ROOT, 'src', 'index.js'), { projectRoot: PROJECT_ROOT, excludeNames: EXCLUDE, excludePaths: EXCLUDE_PATHS }), false);
  assert.equal(isIgnoredChange(path.join(PROJECT_ROOT, '.memory', 'handoff.md'), { projectRoot: PROJECT_ROOT, excludeNames: EXCLUDE, excludePaths: EXCLUDE_PATHS }), false);
});

test('filters.isIgnoredChange: .git only HEAD/index/refs pass through, objects/logs do not', () => {
  const opts = { projectRoot: PROJECT_ROOT, excludeNames: [], excludePaths: [] };
  assert.equal(isIgnoredChange(path.join(PROJECT_ROOT, '.git', 'HEAD'), opts), false);
  assert.equal(isIgnoredChange(path.join(PROJECT_ROOT, '.git', 'index'), opts), false);
  assert.equal(isIgnoredChange(path.join(PROJECT_ROOT, '.git', 'refs', 'heads', 'main'), opts), false);
  assert.equal(isIgnoredChange(path.join(PROJECT_ROOT, '.git', 'objects', 'ab', 'cdef'), opts), true);
  assert.equal(isIgnoredChange(path.join(PROJECT_ROOT, '.git', 'logs', 'HEAD'), opts), true);
});

test('filters.isProtectedChange: secret-shaped files and dirs are flagged', () => {
  assert.equal(isProtectedChange(path.join(PROJECT_ROOT, '.env')), true);
  assert.equal(isProtectedChange(path.join(PROJECT_ROOT, 'credentials.json')), true);
  assert.equal(isProtectedChange(path.join(PROJECT_ROOT, '.ssh', 'id_rsa')), true);
  assert.equal(isProtectedChange(path.join(PROJECT_ROOT, 'README.md')), false);
});

test('filters.classifySignificance: AUM and known markdown are INTELLIGENCE_RELEVANT, manifests DISCOVERY_RELEVANT, code ACTIVITY_ONLY', () => {
  assert.equal(classifySignificance(path.join(PROJECT_ROOT, '.memory', 'handoff.md'), PROJECT_ROOT), 'INTELLIGENCE_RELEVANT');
  assert.equal(classifySignificance(path.join(PROJECT_ROOT, 'TASKS.md'), PROJECT_ROOT), 'INTELLIGENCE_RELEVANT');
  assert.equal(classifySignificance(path.join(PROJECT_ROOT, 'package.json'), PROJECT_ROOT), 'DISCOVERY_RELEVANT');
  assert.equal(classifySignificance(path.join(PROJECT_ROOT, 'src', 'api.js'), PROJECT_ROOT), 'ACTIVITY_ONLY');
});

test('normalizer.normalizeRawEvent: drops events with no filename, joins root+filename otherwise', () => {
  assert.equal(normalizeRawEvent({ root: PROJECT_ROOT, eventType: 'change', filename: null }), null);
  const evt = normalizeRawEvent({ root: PROJECT_ROOT, eventType: 'change', filename: 'src\\index.js' });
  assert.equal(evt.absPath, path.join(PROJECT_ROOT, 'src', 'index.js'));
  assert.ok(evt.occurredAt);
});

test('project-resolver.resolveProject: longest-prefix match, null when nothing matches', () => {
  const projects = [
    { id: 'p1', root_path: 'C:\\a\\b' },
    { id: 'p2', root_path: 'C:\\a\\b\\c' },
  ];
  assert.equal(resolveProject('C:\\a\\b\\c\\d.js', projects).id, 'p2');
  assert.equal(resolveProject('C:\\a\\b\\d.js', projects).id, 'p1');
  assert.equal(resolveProject('C:\\other\\x.js', projects), null);
});

test('debounce.Coalescer: rapid repeated pushes to the same project debounce into a single flush', async () => {
  const flushes = [];
  const coalescer = new Coalescer({ debounceMs: 40, settleMs: 2000, onFlush: (id, batch) => flushes.push({ id, batch }) });
  for (let i = 0; i < 5; i += 1) {
    coalescer.push('p1', { absPath: `C:\\a\\file${i}.js`, significance: 'ACTIVITY_ONLY', occurredAt: new Date().toISOString() });
    await new Promise((r) => setTimeout(r, 5));
  }
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(flushes.length, 1);
  assert.equal(flushes[0].id, 'p1');
  assert.equal(flushes[0].batch.paths.length, 5);
  assert.equal(flushes[0].batch.rawEventCount, 5);
});

test('debounce.Coalescer: settleMs force-flushes under continuous activity even if never quiet', async () => {
  const flushes = [];
  const coalescer = new Coalescer({ debounceMs: 200, settleMs: 100, onFlush: (id, batch) => flushes.push({ id, batch }) });
  const interval = setInterval(() => {
    coalescer.push('p1', { absPath: 'C:\\a\\file.js', significance: 'ACTIVITY_ONLY', occurredAt: new Date().toISOString() });
  }, 30);
  await new Promise((r) => setTimeout(r, 250));
  clearInterval(interval);
  coalescer.stop();
  assert.ok(flushes.length >= 1, 'settleMs must force at least one flush despite continuous activity');
});

test('debounce.Coalescer: separate projects flush independently', async () => {
  const flushes = [];
  const coalescer = new Coalescer({ debounceMs: 30, settleMs: 2000, onFlush: (id, batch) => flushes.push({ id, batch }) });
  coalescer.push('p1', { absPath: 'C:\\a\\file.js', significance: 'ACTIVITY_ONLY', occurredAt: new Date().toISOString() });
  coalescer.push('p2', { absPath: 'C:\\b\\file.js', significance: 'ACTIVITY_ONLY', occurredAt: new Date().toISOString() });
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(flushes.length, 2);
  const ids = flushes.map((f) => f.id).sort();
  assert.deepEqual(ids, ['p1', 'p2']);
});
