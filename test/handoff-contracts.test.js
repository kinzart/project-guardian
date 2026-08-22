import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HANDOFF_SCHEMA_VERSION, handoffPaths, validateContract, writeContracts } from '../src/handoff/contracts.js';

function contract(extra = {}) { return { guardian_handoff_schema_version: HANDOFF_SCHEMA_VERSION, project: 'project-guardian', phase: 'V0.6C', status: 'PASS', baseline_commit: 'abc1234', updated_at: '2026-08-21T00:00:00Z', ...extra }; }

test('handoff contract: schema is versioned and rejects missing/invalid fields', () => {
  assert.equal(validateContract(contract()).ok, true);
  assert.equal(validateContract({ ...contract(), status: 'MAYBE' }).ok, false);
  assert.equal(validateContract({ ...contract(), guardian_handoff_schema_version: 2 }).ok, false);
});

test('handoff contract: JSON and short human handoffs are generated deterministically in Guardian-owned paths', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'guardian-handoff-'));
  try {
    const state = contract({ working_tree: 'CLEAN', objective: 'test', gates: { G1: 'PASS' }, next_action: 'V0.7' });
    const next = contract({ phase: 'V0.7', status: 'UNKNOWN', objective: 'dashboard', scope: [], out_of_scope: [], required_gates: [], stop_condition: 'checkpoint' });
    const paths = writeContracts(root, { state, result: state, next });
    assert.equal(JSON.parse(readFileSync(paths.state, 'utf8')).guardian_handoff_schema_version, 1);
    assert.match(readFileSync(paths.latestMd, 'utf8'), /G1=PASS/);
    assert.match(readFileSync(paths.nextMd, 'utf8'), /V0\.7/);
    assert.ok(paths.state.startsWith(path.join(root, 'data')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('next-task contract requires scope, gates, and stop condition', () => {
  assert.equal(validateContract(contract(), 'next').ok, false);
  assert.equal(validateContract(contract({ objective: 'x', scope: [], out_of_scope: [], required_gates: [], stop_condition: 'stop' }), 'next').ok, true);
});
