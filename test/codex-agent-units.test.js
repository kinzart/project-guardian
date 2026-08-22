import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCodexAgentEvent } from '../src/agent/codex/schema.js';
import { normalizeCodexAgentEvent } from '../src/agent/codex/normalizer.js';
import { detectCodex, configTomlHasHookDefinitions } from '../src/agent/codex/discovery.js';

// ---- schema.js -------------------------------------------------------------------------------

test('schema: valid SessionStart passes and is whitelisted', () => {
  const result = validateCodexAgentEvent({
    hook_event_name: 'SessionStart',
    session_id: 'abc123',
    cwd: 'D:\\PROJECT-GUARDIAN',
    model: 'gpt-5-codex',
    source: 'startup',
    native_process_pid: 4242,
    timestamp: '2026-08-20T10:00:00.000Z',
    hook_version: '1.0.0',
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.session_id, 'abc123');
  assert.equal(result.value.model, 'gpt-5-codex');
});

test('schema: SessionStart without cwd is still valid (cwd optional)', () => {
  const result = validateCodexAgentEvent({ hook_event_name: 'SessionStart', session_id: 'abc123', source: 'startup', native_process_pid: 1, timestamp: 't' });
  assert.equal(result.ok, true);
  assert.equal(result.value.cwd, undefined);
});

test('schema: missing required field is rejected', () => {
  const result = validateCodexAgentEvent({ hook_event_name: 'SessionStart', session_id: 'abc', native_process_pid: 1, timestamp: 't' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /missing required field: source/);
});

test('schema: unknown hook_event_name is rejected (Guardian never subscribes to it)', () => {
  const result = validateCodexAgentEvent({ hook_event_name: 'PreToolUse', session_id: 'abc', native_process_pid: 1, timestamp: 't' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /unknown or unsubscribed/);
});

test('schema: unexpected field for the event type is rejected', () => {
  const result = validateCodexAgentEvent({ hook_event_name: 'SessionEnd', session_id: 'abc', reason: 'other', native_process_pid: 1, timestamp: 't', source: 'startup' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /unexpected field for SessionEnd: source/);
});

const FORBIDDEN_PROBES = ['prompt', 'transcript_path', 'tool_input', 'tool_response', 'permission_mode', 'turn_id', 'message', 'reasoning'];
for (const field of FORBIDDEN_PROBES) {
  test(`schema: forbidden field "${field}" is rejected even if it looks harmless`, () => {
    const result = validateCodexAgentEvent({ hook_event_name: 'SessionStart', session_id: 'abc', source: 'startup', native_process_pid: 1, timestamp: 't', [field]: 'anything' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /forbidden field/);
  });
}

test('schema: transcript_path specifically is never even allow-listed, regardless of event type', () => {
  for (const type of ['SessionStart', 'SessionEnd', 'Stop']) {
    const base = type === 'SessionStart' ? { source: 'startup' } : type === 'SessionEnd' ? { reason: 'other' } : {};
    const result = validateCodexAgentEvent({ hook_event_name: type, session_id: 'abc', native_process_pid: 1, timestamp: 't', transcript_path: 'C:\\Users\\testuser\\.codex\\sessions\\x.jsonl', ...base });
    assert.equal(result.ok, false, type);
    assert.match(result.reason, /forbidden field: transcript_path/, type);
  }
});

test('schema: non-numeric native_process_pid is rejected', () => {
  const result = validateCodexAgentEvent({ hook_event_name: 'SessionStart', session_id: 'abc', source: 'startup', native_process_pid: 'not-a-pid', timestamp: 't' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /native_process_pid must be numeric/);
});

test('schema: valid SessionEnd passes and persists the actual reason value verbatim, never assumed richer', () => {
  const result = validateCodexAgentEvent({ hook_event_name: 'SessionEnd', session_id: 'abc', reason: 'other', native_process_pid: 1, timestamp: 't' });
  assert.equal(result.ok, true);
  assert.equal(result.value.reason, 'other');
});

test('schema: valid Stop passes with only the narrow common fields', () => {
  const result = validateCodexAgentEvent({ hook_event_name: 'Stop', session_id: 'abc', model: 'gpt-5-codex', native_process_pid: 1, timestamp: 't' });
  assert.equal(result.ok, true);
});

test('schema: not an object is rejected', () => {
  assert.equal(validateCodexAgentEvent('nope').ok, false);
  assert.equal(validateCodexAgentEvent(null).ok, false);
  assert.equal(validateCodexAgentEvent([1, 2]).ok, false);
});

// ---- normalizer.js ----------------------------------------------------------------------------

test('normalizer: SessionStart with source=startup -> AGENT_SESSION_STARTED', () => {
  const n = normalizeCodexAgentEvent({ hook_event_name: 'SessionStart', session_id: 's1', cwd: 'D:\\PROJECT-GUARDIAN', model: 'gpt-5-codex', source: 'startup', native_process_pid: 100, timestamp: 't0' });
  assert.equal(n.native_event, 'AGENT_SESSION_STARTED');
  assert.equal(n.cwd, 'D:\\PROJECT-GUARDIAN');
  assert.equal(n.native_metadata.start_source, 'startup');
  assert.equal(n.native_metadata.model, 'gpt-5-codex');
  assert.equal(n.agent, 'CODEX');
});

test('normalizer: SessionStart with source=resume -> AGENT_SESSION_RESUMED', () => {
  const n = normalizeCodexAgentEvent({ hook_event_name: 'SessionStart', session_id: 's1', source: 'resume', native_process_pid: 100, timestamp: 't0' });
  assert.equal(n.native_event, 'AGENT_SESSION_RESUMED');
});

test('normalizer: SessionEnd -> AGENT_SESSION_ENDED, cwd null (no native cwd-change event for Codex), reason carried verbatim', () => {
  const n = normalizeCodexAgentEvent({ hook_event_name: 'SessionEnd', session_id: 's1', reason: 'other', native_process_pid: 100, timestamp: 't2' });
  assert.equal(n.native_event, 'AGENT_SESSION_ENDED');
  assert.equal(n.cwd, null);
  assert.equal(n.native_metadata.end_reason, 'other');
});

test('normalizer: Stop -> AGENT_TURN_COMPLETED', () => {
  assert.equal(normalizeCodexAgentEvent({ hook_event_name: 'Stop', session_id: 's1', native_process_pid: 1, timestamp: 't' }).native_event, 'AGENT_TURN_COMPLETED');
});

// ---- discovery.js -----------------------------------------------------------------------------

test('discovery: configTomlHasHookDefinitions ignores [hooks.state] (trust bookkeeping, not hook definitions)', () => {
  const toml = `[hooks.state]\n\n[hooks.state.'C:\\x\\hooks.json:session_start:0:0']\ntrusted_hash = "sha256:abc"\n`;
  assert.equal(configTomlHasHookDefinitions(toml), false);
});

test('discovery: configTomlHasHookDefinitions detects a real [hooks.SessionStart]-style table', () => {
  const toml = `[hooks.SessionStart]\ncommand = "foo"\n`;
  assert.equal(configTomlHasHookDefinitions(toml), true);
});

test('discovery: detectCodex against this real machine reports installed=true with a real CODEX_HOME', () => {
  const detection = detectCodex();
  assert.equal(detection.installed, true);
  assert.match(detection.homeDir, /\.codex$/);
});
