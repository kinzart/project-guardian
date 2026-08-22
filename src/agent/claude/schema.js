// Strict whitelist schema for events arriving from the Guardian Claude hook script (hook.mjs) —
// see SPEC_V0.6A.md "Strict input sanitization" and "Hook events allowed in this phase". Two
// layers of defense: hook.mjs itself only ever forwards a handful of fields, and this validator
// re-checks that independently (unexpected/forbidden fields are rejected, not merely ignored) so
// a bug in an older/different hook build can never leak conversation content into the store.

const ALLOWED_FIELDS = {
  SessionStart: ['hook_event_name', 'session_id', 'cwd', 'source', 'native_process_pid', 'timestamp', 'hook_version'],
  CwdChanged: ['hook_event_name', 'session_id', 'old_cwd', 'new_cwd', 'native_process_pid', 'timestamp', 'hook_version'],
  SessionEnd: ['hook_event_name', 'session_id', 'reason', 'native_process_pid', 'timestamp', 'hook_version'],
  // Optional per SPEC_V0.6A.md "Hook events allowed in this phase" — TURN_ACTIVITY markers only,
  // payload strictly reduced to metadata (no last_assistant_message/background_tasks/etc; these
  // are never even in the allow-list, so they are rejected outright if a raw payload has them).
  Stop: ['hook_event_name', 'session_id', 'native_process_pid', 'timestamp', 'hook_version'],
  StopFailure: ['hook_event_name', 'session_id', 'native_process_pid', 'timestamp', 'hook_version'],
};

const REQUIRED_FIELDS = {
  SessionStart: ['session_id', 'source', 'native_process_pid', 'timestamp'],
  CwdChanged: ['session_id', 'new_cwd', 'native_process_pid', 'timestamp'],
  SessionEnd: ['session_id', 'reason', 'native_process_pid', 'timestamp'],
  Stop: ['session_id', 'native_process_pid', 'timestamp'],
  StopFailure: ['session_id', 'native_process_pid', 'timestamp'],
};

// Never persisted, under any hook_event_name — conversation content, tool I/O, or anything that
// could carry it. Checked BEFORE the per-type allow-list so an unknown future field with one of
// these names is rejected even for an event type not listed above. See SPEC_V0.6A.md "Important
// privacy rule".
const FORBIDDEN_FIELD_NAMES = new Set([
  'prompt',
  'prompt_id',
  'transcript_path',
  'tool_name',
  'tool_input',
  'tool_response',
  'tool_use_id',
  'last_assistant_message',
  'background_tasks',
  'session_crons',
  'stop_hook_active',
  'permission_mode',
  'agent_id',
  'agent_type',
  'effort',
  'message',
  'assistant',
  'response',
  'content',
  'error',
  'reasoning',
  'command',
  'commandline',
  'stdout',
  'stderr',
  'history',
  'token',
  'secret',
  'password',
  'api_key',
]);

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

export function validateClaudeAgentEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not an object' };

  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_FIELD_NAMES.has(key.toLowerCase())) return { ok: false, reason: `forbidden field: ${key}` };
  }

  const type = raw.hook_event_name;
  const allowed = ALLOWED_FIELDS[type];
  if (!allowed) return { ok: false, reason: `unknown or unsubscribed hook_event_name: ${type}` };

  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) return { ok: false, reason: `unexpected field for ${type}: ${key}` };
  }

  for (const field of REQUIRED_FIELDS[type]) {
    if (raw[field] === undefined || raw[field] === null) return { ok: false, reason: `missing required field: ${field}` };
  }
  if (!isNonEmptyString(raw.session_id)) return { ok: false, reason: 'session_id must be a non-empty string' };
  if (!isNonEmptyString(raw.timestamp)) return { ok: false, reason: 'timestamp must be a non-empty string' };
  if (!Number.isFinite(Number(raw.native_process_pid))) return { ok: false, reason: 'native_process_pid must be numeric' };
  if ('cwd' in raw && raw.cwd !== null && !isNonEmptyString(raw.cwd)) return { ok: false, reason: 'cwd must be a non-empty string or null' };
  if ('new_cwd' in raw && !isNonEmptyString(raw.new_cwd)) return { ok: false, reason: 'new_cwd must be a non-empty string' };
  if (type === 'SessionStart' && !['startup', 'resume', 'clear', 'compact', 'fork'].includes(raw.source)) {
    return { ok: false, reason: `unrecognized SessionStart source: ${raw.source}` };
  }
  if (type === 'SessionEnd' && !['clear', 'logout', 'prompt_input_exit', 'other'].includes(raw.reason)) {
    return { ok: false, reason: `unrecognized SessionEnd reason: ${raw.reason}` };
  }

  const value = {};
  for (const key of allowed) if (key in raw) value[key] = raw[key];
  value.native_process_pid = Number(value.native_process_pid);

  return { ok: true, value };
}
