import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/activity/classify.js';

const thresholds = { activeHours: 48, warmDays: 7, staleDays: 30 };

test('classify: recent git activity -> ACTIVE, completion stays UNKNOWN with no explicit status', () => {
  const now = Date.now();
  const result = classify(
    { git: { lastCommitDate: new Date(now - 3600_000).toISOString() }, aum: null, markdown: null, rootMtimeIso: null },
    thresholds,
    now,
  );
  assert.equal(result.activityState, 'ACTIVE');
  assert.equal(result.completionState, 'UNKNOWN');
  assert.equal(result.completionEvidence.length, 0);
});

test('classify: activity between 2 and 7 days -> WARM', () => {
  const now = Date.now();
  const fourDaysAgo = new Date(now - 4 * 24 * 3600_000).toISOString();
  const result = classify({ git: { lastCommitDate: fourDaysAgo }, aum: null, markdown: null, rootMtimeIso: null }, thresholds, now);
  assert.equal(result.activityState, 'WARM');
});

test('classify: activity between 7 and 30 days -> STALE', () => {
  const now = Date.now();
  const fifteenDaysAgo = new Date(now - 15 * 24 * 3600_000).toISOString();
  const result = classify({ git: { lastCommitDate: fifteenDaysAgo }, aum: null, markdown: null, rootMtimeIso: null }, thresholds, now);
  assert.equal(result.activityState, 'STALE');
});

test('classify: activity older than 30 days -> DORMANT', () => {
  const now = Date.now();
  const sixtyDaysAgo = new Date(now - 60 * 24 * 3600_000).toISOString();
  const result = classify({ git: { lastCommitDate: sixtyDaysAgo }, aum: null, markdown: null, rootMtimeIso: null }, thresholds, now);
  assert.equal(result.activityState, 'DORMANT');
});

test('classify: no timestamps at all -> DORMANT, never invents a date', () => {
  const result = classify({ git: null, aum: null, markdown: null, rootMtimeIso: null }, thresholds, Date.now());
  assert.equal(result.activityState, 'DORMANT');
  assert.equal(result.lastActivityIso, null);
});

test('classify: explicit Status line in markdown overrides completion_state with evidence', () => {
  const now = Date.now();
  const markdown = { 'STATUS.md': { mtime: new Date(now).toISOString(), statusLine: 'Done' } };
  const result = classify({ git: null, aum: null, markdown, rootMtimeIso: new Date(now).toISOString() }, thresholds, now);
  assert.equal(result.completionState, 'DONE');
  assert.equal(result.completionEvidence.length, 1);
  assert.match(result.completionEvidence[0], /STATUS\.md/);
});

test('classify: unrecognized status text does not force a wrong completion_state', () => {
  const now = Date.now();
  const markdown = { 'STATUS.md': { mtime: new Date(now).toISOString(), statusLine: 'somewhere between planning and shipping' } };
  const result = classify({ git: null, aum: null, markdown, rootMtimeIso: new Date(now).toISOString() }, thresholds, now);
  assert.equal(result.completionState, 'UNKNOWN');
});
