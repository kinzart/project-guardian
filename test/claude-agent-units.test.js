import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateClaudeAgentEvent } from '../src/agent/claude/schema.js';
import { normalizeClaudeAgentEvent } from '../src/agent/claude/normalizer.js';

// ---- schema.js -------------------------------------------------------------------------------

test('schema: valid SessionStart passes and is whitelisted', () => {
  const result = validateClaudeAgentEvent({
    hook_event_name: 'SessionStart',
    session_id: 'abc123',
    cwd: 'D:\\PROJECT-GUARDIAN',
    source: 'startup',
    native_process_pid: 4242,
    timestamp: '2026-08-20T10:00:00.000Z',
    hook_version: '1.0.0',
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.session_id, 'abc123');
  assert.equal(result.value.native_process_pid, 4242);
});

test('schema: SessionStart without cwd is still valid (cwd optional)', () => {
  const result = validateClaudeAgentEvent({
    hook_event_name: 'SessionStart',
    session_id: 'abc123',
    source: 'startup',
    native_process_pid: 4242,
    timestamp: '2026-08-20T10:00:00.000Z',
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.cwd, undefined);
});

test('schema: missing required field is rejected', () => {
  const result = validateClaudeAgentEvent({ hook_event_name: 'SessionStart', session_id: 'abc123', native_process_pid: 1, timestamp: 't' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /missing required field: source/);
});

test('schema: unknown hook_event_name is rejected (defensive — Guardian never subscribes to it)', () => {
  const result = validateClaudeAgentEvent({ hook_event_name: 'PreToolUse', session_id: 'abc', native_process_pid: 1, timestamp: 't' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /unknown or unsubscribed/);
});

test('schema: unexpected field for the event type is rejected', () => {
  const result = validateClaudeAgentEvent({ hook_event_name: 'SessionEnd', session_id: 'abc', reason: 'clear', native_process_pid: 1, timestamp: 't', cwd: 'x' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /unexpected field for SessionEnd: cwd/);
});

const FORBIDDEN_PROBES = ['prompt', 'transcript_path', 'tool_input', 'tool_response', 'last_assistant_message', 'background_tasks', 'permission_mode', 'agent_id', 'message', 'reasoning'];
for (const field of FORBIDDEN_PROBES) {
  test(`schema: forbidden field "${field}" is rejected even if it looks harmless`, () => {
    const result = validateClaudeAgentEvent({ hook_event_name: 'SessionStart', session_id: 'abc', source: 'startup', native_process_pid: 1, timestamp: 't', [field]: 'anything' });
    assert.equal(result.ok, false);
    assert.match(result.reason, /forbidden field/);
  });
}

test('schema: non-numeric native_process_pid is rejected', () => {
  const result = validateClaudeAgentEvent({ hook_event_name: 'SessionStart', session_id: 'abc', source: 'startup', native_process_pid: 'not-a-pid', timestamp: 't' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /native_process_pid must be numeric/);
});

test('schema: unrecognized SessionStart source is rejected', () => {
  const result = validateClaudeAgentEvent({ hook_event_name: 'SessionStart', session_id: 'abc', source: 'teleport', native_process_pid: 1, timestamp: 't' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /unrecognized SessionStart source/);
});

test('schema: unrecognized SessionEnd reason is rejected', () => {
  const result = validateClaudeAgentEvent({ hook_event_name: 'SessionEnd', session_id: 'abc', reason: 'teleported', native_process_pid: 1, timestamp: 't' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /unrecognized SessionEnd reason/);
});

test('schema: valid CwdChanged passes', () => {
  const result = validateClaudeAgentEvent({ hook_event_name: 'CwdChanged', session_id: 'abc', old_cwd: 'D:\\old', new_cwd: 'D:\\PROJECT-GUARDIAN', native_process_pid: 1, timestamp: 't' });
  assert.equal(result.ok, true);
  assert.equal(result.value.new_cwd, 'D:\\PROJECT-GUARDIAN');
});

test('schema: valid Stop/StopFailure pass with only the narrow common fields', () => {
  for (const type of ['Stop', 'StopFailure']) {
    const result = validateClaudeAgentEvent({ hook_event_name: type, session_id: 'abc', native_process_pid: 1, timestamp: 't' });
    assert.equal(result.ok, true, type);
  }
});

test('schema: not an object is rejected', () => {
  assert.equal(validateClaudeAgentEvent('nope').ok, false);
  assert.equal(validateClaudeAgentEvent(null).ok, false);
  assert.equal(validateClaudeAgentEvent([1, 2]).ok, false);
});

// ---- normalizer.js ----------------------------------------------------------------------------

test('normalizer: SessionStart with source=startup -> AGENT_SESSION_STARTED', () => {
  const n = normalizeClaudeAgentEvent({ hook_event_name: 'SessionStart', session_id: 's1', cwd: 'D:\\PROJECT-GUARDIAN', source: 'startup', native_process_pid: 100, timestamp: 't0' });
  assert.equal(n.native_event, 'AGENT_SESSION_STARTED');
  assert.equal(n.cwd, 'D:\\PROJECT-GUARDIAN');
  assert.equal(n.native_metadata.start_source, 'startup');
  assert.equal(n.agent, 'CLAUDE_CODE');
});

test('normalizer: SessionStart with source=resume -> AGENT_SESSION_RESUMED', () => {
  const n = normalizeClaudeAgentEvent({ hook_event_name: 'SessionStart', session_id: 's1', source: 'resume', native_process_pid: 100, timestamp: 't0' });
  assert.equal(n.native_event, 'AGENT_SESSION_RESUMED');
});

test('normalizer: CwdChanged -> AGENT_CWD_CHANGED, cwd = new_cwd', () => {
  const n = normalizeClaudeAgentEvent({ hook_event_name: 'CwdChanged', session_id: 's1', old_cwd: 'D:\\a', new_cwd: 'D:\\b', native_process_pid: 100, timestamp: 't1' });
  assert.equal(n.native_event, 'AGENT_CWD_CHANGED');
  assert.equal(n.cwd, 'D:\\b');
});

test('normalizer: SessionEnd -> AGENT_SESSION_ENDED, cwd null, end_reason carried', () => {
  const n = normalizeClaudeAgentEvent({ hook_event_name: 'SessionEnd', session_id: 's1', reason: 'clear', native_process_pid: 100, timestamp: 't2' });
  assert.equal(n.native_event, 'AGENT_SESSION_ENDED');
  assert.equal(n.cwd, null);
  assert.equal(n.native_metadata.end_reason, 'clear');
});

test('normalizer: Stop -> AGENT_TURN_COMPLETED, StopFailure -> AGENT_TURN_FAILED', () => {
  assert.equal(normalizeClaudeAgentEvent({ hook_event_name: 'Stop', session_id: 's1', native_process_pid: 1, timestamp: 't' }).native_event, 'AGENT_TURN_COMPLETED');
  assert.equal(normalizeClaudeAgentEvent({ hook_event_name: 'StopFailure', session_id: 's1', native_process_pid: 1, timestamp: 't' }).native_event, 'AGENT_TURN_FAILED');
});
