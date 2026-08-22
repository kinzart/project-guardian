import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { JsonFileStore } from '../src/store/JsonFileStore.js';
import { selectDistros } from '../src/cli/commands/shell.js';
import { detectWsl } from '../src/shell/wsl/discovery.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUARDIAN_BIN = path.join(__dirname, '..', 'bin', 'guardian.js');

function runCli(args, sandbox) {
  return execFileSync('node', [GUARDIAN_BIN, ...args], { env: { ...process.env, GUARDIAN_HOME: sandbox }, encoding: 'utf8', timeout: 30000 });
}

function writeConfig(sandbox, scanRoots) {
  writeFileSync(
    path.join(sandbox, 'guardian.config.json'),
    JSON.stringify(
      {
        scanRoots,
        exclude: ['node_modules', '.git'],
        maxDepth: 8,
        maxDirectoriesVisited: 50000,
        confidenceThresholds: { high: 55, medium: 30, low: 10 },
        activityThresholds: { activeHours: 48, warmDays: 7, staleDays: 30 },
        watch: { debounceMs: 100, settleMs: 1500 },
        process: { captureCommandLine: 'sanitized-minimal', startupSettleMs: 300, correlationWindowMs: 4000 },
        shell: { pipeName: `\\\\.\\pipe\\guardian-shell-wslclitest-${Date.now().toString(36)}` },
        wsl: { tcpPort: 47815, heartbeatIntervalMs: 60000, scanRoots: {} },
      },
      null,
      2,
    ),
  );
}

// This machine genuinely has no WSL distro registered (confirmed via the non-elevated
// HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss registry check — see SPEC_V0.5C.md section
// 1). Every CLI assertion below proves HONEST "not detected"/"skipped" reporting against the real
// environment — never a mock standing in for what WSL would say.

test('CLI precondition: this machine really has no WSL installed (sanity-checks every other test\'s premise)', () => {
  const wsl = detectWsl();
  assert.equal(wsl.installed, false);
  assert.deepEqual(wsl.distros, []);
});

