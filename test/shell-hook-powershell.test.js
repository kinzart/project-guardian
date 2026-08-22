import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createShellIpcServer, DEFAULT_PIPE_NAME, probePipe } from '../src/shell/ipc-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = path.join(__dirname, '..', 'src', 'shell', 'powershell', 'hook.ps1');

function runPowerShell(script, { timeout = 15000 } = {}) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
  });
}

// Real E2E gate G3/G6/G7 at the language level: these spawn a genuine powershell.exe process and
// dot-source the real hook.ps1 — no fake/mocked PowerShell involved.

test('hook.ps1: fails open instantly when Guardian is not running (no hang, no visible error)', () => {
  // -NonInteractive here is deliberate: it proves the hook's own interactive guard also works
  // (case: "guard confiável para evitar poluir ... automação -NonInteractive" — the hook itself
  // must return immediately without attempting to connect at all).
  const start = Date.now();
  const out = runPowerShell(`. "${HOOK_PATH}"; Write-Output "SHELL-OK"`);
  const elapsed = Date.now() - start;
  assert.match(out, /SHELL-OK/);
  assert.ok(elapsed < 8000, `hook.ps1 must not add perceptible delay when Guardian is offline (took ${elapsed}ms)`);
});

test('hook.ps1: custom prompt function is preserved when dot-sourced (interactive-forced)', () => {
  // Force the interactive guard open for this one script by clearing NonInteractive semantics:
  // GetCommandLineArgs() won't contain -NonI here since we don't pass that flag.
  const script = `
    function prompt { "CUSTOM-PROMPT>" }
    . "${HOOK_PATH}"
    prompt
  `;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 15000, windowsHide: true, input: '' });
  assert.match(out, /CUSTOM-PROMPT>/);
});

test('hook.ps1: a Write-Host side effect inside the original prompt still runs, and its return value still flows through', () => {
  const script = `
    function prompt { Write-Host "side-effect-marker" -NoNewline; return "RETURNED-PROMPT>" }
    . "${HOOK_PATH}"
    prompt
  `;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 15000, windowsHide: true, input: '' });
  assert.match(out, /side-effect-marker/);
  assert.match(out, /RETURNED-PROMPT>/);
});

test('hook.ps1: -NonInteractive shells never load the hook at all (no session id created)', () => {
  const out = runPowerShell(`
    . "${HOOK_PATH}"
    if ($global:ProjectGuardianShellHookLoaded) { Write-Output "LOADED" } else { Write-Output "NOT-LOADED" }
  `);
  assert.match(out, /NOT-LOADED/);
});

test('hook.ps1 real E2E: SHELL_STARTED and CWD_CHANGED arrive over the real pipe from a real PowerShell process', async () => {
  const alreadyRunning = await probePipe(DEFAULT_PIPE_NAME, 200);
  if (alreadyRunning) {
    // A real `guardian observe` is genuinely running against the default pipe right now —
    // don't fight it for the pipe; skip rather than produce a false failure.
    return;
  }

  const events = [];
  const server = createShellIpcServer({ onEvent: (e) => events.push(e), verifyPid: false, tcpPort: null });
  await server.start();

  const tmpA = mkdtempSync(path.join(os.tmpdir(), 'guardian-shellhook-a-'));
  const tmpB = mkdtempSync(path.join(os.tmpdir(), 'guardian-shellhook-b-'));

  try {
    // Uses async spawn(), not execFileSync(): execFileSync blocks Node's entire event loop for
    // the child's whole lifetime, which starves the in-process net-based IPC server of the very
    // loop turns it needs to accept the connection and read the data — the write can complete
    // fine on the PowerShell side while Node never gets to service it before the child exits and
    // closes the pipe. spawn() keeps the loop running so the server behaves as it would for a
    // real, independently-running PowerShell process.
    const script = `
      . "${HOOK_PATH}"
      prompt | Out-Null
      Set-Location "${tmpA}"
      prompt | Out-Null
      prompt | Out-Null
      Set-Location "${tmpB}"
      prompt | Out-Null
      Start-Sleep -Milliseconds 200
    `;
    await new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
      child.on('exit', resolve);
      child.on('error', reject);
    });

    const started = events.filter((e) => e.type === 'SHELL_STARTED');
    const cwdChanged = events.filter((e) => e.type === 'CWD_CHANGED');

    assert.equal(started.length, 1);
    // Two real CWD changes (to tmpA, then tmpB) — the repeated `prompt` call in tmpA must not
    // produce a duplicate.
    assert.equal(cwdChanged.length, 2);
    assert.ok(cwdChanged[0].cwd.toLowerCase().includes(path.basename(tmpA).toLowerCase()));
    assert.ok(cwdChanged[1].cwd.toLowerCase().includes(path.basename(tmpB).toLowerCase()));
    assert.equal(started[0].shell_session_id, cwdChanged[0].shell_session_id);
  } finally {
    await server.stop();
    rmSync(tmpA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(tmpB, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
