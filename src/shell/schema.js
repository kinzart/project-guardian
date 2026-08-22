// Strict schema for the three permitted shell IPC event types — see SPEC_V0.5A.md section 3.
// Anything else (unknown type, unexpected field, or a forbidden field) is REJECTED wholesale,
// never silently stripped-and-kept — reject-invalid is the explicit preference, not best-effort
// sanitization.

const ALLOWED_FIELDS = {
  SHELL_STARTED: ['type', 'shell_session_id', 'pid', 'parent_pid', 'shell_type', 'shell_version', 'host_name', 'cwd', 'timestamp'],
  CWD_CHANGED: ['type', 'shell_session_id', 'pid', 'cwd', 'timestamp'],
  SHELL_EXITING: ['type', 'shell_session_id', 'pid', 'timestamp'],
};

const REQUIRED_FIELDS = {
  SHELL_STARTED: ['shell_session_id', 'pid', 'shell_type', 'shell_version', 'host_name', 'cwd', 'timestamp'],
  CWD_CHANGED: ['shell_session_id', 'pid', 'cwd', 'timestamp'],
  SHELL_EXITING: ['shell_session_id', 'pid', 'timestamp'],
};

// Names that must never appear as a field, on any event, regardless of type — checked before
// the per-type allow-list so a forbidden field always produces the same explicit rejection
// reason rather than a generic "unexpected field".
const FORBIDDEN_FIELD_NAMES = new Set(['command', 'commandline', 'prompt', 'stdout', 'stderr', 'history', 'token', 'secret', 'password', 'api_key']);

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

export function validateShellEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not an object' };

  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_FIELD_NAMES.has(key.toLowerCase())) return { ok: false, reason: `forbidden field: ${key}` };
  }

  const type = raw.type;
  const allowed = ALLOWED_FIELDS[type];
  if (!allowed) return { ok: false, reason: `unknown event type: ${type}` };

  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) return { ok: false, reason: `unexpected field for ${type}: ${key}` };
  }

  for (const field of REQUIRED_FIELDS[type]) {
    if (raw[field] === undefined || raw[field] === null) return { ok: false, reason: `missing required field: ${field}` };
  }
  if (!isNonEmptyString(raw.shell_session_id)) return { ok: false, reason: 'shell_session_id must be a non-empty string' };
  if (!Number.isFinite(Number(raw.pid))) return { ok: false, reason: 'pid must be numeric' };
  if (!isNonEmptyString(raw.timestamp)) return { ok: false, reason: 'timestamp must be a non-empty string' };
  if ('cwd' in raw && !isNonEmptyString(raw.cwd)) return { ok: false, reason: 'cwd must be a non-empty string' };
  if ('parent_pid' in raw && raw.parent_pid !== null && !Number.isFinite(Number(raw.parent_pid))) {
    return { ok: false, reason: 'parent_pid must be numeric or null' };
  }

  // Only ever carry forward whitelisted fields — defense in depth even if something upstream
  // ever let an extra key slip past the checks above.
  const value = {};
  for (const key of allowed) if (key in raw) value[key] = raw[key];
  value.pid = Number(value.pid);
  if ('parent_pid' in value) value.parent_pid = value.parent_pid == null ? null : Number(value.parent_pid);

  return { ok: true, value };
}
