// Per-distro WSL hook management: login-shell detection, startup-file discovery (same empirical
// method as V0.5B, run INSIDE the target distro rather than assumed), install/uninstall/restore/
// doctor. See SPEC_V0.5C.md sections 1 and 6.
//
// Every wsl.exe invocation goes through an injectable `wslInvoke` function so this whole module
// is testable without a real WSL installation (see test/wsl-manager.test.js) — this machine has
// none (SPEC_V0.5C.md section 1), so the default, real implementation is exercised for real only
// by the "WSL absent" path; per-distro behavior is proven exclusively via mocks here.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { START_MARKER, END_MARKER, computeHash, hasBlock, hasDuplicateMarkers, extractBlock, insertOrReplaceBlock, removeBlock } from '../installer.js';

// wsl.exe's own CLI text is UTF-16LE (confirmed on this machine — see discovery.js); a command
// actually RUN INSIDE a distro passes its stdout through unmodified (real Linux UTF-8 text).
// Since this can't be confirmed against a real distro here, decode defensively: detect the
// classic "every other byte is 0x00" UTF-16LE-ASCII pattern before falling back to utf8.
export function decodeWslOutput(buf) {
  if (!buf || buf.length === 0) return '';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  const sampleLen = Math.min(buf.length, 64);
  let nullAtOdd = 0;
  for (let i = 1; i < sampleLen; i += 2) if (buf[i] === 0x00) nullAtOdd += 1;
  if (sampleLen >= 4 && nullAtOdd >= Math.floor(sampleLen / 2) - 1) return buf.toString('utf16le');
  return buf.toString('utf8');
}

// Default real invoker: `wsl.exe -d <distro> bash -lc '<script>'`. Never throws — callers get
// { ok, text, error }, exactly like discovery.js's runWsl().
export function defaultWslInvoke(distro, script, { timeout = 10000 } = {}) {
  try {
    const buf = execFileSync('wsl.exe', ['-d', distro, 'bash', '-lc', script], { encoding: 'buffer', timeout, windowsHide: true });
    return { ok: true, text: decodeWslOutput(buf) };
  } catch (err) {
    return { ok: false, text: err.stdout ? decodeWslOutput(Buffer.from(err.stdout)) : '', error: err.message };
  }
}

// "Se o login shell da distro não for Bash: mostrar UNSUPPORTED_SHELL e não modificar seus arquivos."
export function checkLoginShell(distro, wslInvoke = defaultWslInvoke) {
  const result = wslInvoke(distro, 'getent passwd "$(id -un)" | cut -d: -f7');
  if (!result.ok) return { supported: false, reason: 'UNSUPPORTED_SHELL', detail: result.error || 'could not determine login shell' };
  const shellPath = result.text.trim();
  const isBash = /\/bash$/.test(shellPath);
  return isBash ? { supported: true, shellPath } : { supported: false, reason: 'UNSUPPORTED_SHELL', shellPath };
}

// Same empirical technique as V0.5B's profile-manager.js investigation, run INSIDE the distro:
// temporarily drop a marker into each candidate file, observe which fires for login vs.
// non-login interactive bash, then clean up. Never assumes ~/.bashrc/.bash_profile/.profile.
export function detectStartupFile(distro, mode, wslInvoke = defaultWslInvoke) {
  const marker = `GUARDIAN_STARTUP_PROBE_${crypto.randomBytes(4).toString('hex')}`;
  const probeScript = `
    set -e
    backup_dir="$(mktemp -d)"
    for f in .bash_profile .bashrc .profile; do
      if [ -f "$HOME/$f" ]; then cp "$HOME/$f" "$backup_dir/$f"; fi
      printf 'echo %s_%s\\n' "${marker}" "$f" >> "$HOME/$f.guardianprobe" 2>/dev/null || true
    done
    for f in .bash_profile .bashrc .profile; do
      if [ -f "$backup_dir/$f" ]; then
        cp "$HOME/$f.guardianprobe" "$HOME/$f.tmp" 2>/dev/null || true
      fi
      mv "$HOME/$f.guardianprobe" "$HOME/$f" 2>/dev/null || true
    done
    ${mode === 'login' ? 'bash --login -i -c "echo done"' : 'bash -i -c "echo done"'} 2>/dev/null
    for f in .bash_profile .bashrc .profile; do
      if [ -f "$backup_dir/$f" ]; then cp "$backup_dir/$f" "$HOME/$f"; else rm -f "$HOME/$f"; fi
    done
    rm -rf "$backup_dir"
  `;
  const result = wslInvoke(distro, probeScript);
  if (!result.ok) return null;
  for (const file of ['.bash_profile', '.bashrc', '.profile']) {
    if (result.text.includes(`${marker}_${file}`)) return file;
  }
  return null;
}

function toWslPath(distro, windowsPath, wslInvoke = defaultWslInvoke) {
  const escaped = windowsPath.replace(/\\/g, '\\\\');
  const result = wslInvoke(distro, `wslpath -u "${escaped}"`);
  return result.ok ? result.text.trim() : null;
}

function hookSnippet(wslHookPath, repoWslDataPath) {
  return [
    `export PROJECT_GUARDIAN_REPO_DATA_WSL="${repoWslDataPath}"`,
    `if [ -f "${wslHookPath}" ]; then source "${wslHookPath}"; fi`,
  ].join('\n');
}

function backupPathFor(backupDir, distro, fileName) {
  const safe = `${distro}-${fileName}`.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(backupDir, `${safe}.${Date.now()}.bak`);
}

