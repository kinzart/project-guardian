import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  decodeWslOutput,
  checkLoginShell,
  detectStartupFile,
  toWslPath,
  install,
  uninstall,
  restore,
  doctor,
  readInstallState,
  writeInstallState,
  writeAuthToken,
} from '../src/shell/wsl/manager.js';
import { hasBlock, computeHash, extractBlock } from '../src/shell/installer.js';

// A tiny fake in-distro "shell + filesystem", driven purely by pattern-matching the exact command
// templates manager.js's real defaultWslInvoke would send to a real distro (see manager.js's
// readDistroFile/writeDistroFile/toWslPath/checkLoginShell/detectStartupFile). This machine has no
// real WSL install (SPEC_V0.5C.md section 1), so every distro-side behavior in this file is proven
// exclusively against this fake — matching the module's own wslInvoke-injectable design.
function createFakeWslInvoke({ home = '/home/tester', loginShell = '/bin/bash', files = {}, startupProbeWinner = '.bashrc' } = {}) {
  return function fakeWslInvoke(_distro, script) {
    if (script.includes('echo $HOME')) return { ok: true, text: home };
    if (script.includes('getent passwd')) return { ok: true, text: loginShell };
    if (script.includes('GUARDIAN_STARTUP_PROBE')) {
      const m = script.match(/GUARDIAN_STARTUP_PROBE_[0-9a-f]+/);
      return { ok: true, text: m ? `${m[0]}_${startupProbeWinner}` : '' };
    }
    if (script.includes('wslpath -u')) {
      const m = script.match(/wslpath -u "([^"]+)"/);
      const winPath = m ? m[1].replace(/\\\\/g, '\\') : '';
      return { ok: true, text: `/mnt/${winPath[0].toLowerCase()}${winPath.slice(2).replace(/\\/g, '/')}` };
    }
    const writeMatch = script.match(/printf '%s' "([^"]*)" \| base64 -d > "([^"]+)"/);
    if (writeMatch) {
      const [, b64, linuxPath] = writeMatch;
      files[linuxPath] = Buffer.from(b64, 'base64').toString('utf8');
      return { ok: true, text: '' };
    }
    const readMatch = script.match(/base64 "([^"]+)"/);
    if (readMatch) {
      const linuxPath = readMatch[1];
      const content = files[linuxPath];
      return { ok: true, text: content === undefined ? '' : Buffer.from(content, 'utf8').toString('base64') };
    }
    return { ok: false, text: '', error: `fakeWslInvoke: unrecognized script: ${script.slice(0, 80)}` };
  };
}

// --- decodeWslOutput -----------------------------------------------------------------------------

test('manager.decodeWslOutput: UTF-16LE with BOM', () => {
  const text = 'Ubuntu-22.04';
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  assert.equal(decodeWslOutput(buf), text);
});

test('manager.decodeWslOutput: UTF-16LE heuristic without a BOM (wsl.exe\'s real behavior, confirmed on this machine)', () => {
  const text = 'NAME  STATE  VERSION';
  const buf = Buffer.from(text, 'utf16le');
  assert.equal(decodeWslOutput(buf), text);
});

test('manager.decodeWslOutput: plain UTF-8 falls back correctly', () => {
  const text = 'echo hello from inside a distro';
  const buf = Buffer.from(text, 'utf8');
  assert.equal(decodeWslOutput(buf), text);
});

test('manager.decodeWslOutput: empty buffer', () => {
  assert.equal(decodeWslOutput(Buffer.alloc(0)), '');
  assert.equal(decodeWslOutput(null), '');
});

// --- checkLoginShell -------------------------------------------------------------------------------

test('manager.checkLoginShell: a bash login shell is supported', () => {
  const wslInvoke = createFakeWslInvoke({ loginShell: '/bin/bash' });
  const result = checkLoginShell('Ubuntu', wslInvoke);
  assert.equal(result.supported, true);
});

test('manager.checkLoginShell: a non-bash login shell (e.g. zsh) is UNSUPPORTED_SHELL, never modified', () => {
  const wslInvoke = createFakeWslInvoke({ loginShell: '/usr/bin/zsh' });
  const result = checkLoginShell('Ubuntu', wslInvoke);
  assert.equal(result.supported, false);
  assert.equal(result.reason, 'UNSUPPORTED_SHELL');
});

