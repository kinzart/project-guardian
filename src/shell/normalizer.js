// Validated raw shell event -> internal normalized shape, with provenance attached. See
// SPEC_V0.5A.md section 3/10 and SPEC_V0.5B.md section 4.

import { normalizeGitBashPath } from './gitbash/path-normalizer.js';

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// The schema (V0.5A, unchanged) doesn't carry an explicit "which hook sent this" field, so
// provenance is derived from shell_type's shape — PowerShell reports $PSVersionTable.PSEdition
// ("Desktop"/"Core"), the V0.5B Git Bash hook reports "bash". Kept as distinct known values
// rather than one generic string so `guardian explain`/evidence text stays specific; an
// unrecognized shell_type still degrades to a generic value rather than guessing.
function classifySource(shellType) {
  if (shellType === 'Desktop' || shellType === 'Core') return 'POWERSHELL_HOOK';
  if (shellType === 'bash') return 'GITBASH_HOOK';
  return 'SHELL_HOOK';
}

export function normalizeShellEvent(validated) {
  return {
    id: newId(),
    type: validated.type,
    shell_session_id: validated.shell_session_id,
    pid: validated.pid,
    parent_pid: validated.parent_pid ?? null,
    shell_type: validated.shell_type ?? null,
    shell_version: validated.shell_version ?? null,
    host_name: validated.host_name ?? null,
    // Defensive normalization (see SPEC_V0.5B.md section 4) — a no-op for anything already
    // Windows-style (PowerShell always sends that), only rewrites a raw POSIX drive path.
    cwd: validated.cwd ? normalizeGitBashPath(validated.cwd) : null,
    timestamp: validated.timestamp,
    received_at: new Date().toISOString(),
    source: classifySource(validated.shell_type),
  };
}
