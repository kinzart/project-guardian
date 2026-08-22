import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createShellIpcServer, DEFAULT_TCP_PORT, probeTcp } from '../src/shell/ipc-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = path.join(__dirname, '..', 'src', 'shell', 'gitbash', 'hook.sh');
const HOOK_POSIX = HOOK_PATH.replace(/\\/g, '/').replace(/^([a-zA-Z]):/, (m, d) => `/${d.toLowerCase()}`);

function runBash(script, { timeout = 15000 } = {}) {
  return execFileSync('bash', ['-i', '-c', script], { encoding: 'utf8', timeout, windowsHide: true, input: '', stdio: ['pipe', 'pipe', 'pipe'] });
}

async function waitForOutput(getOutput, pattern, { timeout = 8000, interval = 50 } = {}) {
  const start = Date.now();
  for (;;) {
    if (pattern.test(getOutput())) return true;
    if (Date.now() - start > timeout) throw new Error(`waitForOutput timed out waiting for ${pattern}. Output so far:\n${getOutput()}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

// Real E2E gates G3/G6/G7 at the language level — a genuine bash.exe process sources the real
// hook.sh, no fake/mocked shell involved.

test('hook.sh: fails open instantly when Guardian is not running (no hang, no visible error)', async (t) => {
  // This test specifically needs Guardian OFFLINE — if a real `guardian observe` genuinely is
  // running (e.g. during manual real E2E work), skip rather than produce a false failure.
  if (await probeTcp(DEFAULT_TCP_PORT, 200)) {
    t.skip('a real Guardian instance is listening on the default port right now');
    return;
  }
  const start = Date.now();
  let out;
  try {
    out = runBash(`source "${HOOK_POSIX}"; echo "GITBASH-OK available=$PROJECT_GUARDIAN_AVAILABLE"`);
  } catch (err) {
    out = `${err.stdout || ''}${err.stderr || ''}`;
    throw new Error(`hook.sh produced visible stderr or failed: ${err.stderr}\n${out}`);
  }
  const elapsed = Date.now() - start;
  assert.match(out, /GITBASH-OK available=0/);
  assert.ok(elapsed < 8000, `hook.sh must not add perceptible delay when Guardian is offline (took ${elapsed}ms)`);
});

test('hook.sh: -NonInteractive-equivalent (non-interactive bash) never loads the hook', () => {
  const out = execFileSync('bash', ['-c', `source "${HOOK_POSIX}"; if [ -n "$PROJECT_GUARDIAN_BASH_HOOK_LOADED" ]; then echo LOADED; else echo NOT-LOADED; fi`], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
    input: '',
  });
  assert.match(out, /NOT-LOADED/);
});

test('hook.sh: existing PROMPT_COMMAND is preserved and still runs', () => {
  const out = runBash(`
    export PROMPT_COMMAND="echo EXISTING-PROMPT-RAN"
    source "${HOOK_POSIX}"
    eval "$PROMPT_COMMAND"
  `);
  assert.match(out, /EXISTING-PROMPT-RAN/);
});

test('hook.sh real E2E: SHELL_STARTED and CWD_CHANGED arrive over the real TCP loopback listener, with duplicate suppression', async (t) => {
  if (await probeTcp(DEFAULT_TCP_PORT, 200)) {
    t.skip('default shell TCP port is already in use by another Guardian instance');
    return;
  }

  const events = [];
  const server = createShellIpcServer({ pipeName: `\\\\.\\pipe\\guardian-shell-gbtest-${Date.now()}`, onEvent: (e) => events.push(e), verifyPid: false });
  await server.start();

  try {
    // Uses async spawn(), not execFileSync(): execFileSync would block Node's whole event loop
    // for the child's lifetime, starving this in-process net server of the loop turns it needs
    // to accept the connection and read data (same lesson learned for the PowerShell hook test).
    const script = `
      source "${HOOK_POSIX}"
      eval "$PROMPT_COMMAND"
      cd /tmp
      eval "$PROMPT_COMMAND"
      eval "$PROMPT_COMMAND"
      cd "$HOME"
      eval "$PROMPT_COMMAND"
      sleep 0.3
    `;
    await new Promise((resolve, reject) => {
      const child = spawn('bash', ['-i', '-c', script], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
      child.on('exit', resolve);
      child.on('error', reject);
    });

    await waitForOutput(() => JSON.stringify(events), /SHELL_STARTED/, { timeout: 6000 });

    const started = events.filter((e) => e.type === 'SHELL_STARTED');
    const cwdChanged = events.filter((e) => e.type === 'CWD_CHANGED');
    assert.equal(started.length, 1);
    assert.equal(started[0].shell_type, 'bash');
    // Two real transitions (to /tmp, then back to $HOME) — the repeated eval while still in /tmp
    // must not produce a duplicate.
    assert.equal(cwdChanged.length, 2);
    assert.equal(started[0].shell_session_id, cwdChanged[0].shell_session_id);
  } finally {
    await server.stop();
  }
});
