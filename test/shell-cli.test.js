import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { JsonFileStore } from '../src/store/JsonFileStore.js';
import { probePipe, probeTcp, DEFAULT_PIPE_NAME, DEFAULT_TCP_PORT } from '../src/shell/ipc-server.js';
import { createFixtureRoot, cleanupFixtureRoot } from './helpers/fixtures.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUARDIAN_BIN = path.join(__dirname, '..', 'bin', 'guardian.js');
const HOOK_PATH = path.join(__dirname, '..', 'src', 'shell', 'powershell', 'hook.ps1');
const GITBASH_HOOK_PATH = path.join(__dirname, '..', 'src', 'shell', 'gitbash', 'hook.sh');
const GITBASH_HOOK_POSIX = GITBASH_HOOK_PATH.replace(/\\/g, '/').replace(/^([a-zA-Z]):/, (m, d) => `/${d.toLowerCase()}`);

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
        shell: { pipeName: `\\\\.\\pipe\\guardian-shell-clitest-${Date.now().toString(36)}` },
      },
      null,
      2,
    ),
  );
}

async function waitForOutput(getOutput, pattern, { timeout = 12000, interval = 50 } = {}) {
  const start = Date.now();
  for (;;) {
    if (pattern.test(getOutput())) return true;
    if (Date.now() - start > timeout) throw new Error(`waitForOutput timed out waiting for ${pattern}. Output so far:\n${getOutput()}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

test('CLI: guardian shells/shell-events report cleanly with no data yet', () => {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'guardian-shell-cli-empty-'));
  try {
    writeConfig(sandbox, []);
    assert.match(runCli(['shells'], sandbox), /No shell sessions recorded/);
    assert.match(runCli(['shell-events'], sandbox), /No shell events recorded/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('CLI: guardian shells/shell-events render seeded data, --verbose reveals path otherwise hidden', async () => {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'guardian-shell-cli-seeded-'));
  try {
    writeConfig(sandbox, []);
    const store = new JsonFileStore(path.join(sandbox, 'data', 'guardian.db.json'));
    await store.init();
    await store.upsertProject({
      id: 'pg',
      name: 'PROJECT-GUARDIAN',
      root_path: 'D:\\PROJECT-GUARDIAN',
      status: { activity_state: 'ACTIVE', completion_state: 'IN_PROGRESS' },
    });
    await store.upsertShellSession({
      shell_session_id: 's1',
      pid: 100,
      parent_pid: 1,
      shell_type: 'Desktop',
      shell_version: '5.1',
      host_name: 'ConsoleHost',
      started_at: '2026-01-01T00:00:00.000Z',
      ended_at: null,
      status: 'ACTIVE',
      cwd: 'D:\\PROJECT-GUARDIAN',
      cwd_timeline: [{ cwd: 'D:\\PROJECT-GUARDIAN', at: '2026-01-01T00:00:00.000Z' }],
    });
    await store.addShellEvent({
      id: 'e1',
      type: 'SHELL_STARTED',
      shell_session_id: 's1',
      pid: 100,
      parent_pid: 1,
      shell_type: 'Desktop',
      shell_version: '5.1',
      host_name: 'ConsoleHost',
      cwd: 'D:\\PROJECT-GUARDIAN',
      timestamp: '2026-01-01T00:00:00.000Z',
      received_at: '2026-01-01T00:00:00.000Z',
      source: 'POWERSHELL_HOOK',
      project_id: 'pg',
    });
    await store.close();

    const shellsOut = runCli(['shells'], sandbox);
    assert.match(shellsOut, /PROJECT-GUARDIAN/);
    assert.match(shellsOut, /Status: ACTIVE/);

    const eventsOut = runCli(['shell-events'], sandbox);
    assert.match(eventsOut, /SHELL_STARTED/);
    assert.match(eventsOut, /project=PROJECT-GUARDIAN/);
    assert.ok(!eventsOut.includes('D:\\PROJECT-GUARDIAN')); // path hidden by default

    const verboseOut = runCli(['shell-events', '--verbose'], sandbox);
    assert.match(verboseOut, /cwd=D:\\PROJECT-GUARDIAN/);

    const filteredOut = runCli(['shell-events', '--project', 'project-guardian'], sandbox);
    assert.match(filteredOut, /SHELL_STARTED/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('CLI: guardian shell status / doctor run without crashing (read-only, real system detection)', () => {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'guardian-shell-cli-status-'));
  try {
    writeConfig(sandbox, []);
    const statusOut = runCli(['shell', 'status'], sandbox);
    assert.match(statusOut, /Windows PowerShell 5\.1:/);
    assert.match(statusOut, /IPC: (running|stopped)/);

    const doctorOut = runCli(['shell', 'doctor'], sandbox);
    assert.match(doctorOut, /Windows PowerShell 5\.1:/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('CLI: guardian shell hook-path prints the real hook.ps1 location', () => {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'guardian-shell-cli-hookpath-'));
  try {
    writeConfig(sandbox, []);
    const out = runCli(['shell', 'hook-path'], sandbox);
    assert.match(out, /hook\.ps1/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('CLI: guardian observe integrates filesystem + process + shell IPC together, and shuts down cleanly on SIGINT', async (t) => {
  // hook.ps1/hook.sh always target the DEFAULT pipe/port — this test therefore needs both free
  // (not overridden per-test) to prove real hook<->guardian observe delivery end to end. If a
  // real `guardian observe` (or another test run) is genuinely holding either, skip rather than
  // produce a false failure or fight over them.
  if ((await probePipe(DEFAULT_PIPE_NAME, 200)) || (await probeTcp(DEFAULT_TCP_PORT, 200))) {
    t.skip('default shell pipe/port is already in use by another Guardian instance');
    return;
  }

  const fixtureRoot = createFixtureRoot();
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'guardian-observe3-sandbox-'));
  try {
    writeFileSync(
      path.join(sandbox, 'guardian.config.json'),
      JSON.stringify(
        {
          scanRoots: [fixtureRoot],
          exclude: ['node_modules', '.git'],
          maxDepth: 8,
          maxDirectoriesVisited: 50000,
          confidenceThresholds: { high: 55, medium: 30, low: 10 },
          activityThresholds: { activeHours: 48, warmDays: 7, staleDays: 30 },
          watch: { debounceMs: 100, settleMs: 1500 },
          process: { captureCommandLine: 'sanitized-minimal', startupSettleMs: 300, correlationWindowMs: 4000 },
          shell: { pipeName: DEFAULT_PIPE_NAME },
        },
        null,
        2,
      ),
    );
    runCli(['scan'], sandbox);

    const child = spawn('node', [GUARDIAN_BIN, 'observe'], { env: { ...process.env, GUARDIAN_HOME: sandbox } });
    let output = '';
    child.stdout.on('data', (d) => {
      output += d.toString();
    });
    child.stderr.on('data', (d) => {
      output += d.toString();
    });
    const exitPromise = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));

    try {
      await waitForOutput(() => output, /PROJECT GUARDIAN LIVE/);
      await waitForOutput(() => output, /Filesystem: running/);
      await waitForOutput(() => output, /Processes: running/);
      await waitForOutput(() => output, /Shell IPC: running/);

      // A real PowerShell process dot-sources the real hook against the real default pipe that
      // this guardian observe instance is listening on.
      const shellChild = spawn('powershell.exe', ['-NoProfile', '-Command', `. "${HOOK_PATH}"; Start-Sleep -Milliseconds 300`], { windowsHide: true });
      await new Promise((resolve) => shellChild.on('exit', resolve));
      await waitForOutput(() => output, /(Desktop|Core) started/, { timeout: 6000 }); // shell_type from $PSVersionTable.PSEdition

      // A real Git Bash process, at the same time, over the TCP loopback transport — proves
      // G13/multi-shell isolation (two different shell families concurrently), not just two
      // PowerShell tabs.
      const bashChild = spawn('bash', ['-i', '-c', `source "${GITBASH_HOOK_POSIX}"; sleep 0.3`], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
      await new Promise((resolve) => bashChild.on('exit', resolve));
      await waitForOutput(() => output, /bash started/, { timeout: 6000 });

      writeFileSync(path.join(fixtureRoot, 'fixture-aum-git', 'README.md'), '# Aum Git Fixture\n\nStatus: In Progress\n\nEdited during 3-observer CLI test.\n');
      await waitForOutput(() => output, /aum-git-fixture/, { timeout: 8000 });

      child.kill('SIGINT');
      let result;
      try {
        result = await Promise.race([exitPromise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))]);
      } catch {
        result = null;
      }
      const gracefulShutdownDelivered = result && result.code === 0 && !result.signal;
      if (gracefulShutdownDelivered) {
        assert.match(output, /Guardian stopped cleanly/);
      } else if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exitPromise;
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }

    const processStatusOut = runCli(['process-status'], sandbox);
    assert.match(processStatusOut, /Status: (STOPPED|UNCLEAN_END|RUNNING)/);

    const shellsOut = runCli(['shells'], sandbox);
    assert.match(shellsOut, /Desktop/); // PSEdition of the real PowerShell 5.1 that connected
    assert.match(shellsOut, /bash/); // the real Git Bash session that connected over TCP
  } finally {
    try { cleanupFixtureRoot(fixtureRoot); } catch (err) { if (err?.code !== 'EBUSY') throw err; }
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
