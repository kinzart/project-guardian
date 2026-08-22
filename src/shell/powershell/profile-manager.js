// PowerShell-specific profile detection + install/uninstall/status/doctor logic, layered on the
// shell-agnostic block helpers in src/shell/installer.js. See SPEC_V0.5A.md section 7.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  START_MARKER,
  computeHash,
  hasBlock,
  hasDuplicateMarkers,
  extractBlock,
  insertOrReplaceBlock,
  removeBlock,
} from '../installer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const HOOK_PATH = path.join(__dirname, 'hook.ps1');

export const EDITIONS = {
  windowsPowerShell: { label: 'Windows PowerShell 5.1', exe: 'powershell.exe' },
  pwsh: { label: 'PowerShell 7+', exe: 'pwsh' },
};

function hookSnippet(hookPath) {
  // Only ever dot-sources the versioned hook.ps1 — the profile block itself never changes when
  // the hook's own logic is upgraded (see SPEC_V0.5A.md section 7).
  return `if (Test-Path "${hookPath}") { . "${hookPath}" }`;
}

function detectProfilePath(exe) {
  try {
    const out = execFileSync(exe, ['-NoProfile', '-NonInteractive', '-Command', '$PROFILE.CurrentUserCurrentHost'], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
    });
    const p = out.trim();
    return p || null;
  } catch {
    return null;
  }
}

export function detectInstallations() {
  const result = {};
  for (const [key, edition] of Object.entries(EDITIONS)) {
    const profilePath = detectProfilePath(edition.exe);
    result[key] = { ...edition, detected: profilePath !== null, profilePath };
  }
  return result;
}

export function readHookVersion() {
  try {
    const text = readFileSync(HOOK_PATH, 'utf8');
    const m = text.match(/#\s*Guardian Shell Hook\s+v(\S+)/i);
    return m ? m[1] : 'unknown';
  } catch {
    return null;
  }
}

function backupPathFor(backupDir, profilePath) {
  const base = path.basename(profilePath).replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(backupDir, `${base}.${Date.now()}.bak`);
}

// install: idempotent by construction (insertOrReplaceBlock never appends a second copy).
// Always backs up the pre-install content first.
export function install({ profilePath, backupDir, hookPath = HOOK_PATH }) {
  mkdirSync(path.dirname(profilePath), { recursive: true });
  mkdirSync(backupDir, { recursive: true });

  const existing = existsSync(profilePath) ? readFileSync(profilePath, 'utf8') : '';
  const beforeHash = computeHash(existing);
  const backupPath = backupPathFor(backupDir, profilePath);
  writeFileSync(backupPath, existing);

  const updated = insertOrReplaceBlock(existing, hookSnippet(hookPath));
  writeFileSync(profilePath, updated);

  return {
    profilePath,
    backupPath,
    beforeHash,
    afterHash: computeHash(updated),
    alreadyInstalled: hasBlock(existing),
  };
}

// uninstall: removes ONLY the marked block. Refuses (rather than guessing) if the file doesn't
// exist or has no Guardian block to remove.
export function uninstall({ profilePath, backupDir }) {
  if (!existsSync(profilePath)) return { removed: false, reason: 'profile does not exist' };
  const existing = readFileSync(profilePath, 'utf8');
  if (!hasBlock(existing)) return { removed: false, reason: 'no Guardian block present' };

  mkdirSync(backupDir, { recursive: true });
  const backupPath = backupPathFor(backupDir, profilePath);
  writeFileSync(backupPath, existing);

  const updated = removeBlock(existing);
  writeFileSync(profilePath, updated);
  return { removed: true, backupPath, afterHash: computeHash(updated) };
}

// restore: only proceeds when we can prove the CURRENT block is exactly what Guardian itself
// last installed (same block content) — otherwise a user edit could be silently discarded, so
// this refuses and explains instead.
export function restore({ profilePath, lastInstalledBlockHash }) {
  if (!existsSync(profilePath)) return { restored: false, reason: 'profile does not exist' };
  const existing = readFileSync(profilePath, 'utf8');
  const currentBlock = extractBlock(existing);
  if (!currentBlock) return { restored: false, reason: 'no Guardian block present to restore' };
  if (!lastInstalledBlockHash) return { restored: false, reason: 'no known prior install to restore to — refusing to guess' };
  if (computeHash(currentBlock) !== lastInstalledBlockHash) {
    return { restored: false, reason: 'current Guardian block differs from what Guardian last installed — refusing to overwrite a possible manual edit' };
  }
  return { restored: true, reason: 'current block already matches last install; nothing to do' };
}

// Tiny durable record of "what Guardian itself last installed" per edition, so `restore` can
// prove it's safe (current block hash still matches) instead of guessing. Deliberately not part
// of the main Store — this is install-time metadata, not observed/operational data.
export function readInstallState(dataDir) {
  const p = path.join(dataDir, 'shell-install-state.json');
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

export function writeInstallState(dataDir, state) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, 'shell-install-state.json'), JSON.stringify(state, null, 2));
}

export function doctor({ profilePath }) {
  const checks = { profileFound: false, parseable: false, blockPresent: false, blockIntact: false, duplicateMarkers: false, encodingOk: true };
  if (!existsSync(profilePath)) return checks;
  checks.profileFound = true;
  let content;
  try {
    content = readFileSync(profilePath, 'utf8');
    checks.parseable = true;
  } catch {
    return checks;
  }
  checks.duplicateMarkers = hasDuplicateMarkers(content);
  checks.blockPresent = hasBlock(content) && !checks.duplicateMarkers;
  checks.blockIntact = checks.blockPresent && content.indexOf(START_MARKER) < content.indexOf('# <<< PROJECT GUARDIAN SHELL HOOK <<<');
  checks.encodingOk = !content.includes('�'); // replacement character = a decode problem
  return checks;
}