test('manager.checkLoginShell: wslInvoke failure is treated as UNSUPPORTED_SHELL, never assumed bash', () => {
  const wslInvoke = () => ({ ok: false, text: '', error: 'distro unreachable' });
  const result = checkLoginShell('Ubuntu', wslInvoke);
  assert.equal(result.supported, false);
  assert.equal(result.reason, 'UNSUPPORTED_SHELL');
});

// --- detectStartupFile -----------------------------------------------------------------------------

test('manager.detectStartupFile: identifies whichever file the probe reports won, never assumed', () => {
  const wslInvoke = createFakeWslInvoke({ startupProbeWinner: '.bash_profile' });
  assert.equal(detectStartupFile('Ubuntu', 'login', wslInvoke), '.bash_profile');
});

test('manager.detectStartupFile: returns null on wslInvoke failure rather than guessing', () => {
  const wslInvoke = () => ({ ok: false, text: '', error: 'boom' });
  assert.equal(detectStartupFile('Ubuntu', 'login', wslInvoke), null);
});

// --- toWslPath -------------------------------------------------------------------------------------

test('manager.toWslPath: converts a Windows path via wslpath -u', () => {
  const wslInvoke = createFakeWslInvoke();
  const result = toWslPath('Ubuntu', 'D:\\PROJECT-GUARDIAN\\data', wslInvoke);
  assert.match(result, /^\/mnt\/d/);
});

// --- install/uninstall/restore/doctor (via the fake distro filesystem) -----------------------------

