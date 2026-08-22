import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProjectName, inferRelationType, groupFamilies, isNestedCandidate } from '../src/discovery/family.js';

test('normalizeProjectName strips version and copy suffixes', () => {
  assert.equal(normalizeProjectName('Widget App'), 'widget app');
  assert.equal(normalizeProjectName('Widget App V2'), 'widget app');
  assert.equal(normalizeProjectName('Widget App-v3'), 'widget app');
  assert.equal(normalizeProjectName('Widget App (copy)'), 'widget app');
  assert.equal(normalizeProjectName('Widget App copy 2'), 'widget app');
});

test('inferRelationType reads path segments deepest-first', () => {
  assert.equal(inferRelationType('C:\\x\\outputs\\Widget App'), 'output');
  assert.equal(inferRelationType('C:\\x\\work\\Widget App'), 'workspace');
  assert.equal(inferRelationType('C:\\x\\outputs\\Widget App-V2'), 'version');
  assert.equal(inferRelationType('C:\\x\\Widget App (copy)'), 'copy');
  assert.equal(inferRelationType('C:\\x\\Widget App'), 'related');
});

test('isNestedCandidate: definitive evidence (.git/.memory) always overrides the path hint', () => {
  assert.equal(isNestedCandidate('C:\\x\\outputs\\Widget App', true), false);
  assert.equal(isNestedCandidate('C:\\x\\outputs\\Widget App', false), true);
  assert.equal(isNestedCandidate('C:\\x\\Widget App', false), false);
});

test('groupFamilies: picks the .git/.memory-backed candidate as canonical, others get related_roots', () => {
  const candidates = [
    { id: 'canon', name: 'Widget App', root_path: 'C:\\family\\canonical\\Widget App', confidence: 'HIGH', evidenceScore: 85, hasDefinitiveEvidence: true },
    { id: 'out', name: 'Widget App', root_path: 'C:\\family\\outputs\\Widget App', confidence: 'MEDIUM', evidenceScore: 35, hasDefinitiveEvidence: false },
    { id: 'v2', name: 'Widget App', root_path: 'C:\\family\\outputs\\Widget App-V2', confidence: 'MEDIUM', evidenceScore: 35, hasDefinitiveEvidence: false },
    { id: 'work', name: 'Widget App', root_path: 'C:\\family\\work\\Widget App', confidence: 'MEDIUM', evidenceScore: 35, hasDefinitiveEvidence: false },
  ];
  const map = groupFamilies(candidates);

  assert.equal(map.get('canon').is_canonical, true);
  assert.equal(map.get('canon').related_roots.length, 3);

  assert.equal(map.get('out').is_canonical, false);
  assert.equal(map.get('out').canonical_project, 'canon');
  assert.equal(map.get('out').relation_type, 'output');

  assert.equal(map.get('v2').relation_type, 'version');
  assert.equal(map.get('work').relation_type, 'workspace');

  // Never merges: every member keeps its own id, none are dropped from the map.
  assert.equal(map.size, 4);
});

test('groupFamilies: a unique name (or an overly generic short name) forms no family', () => {
  const candidates = [
    { id: 'a', name: 'Totally Unique Name', root_path: 'C:\\a', confidence: 'HIGH', evidenceScore: 50, hasDefinitiveEvidence: true },
    { id: 'b', name: 'app', root_path: 'C:\\b', confidence: 'MEDIUM', evidenceScore: 30, hasDefinitiveEvidence: false },
    { id: 'c', name: 'App', root_path: 'C:\\c', confidence: 'MEDIUM', evidenceScore: 30, hasDefinitiveEvidence: false },
  ];
  const map = groupFamilies(candidates);
  assert.equal(map.size, 0, 'generic stopword names must not be grouped even when repeated');
});
