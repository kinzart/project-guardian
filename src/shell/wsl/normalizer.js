// Validated WSL event -> internal shape. Deliberately maps onto the SAME shape V0.5A/B's
// normalizeShellEvent produces (pid/parent_pid/cwd/shell_type/shell_version/host_name) so the
// existing display/CLI code paths work unchanged — but linux_pid/linux_parent_pid are NEVER the
// same identity space as a real Windows PID (see SPEC_V0.5C.md section 2), so callers must never
// feed a WSL session's `pid` into the Windows-process-observer correlator's shellRegistry. That
// separation is enforced structurally in src/shell/wsl/observer.js (its own registry instance,
// never shared with process/observer.js), not by convention here.

import { parseProjectIdentity } from './path-identity.js';

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeWslShellEvent(validated) {
  const identity = validated.cwd_project_identity ? parseProjectIdentity(validated.cwd_project_identity) : null;
  // Only a Windows-backed CWD has a meaningful "cwd" in the same sense V0.5A/B use it (a path
  // resolvable against the Windows inventory). A WSL-native CWD has no Windows equivalent at all
  // — cwd stays null there (never fabricate a fake drive path), distro/cwd_linux still preserved.
  const cwd = identity?.namespace === 'WINDOWS' ? identity.windowsPath : null;

  return {
    id: newId(),
    type: validated.type,
    shell_session_id: validated.shell_session_id,
    pid: validated.linux_pid,
    parent_pid: validated.linux_parent_pid ?? null,
    shell_type: 'WSL_BASH',
    shell_version: validated.bash_version ?? null,
    host_name: validated.distro ?? null,
    cwd,
    distro: validated.distro ?? null,
    cwd_linux: validated.cwd_linux ?? null,
    wsl_version: validated.wsl_version ?? null,
    timestamp: validated.timestamp,
    received_at: new Date().toISOString(),
    source: 'WSL_HOOK',
  };
}