async function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'guardian-wsl-manager-'));
  return { backupDir: path.join(dir, 'backups'), cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

test('manager.install: creates the Guardian block when no startup file exists yet', async () => {
  const { backupDir, cleanup } = await setup();
  try {
    const files = {};
    const wslInvoke = createFakeWslInvoke({ files });
    const result = install({ distro: 'Ubuntu', startupFile: '.bashrc', wslHookLinuxPath: '/mnt/d/PROJECT-GUARDIAN/src/shell/wsl/wsl-hook.sh', repoWslDataPath: '/mnt/d/PROJECT-GUARDIAN/data', backupDir, wslInvoke });
    assert.equal(result.installed, true);
    assert.equal(result.alreadyInstalled, false);
    assert.ok(existsSync(result.backupPath));
    assert.ok(hasBlock(files[result.linuxPath]));
    assert.match(files[result.linuxPath], /PROJECT_GUARDIAN_REPO_DATA_WSL/);
  } finally {
    cleanup();
  }
});

test('manager.install: preserves pre-existing distro startup file content untouched', async () => {
  const { backupDir, cleanup } = await setup();
  try {
    const files = { '/home/tester/.bashrc': 'export MY_EXISTING_VAR=1\nalias ll="ls -la"\n' };
    const wslInvoke = createFakeWslInvoke({ files });
    const result = install({ distro: 'Ubuntu', startupFile: '.bashrc', wslHookLinuxPath: '/mnt/d/hook.sh', repoWslDataPath: '/mnt/d/data', backupDir, wslInvoke });
    assert.match(files[result.linuxPath], /MY_EXISTING_VAR=1/);
    assert.match(files[result.linuxPath], /alias ll="ls -la"/);
  } finally {
    cleanup();
  }
});

test('manager.install: running twice is idempotent (no duplicate block)', async () => {
  const { backupDir, cleanup } = await setup();
  try {
    const files = {};
    const wslInvoke = createFakeWslInvoke({ files });
    const first = install({ distro: 'Ubuntu', startupFile: '.bashrc', wslHookLinuxPath: '/mnt/d/hook.sh', repoWslDataPath: '/mnt/d/data', backupDir, wslInvoke });
    const contentAfterFirst = files[first.linuxPath];
    const second = install({ distro: 'Ubuntu', startupFile: '.bashrc', wslHookLinuxPath: '/mnt/d/hook.sh', repoWslDataPath: '/mnt/d/data', backupDir, wslInvoke });
    assert.equal(second.alreadyInstalled, true);
    assert.equal(files[second.linuxPath], contentAfterFirst);
  } finally {
    cleanup();
  }
});

test('manager.uninstall: removes only the Guardian block, leaves the rest of the file intact', async () => {
  const { backupDir, cleanup } = await setup();
  try {
    const files = { '/home/tester/.bashrc': 'export MY_EXISTING_VAR=1\n' };
    const wslInvoke = createFakeWslInvoke({ files });
    install({ distro: 'Ubuntu', startupFile: '.bashrc', wslHookLinuxPath: '/mnt/d/hook.sh', repoWslDataPath: '/mnt/d/data', backupDir, wslInvoke });
    const result = uninstall({ distro: 'Ubuntu', startupFile: '.bashrc', backupDir, wslInvoke });
    assert.equal(result.removed, true);
    assert.ok(!hasBlock(files['/home/tester/.bashrc']));
    assert.match(files['/home/tester/.bashrc'], /MY_EXISTING_VAR=1/);
  } finally {
    cleanup();
  }
});

test('manager.uninstall: reports cleanly (never crashes) when nothing was ever installed', async () => {
  const { backupDir, cleanup } = await setup();
  try {
    const wslInvoke = createFakeWslInvoke({ files: {} });
    const result = uninstall({ distro: 'Ubuntu', startupFile: '.bashrc', backupDir, wslInvoke });
    assert.equal(result.removed, false);
  } finally {
    cleanup();
  }
});

test('manager.restore: refuses when the block was hand-edited since Guardian last installed', async () => {
  const { backupDir, cleanup } = await setup();
  try {
    const files = {};
    const wslInvoke = createFakeWslInvoke({ files });
    const installed = install({ distro: 'Ubuntu', startupFile: '.bashrc', wslHookLinuxPath: '/mnt/d/hook.sh', repoWslDataPath: '/mnt/d/data', backupDir, wslInvoke });
    const originalHash = computeHash(extractBlock(files[installed.linuxPath]));
    files[installed.linuxPath] = files[installed.linuxPath].replace('hook.sh', 'tampered.sh');
    const result = restore({ distro: 'Ubuntu', startupFile: '.bashrc', lastInstalledBlockHash: originalHash, wslInvoke });
    assert.equal(result.restored, false);
  } finally {
    cleanup();
  }
});

test('manager.doctor: detects a clean install and a hand-duplicated marker', async () => {
  const { backupDir, cleanup } = await setup();
  try {
    const files = {};
    const wslInvoke = createFakeWslInvoke({ files });
    install({ distro: 'Ubuntu', startupFile: '.bashrc', wslHookLinuxPath: '/mnt/d/hook.sh', repoWslDataPath: '/mnt/d/data', backupDir, wslInvoke });
    assert.equal(doctor({ distro: 'Ubuntu', startupFile: '.bashrc', wslInvoke }).blockPresent, true);

    const linuxPath = '/home/tester/.bashrc';
    files[linuxPath] = files[linuxPath] + '\n' + files[linuxPath];
    const checks = doctor({ distro: 'Ubuntu', startupFile: '.bashrc', wslInvoke });
    assert.equal(checks.duplicateMarkers, true);
    assert.equal(checks.blockPresent, false);
  } finally {
    cleanup();
  }
});

// --- install-state + auth-token persistence (real fs, Windows side only) --------------------------

test('manager.readInstallState/writeInstallState round-trip, keyed per distro', async () => {
  const { backupDir, cleanup } = await setup();
  const dataDir = path.join(path.dirname(backupDir), 'data');
  try {
    assert.deepEqual(readInstallState(dataDir), {});
    writeInstallState(dataDir, { Ubuntu: { installedAt: '2026-01-01T00:00:00.000Z', startupFile: '.bashrc' } });
    const state = readInstallState(dataDir);
    assert.equal(state.Ubuntu.startupFile, '.bashrc');
  } finally {
    cleanup();
  }
});

test('manager.writeAuthToken: writes a fresh token file, never inside any startup file', async () => {
  const { backupDir, cleanup } = await setup();
  const dataDir = path.join(path.dirname(backupDir), 'data');
  try {
    writeAuthToken(dataDir, 'deadbeef');
    const content = readFileSync(path.join(dataDir, 'wsl-auth.token'), 'utf8');
    assert.equal(content, 'deadbeef');
  } finally {
    cleanup();
  }
});
