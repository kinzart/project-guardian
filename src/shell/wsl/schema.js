// Strict schema for WSL shell events — see SPEC_V0.5C.md section 3. A deliberately SEPARATE
// validator from src/shell/schema.js (V0.5A/B): the field set is entirely different
// (linux_pid/distro/cwd_linux, no pid/host_name/cwd), so widening the existing schema into a
// union would blur what each event type actually means and risk loosening the already-hardened
// PowerShell/Git Bash validation. src/shell/schema.js is completely untouched by this file.

const ALLOWED_FIELDS = {
  SHELL_STARTED: [
    'type',
    'shell_session_id',
    'shell_type',
    'distro',
    'wsl_version',
    'linux_pid',
    'linux_parent_pid',
    'bash_version',
    'cwd_linux',
    'cwd_project_identity',
    'timestamp',
  ],
  CWD_CHANGED: ['type', 'shell_session_id', 'distro', 'linux_pid', 'cwd_linux', 'cwd_project_identity', 'timestamp'],
  SHELL_EXITING: ['type', 'shell_session_id', 'distro', 'linux_pid', 'timestamp'],
  // Piggybacked on PROMPT_COMMAND, at most once per heartbeatIntervalMs — see SPEC_V0.5C.md
  // section 7. Never carries cwd — a heartbeat is purely "this session is still alive".
  HEARTBEAT: ['type', 'shell_session_id', 'linux_pid', 'timestamp'],
};

const REQUIRED_FIELDS = {
  SHELL_STARTED: ['shell_session_id', 'shell_type', 'distro', 'wsl_version', 'linux_pid', 'bash_version', 'cwd_linux', 'timestamp'],
  CWD_CHANGED: ['shell_session_id', 'distro', 'linux_pid', 'cwd_linux', 'timestamp'],
  SHELL_EXITING: ['shell_session_id', 'distro', 'linux_pid', 'timestamp'],
  HEARTBEAT: ['shell_session_id', 'linux_pid', 'timestamp'],
};

// Same deny-list philosophy as src/shell/schema.js, extended with the WSL-specific things this
// phase explicitly calls out as never-to-capture (BASH_COMMAND, env, WSLENV, SSH_AUTH_SOCK).
const FORBIDDEN_FIELD_NAMES = new Set([
  'command',
  'commandline',
  'prompt',
  'stdout',
  'stderr',
  'history',
  'bash_command',
  'env',
  'wslenv',
  'ssh_auth_sock',
  'token',
  'secret',
  'password',
  'api_key',
]);

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

export function validateWslShellEvent(raw) {
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
  if (!Number.isFinite(Number(raw.linux_pid))) return { ok: false, reason: 'linux_pid must be numeric' };
  if (!isNonEmptyString(raw.timestamp)) return { ok: false, reason: 'timestamp must be a non-empty string' };
  if ('distro' in raw && !isNonEmptyString(raw.distro)) return { ok: false, reason: 'distro must be a non-empty string' };
  if ('cwd_linux' in raw && !isNonEmptyString(raw.cwd_linux)) return { ok: false, reason: 'cwd_linux must be a non-empty string' };
  if ('linux_parent_pid' in raw && raw.linux_parent_pid !== null && !Number.isFinite(Number(raw.linux_parent_pid))) {
    return { ok: false, reason: 'linux_parent_pid must be numeric or null' };
  }
  if (type === 'SHELL_STARTED' && raw.shell_type !== 'WSL_BASH') {
    return { ok: false, reason: 'shell_type must be WSL_BASH' };
  }

  const value = {};
  for (const key of allowed) if (key in raw) value[key] = raw[key];
  value.linux_pid = Number(value.linux_pid);
  if ('linux_parent_pid' in value) value.linux_parent_pid = value.linux_parent_pid == null ? null : Number(value.linux_parent_pid);

  return { ok: true, value };
}
