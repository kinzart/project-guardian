import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createShellIpcServer, probePipe } from '../src/shell/ipc-server.js';

function uniquePipeName() {
  return `\\\\.\\pipe\\guardian-shell-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// These tests exercise the named-pipe transport specifically; tcpPort: null skips binding the
// TCP loopback listener entirely (see SPEC_V0.5B.md section 5 for what it's for).
function createTestServer(opts) {
  return createShellIpcServer({ tcpPort: null, ...opts });
}

function sendLine(pipeName, obj) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: pipeName }, () => {
      socket.write(`${JSON.stringify(obj)}\n`, () => {
        socket.end();
        resolve();
      });
    });
    socket.on('error', reject);
  });
}

async function waitFor(conditionFn, { timeout = 3000, interval = 20 } = {}) {
  const start = Date.now();
  for (;;) {
    if (conditionFn()) return;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, interval));
  }
}

test('ipc-server: a valid SHELL_STARTED event round-trips over the real named pipe', async () => {
  const pipeName = uniquePipeName();
  const events = [];
  const server = createTestServer({ pipeName, onEvent: (e) => events.push(e), verifyPid: false });
  await server.start();
  try {
    await sendLine(pipeName, { type: 'SHELL_STARTED', shell_session_id: 's1', pid: 12345, parent_pid: 1, shell_type: 'Desktop', shell_version: '5.1', host_name: 'x', cwd: 'D:\\X', timestamp: '2026-01-01T00:00:00.000Z' });
    await waitFor(() => events.length === 1);
    assert.equal(events[0].type, 'SHELL_STARTED');
  } finally {
    await server.stop();
  }
});

test('ipc-server: an event with a "command" field is rejected, not silently stripped', async () => {
  const pipeName = uniquePipeName();
  const events = [];
  const rejections = [];
  const server = createTestServer({ pipeName, onEvent: (e) => events.push(e), onRejected: (r) => rejections.push(r), verifyPid: false });
  await server.start();
  try {
    await sendLine(pipeName, { type: 'CWD_CHANGED', shell_session_id: 's1', pid: 12345, cwd: 'D:\\X', timestamp: 't', command: 'secret' });
    await waitFor(() => rejections.length === 1);
    assert.equal(events.length, 0);
    assert.match(rejections[0].reason, /forbidden/);
  } finally {
    await server.stop();
  }
});

test('ipc-server: malformed JSON is rejected without crashing the server', async () => {
  const pipeName = uniquePipeName();
  const rejections = [];
  const events = [];
  const server = createTestServer({ pipeName, onEvent: (e) => events.push(e), onRejected: (r) => rejections.push(r), verifyPid: false });
  await server.start();
  try {
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: pipeName }, () => {
        socket.write('{not valid json\n', () => {
          socket.end();
          resolve();
        });
      });
      socket.on('error', reject);
    });
    await waitFor(() => rejections.length === 1);

    // server must still be alive for a subsequent, valid client
    await sendLine(pipeName, { type: 'SHELL_EXITING', shell_session_id: 's1', pid: 12345, timestamp: 't' });
    await waitFor(() => events.length === 1);
  } finally {
    await server.stop();
  }
});

test('ipc-server: an event whose pid does not exist is rejected (IPC trust)', async () => {
  const pipeName = uniquePipeName();
  const events = [];
  const rejections = [];
  const server = createTestServer({ pipeName, onEvent: (e) => events.push(e), onRejected: (r) => rejections.push(r), verifyPid: true });
  await server.start();
  try {
    await sendLine(pipeName, { type: 'SHELL_STARTED', shell_session_id: 's1', pid: 999999999, shell_type: 'Desktop', shell_version: '5.1', host_name: 'x', cwd: 'D:\\X', timestamp: 't' });
    await waitFor(() => rejections.length === 1);
    assert.equal(events.length, 0);
    assert.match(rejections[0].reason, /pid not alive/);
  } finally {
    await server.stop();
  }
});

test('ipc-server: SHELL_EXITING is exempt from the pid-liveness check (V0.5B — Cygwin/MSYS exit timing)', async () => {
  const pipeName = uniquePipeName();
  const events = [];
  const rejections = [];
  const server = createTestServer({ pipeName, onEvent: (e) => events.push(e), onRejected: (r) => rejections.push(r), verifyPid: true });
  await server.start();
  try {
    // Even a pid that is definitely not alive must still be accepted for SHELL_EXITING — see
    // SPEC_V0.5B.md: real Git Bash exit timing means the pid can legitimately already be gone.
    await sendLine(pipeName, { type: 'SHELL_EXITING', shell_session_id: 's1', pid: 999999999, timestamp: 't' });
    await waitFor(() => events.length === 1);
    assert.equal(rejections.length, 0);
    assert.equal(events[0].type, 'SHELL_EXITING');
  } finally {
    await server.stop();
  }
});

test('ipc-server: multiple concurrent clients (multiple shells) are all handled', async () => {
  const pipeName = uniquePipeName();
  const events = [];
  const server = createTestServer({ pipeName, onEvent: (e) => events.push(e), verifyPid: false });
  await server.start();
  try {
    await Promise.all([
      sendLine(pipeName, { type: 'SHELL_STARTED', shell_session_id: 's1', pid: 1, shell_type: 'Desktop', shell_version: '5.1', host_name: 'x', cwd: 'D:\\A', timestamp: 't' }),
      sendLine(pipeName, { type: 'SHELL_STARTED', shell_session_id: 's2', pid: 2, shell_type: 'Core', shell_version: '7.4', host_name: 'x', cwd: 'D:\\B', timestamp: 't' }),
      sendLine(pipeName, { type: 'SHELL_STARTED', shell_session_id: 's3', pid: 3, shell_type: 'Desktop', shell_version: '5.1', host_name: 'x', cwd: 'D:\\C', timestamp: 't' }),
    ]);
    await waitFor(() => events.length === 3);
    const ids = events.map((e) => e.shell_session_id).sort();
    assert.deepEqual(ids, ['s1', 's2', 's3']);
  } finally {
    await server.stop();
  }
});

test('ipc-server: a TCP-port-only bind failure degrades gracefully instead of crashing (V0.5B real E2E fix)', async () => {
  // Regression test for a genuine unhandled-promise-rejection bug: the TCP listen() attempt
  // starts immediately (Promise executors run synchronously), in parallel with the pipe, not
  // sequentially after it — so if TCP fails before the pipe settles, and nothing has attached a
  // .catch() to that rejection yet, Node treats it as an unhandled rejection and can crash the
  // whole process. Confirmed via real E2E (a real `guardian observe` already holding the default
  // TCP port caused a freshly spawned one to crash outright rather than just log Shell IPC:
  // degraded).
  const pipeName = uniquePipeName();
  const busyPort = 47950 + Math.floor(Math.random() * 500);

  // Occupy the TCP port first, so the real server's TCP bind is guaranteed to fail.
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(busyPort, '127.0.0.1', resolve));

  const errors = [];
  const server = createShellIpcServer({ pipeName, tcpPort: busyPort, onError: (err) => errors.push(err), verifyPid: false });
  try {
    await server.start(); // must resolve (not reject) — the pipe itself is fine
    await waitFor(() => errors.length >= 1);
    assert.match(errors[0].message, /EADDRINUSE/);
  } finally {
    await server.stop();
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test('ipc-server: probePipe reports false when nothing is listening, true once a server starts', async () => {
  const pipeName = uniquePipeName();
  assert.equal(await probePipe(pipeName, 150), false);
  const server = createTestServer({ pipeName, verifyPid: false });
  await server.start();
  try {
    assert.equal(await probePipe(pipeName, 500), true);
  } finally {
    await server.stop();
  }
});

test('ipc-server: a client connecting to a nonexistent pipe fails safely (no server-affecting crash) — this is what "Guardian offline" looks like from the hook side', async () => {
  const pipeName = uniquePipeName(); // never started
  await assert.rejects(() =>
    new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: pipeName });
      socket.on('connect', resolve);
      socket.on('error', reject);
    }),
  );
});
