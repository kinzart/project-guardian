// MSYS/Cygwin POSIX-style path -> Windows path — see SPEC_V0.5B.md section 4. The hook itself
// uses `pwd -W` to send an already-Windows-style path; this is a defensive fallback so the
// deepest-root project resolver works identically even if a raw POSIX path ever reaches the
// pipe (e.g. a future/alternate MSYS-family shell hook, or `pwd -W` being unavailable).

// Handles both real-world shapes the hook can produce: `pwd -W`'s forward-slash Windows path
// (e.g. "D:/PROJECT-GUARDIAN" — the normal case, no escaping games needed in bash for JSON) and,
// defensively, a raw POSIX MSYS path (e.g. "/d/PROJECT-GUARDIAN") if `pwd -W` were ever
// unavailable. Both become the same canonical backslash form; anything else (relative path,
// already-Windows-backslash, unrecognized) passes through unchanged.
const WINDOWS_FORWARD_SLASH = /^([a-zA-Z]):(\/.*)?$/;
const POSIX_DRIVE_PATH = /^\/([a-zA-Z])(\/.*)?$/;

export function normalizeGitBashPath(p) {
  if (typeof p !== 'string' || !p) return p;

  let m = p.match(WINDOWS_FORWARD_SLASH);
  if (m) {
    const drive = m[1].toUpperCase();
    const rest = (m[2] || '').replace(/\//g, '\\');
    return `${drive}:${rest || '\\'}`;
  }

  m = p.match(POSIX_DRIVE_PATH);
  if (m) {
    const drive = m[1].toUpperCase();
    const rest = (m[2] || '').slice(1).replace(/\//g, '\\'); // drop the leading '/'
    return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
  }

  return p;
}
