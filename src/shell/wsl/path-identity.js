// Two path namespaces, never conflated — see SPEC_V0.5C.md section 5. The hook determines which
// one applies by trying `wslpath -w` itself (never assumes an automount root like `/mnt/`): if
// it succeeds, the CWD is Windows-backed; if it fails, the CWD is WSL-native with no Windows
// equivalent at all. This module only encodes/decodes/resolves the result — it never re-derives
// automount assumptions on the Node side.

import { resolveProjectForPath } from '../../process/project-correlator.js';

// A single string field (matches SPEC_V0.5C.md's schema — cwd_project_identity is one field, not
// a nested object) — "windows:<path>" or "wsl:<distro>:<linuxPath>".
export function encodeProjectIdentity(identity) {
  if (!identity) return null;
  if (identity.namespace === 'WINDOWS') return `windows:${identity.windowsPath}`;
  if (identity.namespace === 'WSL') return `wsl:${identity.distro}:${identity.linuxPath}`;
  return null;
}

export function parseProjectIdentity(value) {
  if (typeof value !== 'string' || !value) return null;
  if (value.startsWith('windows:')) {
    const windowsPath = value.slice('windows:'.length);
    return windowsPath ? { namespace: 'WINDOWS', windowsPath } : null;
  }
  if (value.startsWith('wsl:')) {
    const rest = value.slice('wsl:'.length);
    const sep = rest.indexOf(':');
    if (sep <= 0) return null;
    const distro = rest.slice(0, sep);
    const linuxPath = rest.slice(sep + 1);
    return distro && linuxPath ? { namespace: 'WSL', distro, linuxPath } : null;
  }
  return null;
}

// Windows-backed: resolves against the existing Windows inventory exactly like a Git Bash
// session (same deepest-root resolver, reused as-is — HIGH confidence when it matches).
// WSL-native: Guardian's discovery is Windows-filesystem-only in this phase (see SPEC_V0.5C.md
// section 5) — there is no native WSL project inventory to check yet, so this is honestly null
// (UNKNOWN) rather than inventing a project because a shell cd'd there. wslScanRoots is accepted
// for forward compatibility with a future native `guardian scan --wsl` but is intentionally
// unused for resolution here.
export function resolveWslProject(identityValue, projects, wslScanRoots = {}) {
  const identity = typeof identityValue === 'string' ? parseProjectIdentity(identityValue) : identityValue;
  if (!identity) return null;
  if (identity.namespace === 'WINDOWS') return resolveProjectForPath(identity.windowsPath, projects);
  void wslScanRoots; // reserved for V0.5C.1
  return null;
}
