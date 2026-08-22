// Git Bash detection + install/uninstall/restore/doctor for BOTH ~/.bashrc and
// ~/.bash_profile — see SPEC_V0.5B.md section 1 for why both: git-bash.exe's real invocation
// (`bash --login -i`) only sources .bash_profile, while some other "Git Bash" terminal
// integrations invoke plain `bash -i`, which only sources .bashrc. Confirmed empirically on this
// machine (neither file existed beforehand) rather than assumed.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
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
export const HOOK_PATH = path.join(__dirname, 'hook.sh');

export const STARTUP_FILES = {
  bashrc: { label: '.bashrc (non-login interactive)' },
  bashProfile: { label: '.bash_profile (login interactive — git-bash.exe\'s real invocation)' },
};

function hookSnippet(hookPath) {
  // Only ever sources the versioned hook.sh — the marker block itself never changes when the
  // hook's own logic is upgraded (same idiom as the PowerShell installer).
  return `if [ -f "${hookPath}" ]; then source "${hookPath}"; fi`;
}

function detectBashExe() {
  try {
    const out = execFileSync('where', ['bash'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    const first = out.split(/\r?\n/).find((l) => l.trim());
    return first ? first.trim() : null;
  } catch {
    return null;
  }
}

// Real HOME on Windows Git Bash is the converted form of USERPROFILE — os.homedir() already
// gives the same Windows-style directory bash's $HOME resolves to, no need to shell out to bash
// just to find it.
export function detectInstallations() {
  const bashExe = detectBashExe();
  const home = os.homedir();
  const result = {};
  for (const [key, meta] of Object.entries(STARTUP_FILES)) {
    const fileName = key === 'bashrc' ? '.bashrc' : '.bash_profile';
    result[key] = { ...meta, detected: bashExe !== null, profilePath: path.join(home, fileName) };
  }
  return { bashExe, files: result };
}

export function readHookVersion() {
  try {
    const text = readFileSync(HOOK_PATH, 'utf8');
    const m = text.match(/#\s*Guardian Git Bash Hook\s+v(\S+)/i);
    return m ? m[1] : 'unknown';
  } catch {
    return null;
  }
}

function backupPathFor(backupDir, profilePath) {
  const base = path.basename(profilePath).replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(backupDir, `${base}.${Date.now()}.bak`);
}

// Converts a Windows path (e.g. "D:\PROJECT-GUARDIAN\...\hook.sh") to the POSIX form bash
// expects inside a sourced script path ("/d/PROJECT-GUARDIAN/.../hook.sh") — the hook file itself
// lives inside this repo, wherever that happens to be checked out.
function toPosixPath(windowsPath) {
  const m = windowsPath.match(/^([a-zA-Z]):(.*)$/);
  if (!m) return windowsPath.replace(/\\/g, '/');
  return `/${m[1].toLowerCase()}${m[2].replace(/\\/g, '/')}`;
}

export function install({ profilePath, backupDir, hookPath = HOOK_PATH }) {
  mkdirSync(path.dirname(profilePath), { recursive: true });
  mkdirSync(backupDir, { recursive: true });

  const existing = existsSync(profilePath) ? readFileSync(profilePath, 'utf8') : '';
  const beforeHash = computeHash(existing);
  const backupPath = backupPathFor(backupDir, profilePath);
  writeFileSync(backupPath, existing);

  const updated = insertOrReplaceBlock(existing, hookSnippet(toPosixPath(hookPath)));
  writeFileSync(profilePath, updated);

  return {
    profilePath,
    backupPath,
    beforeHash,
    afterHash: computeHash(updated),
    alreadyInstalled: hasBlock(existing),
  };
}

export function uninstall({ profilePath, backupDir }) {
  if (!existsSync(profilePath)) return { removed: false, reason: 'file does not exist' };
  const existing = readFileSync(profilePath, 'utf8');
  if (!hasBlock(existing)) return { removed: false, reason: 'no Guardian block present' };

  mkdirSync(backupDir, { recursive: true });
  const backupPath = backupPathFor(backupDir, profilePath);
  writeFileSync(backupPath, existing);

  const updated = removeBlock(existing);
  writeFileSync(profilePath, updated);
  return { removed: true, backupPath, afterHash: computeHash(updated) };
}

export function restore({ profilePath, lastInstalledBlockHash }) {
  if (!existsSync(profilePath)) return { restored: false, reason: 'file does not exist' };
  const existing = readFileSync(profilePath, 'utf8');
  const currentBlock = extractBlock(existing);
  if (!currentBlock) return { restored: false, reason: 'no Guardian block present to restore' };
  if (!lastInstalledBlockHash) return { restored: false, reason: 'no known prior install to restore to — refusing to guess' };
  if (computeHash(currentBlock) !== lastInstalledBlockHash) {
    return { restored: false, reason: 'current Guardian block differs from what Guardian last installed — refusing to overwrite a possible manual edit' };
  }
  return { restored: true, reason: 'current block already matches last install; nothing to do' };
}

// Same purpose as profile-manager.js's readInstallState/writeInstallState (PowerShell) — kept in
// a separate file so the two shell families' install-state tracking never collides.
export function readInstallState(dataDir) {
  const p = path.join(dataDir, 'shell-install-state-gitbash.json');
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

export function writeInstallState(dataDir, state) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, 'shell-install-state-gitbash.json'), JSON.stringify(state, null, 2));
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
  checks.encodingOk = !content.includes('\ufffd');
  return checks;
}
