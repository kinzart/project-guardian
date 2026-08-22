import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProjectRuntimeState, buildWorkSessions } from '../src/activity/runtime-rollup.js';

const project = { id: 'pg', name: 'PROJECT-GUARDIAN' };
const intelligence = { current_focus: { value: 'V0.6C', confidence: 'HIGH', evidence: [{ source: '.memory/state.json' }] }, blockers: [], next_steps: [] };

test('runtime rollup: native/process/shell evidence becomes one work session, not duplicate activities', () => {
  const sessions = buildWorkSessions({ projectId: 'pg', agentSessions: [{ session_id: 'one', possible_project_id: 'pg', agent_identity: 'CODEX', pid: 42, shell_session_id: 'sh', started_at: '2026-08-21T10:00:00Z', evidence_sources: ['PROCESS', 'CODEX_NATIVE'], project_confidence: 'AUTHORITATIVE' }], shellSessions: [{ shell_session_id: 'sh' }] });
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0].evidence_sources, ['PROCESS', 'CODEX_NATIVE']);
  assert.deepEqual(sessions[0].shells, ['sh']);
});

test('runtime rollup: active authoritative agent deterministically wins ACTIVE_NOW', () => {
  const state = buildProjectRuntimeState({ project, intelligence, agentSessions: [{ session_id: 'one', possible_project_id: 'pg', agent_identity: 'CODEX', status: 'ACTIVE', started_at: '2026-08-21T10:00:00Z', evidence_sources: ['CODEX_NATIVE'], project_confidence: 'AUTHORITATIVE' }], now: new Date('2026-08-21T11:00:00Z') });
  assert.equal(state.operational_status, 'ACTIVE_NOW');
  assert.equal(state.confidence, 'HIGH');
  assert.deepEqual(state.active_agents, ['CODEX']);
  assert.equal(state.current_focus.value, 'V0.6C');
});

test('runtime rollup: explicit blocker wins when there is no active evidence', () => {
  const blocked = { ...intelligence, blockers: [{ text: 'manual gate', confidence: 'HIGH', evidence: [{ source: 'handoff', snippet: 'manual gate' }] }] };
  const state = buildProjectRuntimeState({ project, intelligence: blocked, now: new Date('2026-08-21T11:00:00Z') });
  assert.equal(state.operational_status, 'BLOCKED');
  assert.equal(state.confidence, 'HIGH');
});

test('runtime rollup: filesystem older than five minutes never becomes ACTIVE_NOW', () => {
  const state = buildProjectRuntimeState({ project, intelligence, watchEvents: [{ project_id: 'pg', occurred_at: '2026-08-21T10:00:00Z', event_type: 'PROJECT_SOURCE_CHANGED' }], now: new Date('2026-08-21T11:00:00Z') });
  assert.equal(state.operational_status, 'RECENTLY_ACTIVE');
});
