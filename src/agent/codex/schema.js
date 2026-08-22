// Strict whitelist schema for events arriving from the Guardian Codex hook script (hook.mjs) —
// see SPEC_V0.6B.md sections 1 and 6. Same two-layer defense as src/agent/claude/schema.js: the
// hook adapter itself only ever forwards a handful of fields, and this validator re-checks that
// independently.

const ALLOWED_FIELDS = {
  SessionStart: ['hook_event_name', 'session_id', 'cwd', 'model', 'source', 'native_process_pid', 'timestamp', 'hook_version'],
  SessionEnd: ['hook_event_name', 'session_id', 'cwd', 'model', 'reason', 'native_process_pid', 'timestamp', 'hook_version'],
  // Optional per SPEC_V0.6B.md — TURN_ACTIVITY marker only, same metadata-only treatment as
  // Claude's Stop hook.
  Stop: ['hook_event_name', 'session_id', 'model', 'native_process_pid', 'timestamp', 'hook_version'],
};

const REQUIRED_FIELDS = {
  SessionStart: ['session_id', 'source', 'native_process_pid', 'timestamp'],
  SessionEnd: ['session_id', 'reason', 'native_process_pid', 'timestamp'],
  Stop: ['session_id', 'native_process_pid', 'timestamp'],
};

// Never persisted, regardless of hook_event_name. transcript_path is explicitly here even though
// Codex's real common payload includes it on every event — see SPEC_V0.6B.md's "DO NOT OPEN IT.
// DO NOT PARSE IT. DO NOT COPY IT." rule. permission_mode is a real Codex common-payload field
// too, but is outside Guardian's remit this phase (never in ALLOWED_FIELDS above either).
const FORBIDDEN_FIELD_NAMES = new Set([
  'prompt',
  'transcript_path',
  'tool_name',
  'tool_input',
  'tool_response',
  'tool_use_id',
  'turn_id',
  'last_assistant_message',
  'permission_mode',
  'additionalcontext',
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
  'conversation',
  'token',
  'secret',
  'password',
  'api_key',
]);

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

export function validateCodexAgentEvent(raw) {
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
  // source/reason are persisted as-observed rather than validated against a closed enum — see
  // SPEC_V0.6B.md: "Do not hardcode beyond documented/observed values" / "do not pretend this
  // reason is semantically richer" — Codex may add values in a future version without warning.
  if (type === 'SessionStart' && !isNonEmptyString(raw.source)) return { ok: false, reason: 'source must be a non-empty string' };
  if (type === 'SessionEnd' && !isNonEmptyString(raw.reason)) return { ok: false, reason: 'reason must be a non-empty string' };

  const value = {};
  for (const key of allowed) if (key in raw) value[key] = raw[key];
  value.native_process_pid = Number(value.native_process_pid);

  return { ok: true, value };
}