// install/uninstall/restore operate on the distro's startup file CONTENT, read/written via
// wslInvoke (cat/base64 round-trip — avoids any issue with the Windows side trying to open a
// Linux-native path directly, which only works for WSL2 over a slow 9P mount if at all).
function readDistroFile(distro, linuxPath, wslInvoke) {
  const result = wslInvoke(distro, `[ -f "${linuxPath}" ] && base64 "${linuxPath}" || true`);
  if (!result.ok) return null;
  const b64 = result.text.trim();
  return b64 ? Buffer.from(b64, 'base64').toString('utf8') : '';
}

function writeDistroFile(distro, linuxPath, content, wslInvoke) {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const dir = linuxPath.slice(0, linuxPath.lastIndexOf('/')) || '~';
  return wslInvoke(distro, `mkdir -p "${dir}" && printf '%s' "${b64}" | base64 -d > "${linuxPath}"`);
}

export function install({ distro, startupFile, wslHookLinuxPath, repoWslDataPath, backupDir, wslInvoke = defaultWslInvoke }) {
  const homeResult = wslInvoke(distro, 'echo $HOME');
  const home = homeResult.ok ? homeResult.text.trim() : '~';
  const linuxPath = `${home}/${startupFile}`;

  const existing = readDistroFile(distro, linuxPath, wslInvoke) ?? '';
  const beforeHash = computeHash(existing);
  mkdirSync(backupDir, { recursive: true });
  const backupPath = backupPathFor(backupDir, distro, startupFile);
  writeFileSync(backupPath, existing);

  const updated = insertOrReplaceBlock(existing, hookSnippet(wslHookLinuxPath, repoWslDataPath));
  const writeResult = writeDistroFile(distro, linuxPath, updated, wslInvoke);
  if (!writeResult.ok) return { installed: false, reason: writeResult.error };

  return { installed: true, linuxPath, backupPath, beforeHash, afterHash: computeHash(updated), alreadyInstalled: hasBlock(existing) };
}

export function uninstall({ distro, startupFile, backupDir, wslInvoke = defaultWslInvoke }) {
  const homeResult = wslInvoke(distro, 'echo $HOME');
  const home = homeResult.ok ? homeResult.text.trim() : '~';
  const linuxPath = `${home}/${startupFile}`;

  const existing = readDistroFile(distro, linuxPath, wslInvoke);
  if (existing == null) return { removed: false, reason: 'file does not exist or is unreadable' };
  if (!hasBlock(existing)) return { removed: false, reason: 'no Guardian block present' };

  mkdirSync(backupDir, { recursive: true });
  const backupPath = backupPathFor(backupDir, distro, startupFile);
  writeFileSync(backupPath, existing);

  const updated = removeBlock(existing);
  const writeResult = writeDistroFile(distro, linuxPath, updated, wslInvoke);
  if (!writeResult.ok) return { removed: false, reason: writeResult.error };
  return { removed: true, backupPath, afterHash: computeHash(updated) };
}

export function restore({ distro, startupFile, lastInstalledBlockHash, wslInvoke = defaultWslInvoke }) {
  const homeResult = wslInvoke(distro, 'echo $HOME');
  const home = homeResult.ok ? homeResult.text.trim() : '~';
  const linuxPath = `${home}/${startupFile}`;

  const existing = readDistroFile(distro, linuxPath, wslInvoke);
  if (existing == null) return { restored: false, reason: 'file does not exist or is unreadable' };
  const currentBlock = extractBlock(existing);
  if (!currentBlock) return { restored: false, reason: 'no Guardian block present to restore' };
  if (!lastInstalledBlockHash) return { restored: false, reason: 'no known prior install to restore to — refusing to guess' };
  if (computeHash(currentBlock) !== lastInstalledBlockHash) {
    return { restored: false, reason: 'current Guardian block differs from what Guardian last installed — refusing to overwrite a possible manual edit' };
  }
  return { restored: true, reason: 'current block already matches last install; nothing to do' };
}

export function doctor({ distro, startupFile, wslInvoke = defaultWslInvoke }) {
  const checks = { fileFound: false, parseable: false, blockPresent: false, blockIntact: false, duplicateMarkers: false };
  if (!startupFile) return checks;
  const homeResult = wslInvoke(distro, 'echo $HOME');
  const home = homeResult.ok ? homeResult.text.trim() : '~';
  const content = readDistroFile(distro, `${home}/${startupFile}`, wslInvoke);
  if (content == null) return checks;
  checks.fileFound = true;
  checks.parseable = true;
  checks.duplicateMarkers = hasDuplicateMarkers(content);
  checks.blockPresent = hasBlock(content) && !checks.duplicateMarkers;
  checks.blockIntact = checks.blockPresent && content.indexOf(START_MARKER) < content.indexOf(END_MARKER);
  return checks;
}

export { toWslPath };

// Same install-state tracking pattern as V0.5A/B's profile-manager.js/bash-manager.js, keyed by
// distro so multiple distros never collide.
export function readInstallState(dataDir) {
  const p = path.join(dataDir, 'shell-install-state-wsl.json');
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

export function writeInstallState(dataDir, state) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, 'shell-install-state-wsl.json'), JSON.stringify(state, null, 2));
}

// Written fresh every time `guardian observe`'s WSL listener starts (see
// src/shell/wsl/ipc-server.js's auth-token handshake) — never baked into any distro startup
// file, matching "não colocar secrets no shell startup" (SPEC_V0.5C.md's own security section).
export function writeAuthToken(dataDir, token) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, 'wsl-auth.token'), token, { mode: 0o600 });
}
