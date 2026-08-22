// Generic marker-delimited block install/uninstall for any shell profile/rc file — see
// SPEC_V0.5A.md section 7. Shell-agnostic on purpose: PowerShell is the only caller today
// (src/shell/powershell/profile-manager.js), but nothing here is PowerShell-specific.

import crypto from 'node:crypto';

export const START_MARKER = '# >>> PROJECT GUARDIAN SHELL HOOK >>>';
export const END_MARKER = '# <<< PROJECT GUARDIAN SHELL HOOK <<<';

export function computeHash(content) {
  return crypto.createHash('sha256').update(content ?? '', 'utf8').digest('hex');
}

export function buildBlock(hookSnippet) {
  return `${START_MARKER}\n${hookSnippet.trim()}\n${END_MARKER}`;
}

export function hasBlock(content) {
  return content.includes(START_MARKER) && content.includes(END_MARKER);
}

// True when the same marker appears more than once — a corrupted/hand-edited profile, never
// silently "fixed" by this module (see profile-manager.js's doctor, which only reports it).
export function hasDuplicateMarkers(content) {
  const starts = content.split(START_MARKER).length - 1;
  const ends = content.split(END_MARKER).length - 1;
  return starts > 1 || ends > 1;
}

export function extractBlock(content) {
  const startIdx = content.indexOf(START_MARKER);
  const endIdx = content.indexOf(END_MARKER);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return null;
  return content.slice(startIdx, endIdx + END_MARKER.length);
}

// Inserts the block, or replaces an existing one in place — replacing (never appending a second
// copy) is what makes running install twice idempotent by construction.
export function insertOrReplaceBlock(content, hookSnippet) {
  const block = buildBlock(hookSnippet);
  if (hasBlock(content)) {
    const startIdx = content.indexOf(START_MARKER);
    const endIdx = content.indexOf(END_MARKER) + END_MARKER.length;
    return content.slice(0, startIdx) + block + content.slice(endIdx);
  }
  const sep = content.length && !content.endsWith('\n') ? '\n\n' : content.length ? '\n' : '';
  return `${content}${sep}${block}\n`;
}

// Removes only the marked block — everything else in the file is untouched, byte for byte.
export function removeBlock(content) {
  if (!hasBlock(content)) return content;
  const startIdx = content.indexOf(START_MARKER);
  const endIdx = content.indexOf(END_MARKER) + END_MARKER.length;
  const before = content.slice(0, startIdx);
  const after = content.slice(endIdx);
  // Collapse the blank-line separation insertOrReplaceBlock added, without touching any blank
  // lines that were already part of the user's own content elsewhere in the file.
  return (before.replace(/\n{1,2}$/, '\n') + after.replace(/^\n{1,2}/, '')).replace(/^\n+/, '');
}