test('CLI: guardian shell status reports "WSL installed: no" honestly, never crashes', () => {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'guardian-wsl-cli-status-'));
  try {
    writeConfig(sandbox, []);
    const out = runCli(['shell', 'status'], sandbox);
    assert.match(out, /WSL installed: no/);
    assert.match(out, /WSL IPC: (running|stopped)/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('CLI: guardian shell doctor reports "WSL installed: no" and never raises issues for an absent WSL', () => {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'guardian-wsl-cli-doctor-'));
  try {
    writeConfig(sandbox, []);
    const out = runCli(['shell', 'doctor'], sandbox);
    assert.match(out, /WSL installed: no/);
    assert.match(out, /WSL transport connectivity: (ok|no server listening)/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('CLI: guardian shell install/uninstall/restore wsl skip cleanly (no distro files touched) when WSL is absent', () => {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'guardian-wsl-cli-install-'));
  try {
    writeConfig(sandbox, []);
    assert.match(runCli(['shell', 'install', 'wsl'], sandbox), /WSL: not detected — skipped/);
    assert.match(runCli(['shell', 'uninstall', 'wsl'], sandbox), /WSL: not detected — skipped/);
    assert.match(runCli(['shell', 'restore', 'wsl'], sandbox), /WSL: not detected — skipped/);
    // --distro is still accepted syntactically even though nothing can apply on this machine.
    assert.match(runCli(['shell', 'install', 'wsl', '--distro', 'Ubuntu'], sandbox), /WSL: not detected — skipped/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('CLI: guardian shell hook-path wsl prints the real wsl-hook.sh location, with the manual-source vs. auto-install distinction', () => {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'guardian-wsl-cli-hookpath-'));
  try {
    writeConfig(sandbox, []);
    const out = runCli(['shell', 'hook-path', 'wsl'], sandbox);
    assert.match(out, /wsl-hook\.sh/);
    assert.match(out, /guardian shell install wsl/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// selectDistros is exported specifically so this refusal behavior is provable without a real WSL
// distro to test against (see shell.js) — this machine cannot exercise it end to end via the CLI
// since detectWsl().installed is false and short-circuits before distro selection ever runs.

test('selectDistros: refuses an unrecognized --distro name and lists what was actually detected', () => {
  const wsl = { installed: true, distros: [{ name: 'Ubuntu-22.04', state: 'Running', wslVersion: '2', isDefault: true }, { name: 'Debian', state: 'Stopped', wslVersion: '1', isDefault: false }] };
  const result = selectDistros(wsl, 'Fedora');
  assert.deepEqual(result.distros, []);
  assert.match(result.error, /No detected WSL distro named "Fedora"/);
  assert.match(result.error, /Ubuntu-22\.04/);
  assert.match(result.error, /Debian/);
});

test('selectDistros: matches case-insensitively and narrows to exactly the requested distro', () => {
  const wsl = { installed: true, distros: [{ name: 'Ubuntu-22.04', state: 'Running', wslVersion: '2', isDefault: true }, { name: 'Debian', state: 'Stopped', wslVersion: '1', isDefault: false }] };
  const result = selectDistros(wsl, 'ubuntu-22.04');
  assert.equal(result.error, null);
  assert.equal(result.distros.length, 1);
  assert.equal(result.distros[0].name, 'Ubuntu-22.04');
});

test('selectDistros: no filter returns every detected distro', () => {
  const wsl = { installed: true, distros: [{ name: 'Ubuntu', state: 'Running', wslVersion: '2', isDefault: true }] };
  const result = selectDistros(wsl, null);
  assert.equal(result.distros.length, 1);
  assert.equal(result.error, null);
});

// --type wsl filters on shells/shell-events, seeded directly through the store (real E2E can't
// produce WSL sessions on this machine, but the CLI filter logic itself needs no real WSL at all).

test('CLI: guardian shells --type wsl / shell-events --type wsl filter correctly against seeded data', async () => {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'guardian-wsl-cli-typefilter-'));
  try {
    writeConfig(sandbox, []);
    const store = new JsonFileStore(path.join(sandbox, 'data', 'guardian.db.json'));
    await store.init();
    await store.upsertProject({ id: 'pg', name: 'PROJECT-GUARDIAN', root_path: 'D:\\PROJECT-GUARDIAN', status: { activity_state: 'ACTIVE', completion_state: 'IN_PROGRESS' } });

    await store.upsertShellSession({
      shell_session_id: 'ps1', pid: 100, parent_pid: 1, shell_type: 'Desktop', shell_version: '5.1', host_name: 'ConsoleHost',
      started_at: '2026-01-01T00:00:00.000Z', ended_at: null, status: 'ACTIVE', cwd: 'D:\\PROJECT-GUARDIAN',
      cwd_timeline: [{ cwd: 'D:\\PROJECT-GUARDIAN', at: '2026-01-01T00:00:00.000Z' }],
    });
    await store.upsertShellSession({
      shell_session_id: 'wsl1', pid: 500, parent_pid: 1, shell_type: 'WSL_BASH', shell_version: '5.1.16(1)-release', host_name: 'Ubuntu',
      started_at: '2026-01-01T00:00:00.000Z', ended_at: null, status: 'ACTIVE', cwd: 'D:\\PROJECT-GUARDIAN',
      cwd_timeline: [{ cwd: 'D:\\PROJECT-GUARDIAN', at: '2026-01-01T00:00:00.000Z' }],
    });
    await store.addShellEvent({
      id: 'e-ps', type: 'SHELL_STARTED', shell_session_id: 'ps1', pid: 100, parent_pid: 1, shell_type: 'Desktop', shell_version: '5.1', host_name: 'ConsoleHost',
      cwd: 'D:\\PROJECT-GUARDIAN', timestamp: '2026-01-01T00:00:00.000Z', received_at: '2026-01-01T00:00:00.000Z', source: 'POWERSHELL_HOOK', project_id: 'pg',
    });
    await store.addShellEvent({
      id: 'e-wsl', type: 'SHELL_STARTED', shell_session_id: 'wsl1', pid: 500, parent_pid: 1, shell_type: 'WSL_BASH', shell_version: '5.1.16(1)-release', host_name: 'Ubuntu',
      cwd: 'D:\\PROJECT-GUARDIAN', timestamp: '2026-01-01T00:00:00.000Z', received_at: '2026-01-01T00:00:00.000Z', source: 'WSL_HOOK', project_id: 'pg',
    });
    await store.close();

    const shellsWsl = runCli(['shells', '--type', 'wsl'], sandbox);
    assert.match(shellsWsl, /Distro: Ubuntu/);
    assert.ok(!shellsWsl.includes('ConsoleHost'));

    const shellsPs = runCli(['shells', '--type', 'powershell'], sandbox);
    assert.match(shellsPs, /Host: ConsoleHost/);
    assert.ok(!shellsPs.includes('Distro: Ubuntu'));

    const eventsWsl = runCli(['shell-events', '--type', 'wsl'], sandbox);
    assert.match(eventsWsl, /SHELL_STARTED/);
    const eventsWslLines = eventsWsl.trim().split('\n');
    assert.equal(eventsWslLines.length, 1);
  } finally {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
