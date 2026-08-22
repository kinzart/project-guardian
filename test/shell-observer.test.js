import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JsonFileStore } from '../src/store/JsonFileStore.js';
import { ShellObserver } from '../src/shell/observer.js';
import { Observer } from '../src/process/observer.js';
import { createFakeProcessAdapter } from '../src/process/adapter.js';

// Fake IPC server factory — mirrors src/process/adapter.js's createFakeProcessAdapter pattern.
// Bypasses schema.js (already covered by test/shell-ipc.test.js) so these tests focus purely on
// ShellObserver's own session/correlation wiring.
function createFakeIpcFactory() {
  let handlers = null;
  const factory = (opts) => {
    handlers = opts;
    return { start: () => Promise.resolve(), stop: () => Promise.resolve() };
  };
  factory.emit = (validEvent) => handlers.onEvent(validEvent);
  factory.emitError = (err) => handlers.onError?.(err);
  return factory;
}

async function setup() {
  const dbDir = mkdtempSync(path.join(os.tmpdir(), 'guardian-shell-db-'));
  const store = new JsonFileStore(path.join(dbDir, 'guardian.db.json'));
  await store.init();
  return { store, cleanup: () => rmSync(dbDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

async function waitFor(conditionFn, { timeout = 3000, interval = 20 } = {}) {
  const start = Date.now();
  for (;;) {
    if (await conditionFn()) return;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, interval));
  }
}

const PROJECTS = [{ id: 'pg', name: 'PROJECT-GUARDIAN', root_path: 'D:\\PROJECT-GUARDIAN' }];

test('shell-observer: SHELL_STARTED persists a session and an event', async () => {
  const { store, cleanup } = await setup();
  try {
    const factory = createFakeIpcFactory();
    const observer = new ShellObserver({ store, ipcServerFactory: factory });
    await observer.start(PROJECTS);
    factory.emit({ type: 'SHELL_STARTED', shell_session_id: 's1', pid: 100, parent_pid: 1, shell_type: 'Desktop', shell_version: '5.1', host_name: 'x', cwd: 'D:\\PROJECT-GUARDIAN', timestamp: 't0' });
    await waitFor(async () => (await store.listShellSessions({})).length === 1);
    const [session] = await store.listShellSessions({});
    assert.equal(session.status, 'ACTIVE');
    const [event] = await store.listShellEvents({});
    assert.equal(event.type, 'SHELL_STARTED');
    assert.equal(event.project_id, 'pg'); // resolved from cwd
  } finally {
    cleanup();
  }
});

test('shell-observer: duplicate CWD_CHANGED is suppressed, real change persists', async () => {
  const { store, cleanup } = await setup();
  try {
    const factory = createFakeIpcFactory();
    const observer = new ShellObserver({ store, ipcServerFactory: factory });
    await observer.start(PROJECTS);
    factory.emit({ type: 'SHELL_STARTED', shell_session_id: 's1', pid: 100, parent_pid: 1, shell_type: 'Desktop', shell_version: '5.1', host_name: 'x', cwd: 'D:\\A', timestamp: 't0' });
    await waitFor(async () => (await store.listShellSessions({})).length === 1);

    factory.emit({ type: 'CWD_CHANGED', shell_session_id: 's1', pid: 100, cwd: 'D:\\A', timestamp: 't1' });
    factory.emit({ type: 'CWD_CHANGED', shell_session_id: 's1', pid: 100, cwd: 'D:\\PROJECT-GUARDIAN', timestamp: 't2' });
    await waitFor(async () => (await store.listShellEvents({ type: 'CWD_CHANGED' })).length === 1);

    assert.equal(observer.stats.duplicateCwdSuppressed, 1);
    assert.equal(observer.stats.cwdChanges, 1);
  } finally {
    cleanup();
  }
});

test('shell-observer: reconcileProcessStopped never marks a session ENDED', async () => {
  const { store, cleanup } = await setup();
  try {
    const factory = createFakeIpcFactory();
    const observer = new ShellObserver({ store, ipcServerFactory: factory });
    await observer.start(PROJECTS);
    factory.emit({ type: 'SHELL_STARTED', shell_session_id: 's1', pid: 100, parent_pid: 1, shell_type: 'Desktop', shell_version: '5.1', host_name: 'x', cwd: 'D:\\A', timestamp: 't0' });
    await waitFor(async () => (await store.listShellSessions({})).length === 1);

    observer.reconcileProcessStopped(100, 't5');
    await waitFor(async () => (await store.getShellSession('s1')).status !== 'ACTIVE');
    const session = await store.getShellSession('s1');
    assert.equal(session.status, 'UNCLEAN');
  } finally {
    cleanup();
  }
});

test('shell-observer + process observer: shell/process pid matching + Claude correlation HIGH via explicit CWD', async () => {
  const { store, cleanup } = await setup();
  try {
    const shellFactory = createFakeIpcFactory();
    const shellObserver = new ShellObserver({ store, ipcServerFactory: shellFactory });
    await shellObserver.start(PROJECTS);

    const procAdapter = createFakeProcessAdapter();
    const procConfig = { process: { captureCommandLine: 'sanitized-minimal', startupSettleMs: 40, correlationWindowMs: 4000 } };
    const procObserver = new Observer({
      store,
      config: procConfig,
      adapter: procAdapter,
      shellRegistry: shellObserver.registry,
      onShellProcessStopped: (pid, ts) => shellObserver.reconcileProcessStopped(pid, ts),
    });
    await procObserver.start(PROJECTS);
    await procObserver.whenReconciled();

    // A PowerShell shell starts, CWD is the project root.
    shellFactory.emit({ type: 'SHELL_STARTED', shell_session_id: 'shell-1', pid: 1000, parent_pid: 1, shell_type: 'Desktop', shell_version: '5.1', host_name: 'x', cwd: 'D:\\PROJECT-GUARDIAN', timestamp: 't0' });
    await waitFor(async () => (await store.listShellSessions({})).length === 1);

    // Claude starts as a CHILD of that shell (pid=1000).
    procAdapter.emitStart({ pid: 2000, parentPid: 1000, processName: 'claude.exe', timestamp: new Date().toISOString() });
    await waitFor(async () => (await store.listAgentSessions({ active: true })).length === 1);

    const [agentSession] = await store.listAgentSessions({ active: true });
    assert.equal(agentSession.possible_project_id, 'pg');
    assert.equal(agentSession.project_confidence, 'HIGH');
    assert.ok(agentSession.project_evidence.some((e) => e.toLowerCase().includes('shell')));

    // An unrelated agent process (different, unknown parent) must stay UNKNOWN — case 23.
    procAdapter.emitStart({ pid: 2001, parentPid: 9999, processName: 'codex.exe', timestamp: new Date().toISOString() });
    await waitFor(async () => (await store.listAgentSessions({ active: true })).length === 2);
    const unrelated = (await store.listAgentSessions({ active: true })).find((s) => s.pid === 2001);
    assert.equal(unrelated.possible_project_id, null);
    assert.equal(unrelated.project_confidence, 'UNKNOWN');

    // The shell's OS process stops WITHOUT a SHELL_EXITING — process observer reconciles it.
    procAdapter.emitStart({ pid: 1000, parentPid: 1, processName: 'powershell.exe', timestamp: new Date().toISOString() }); // establish SHELL classification in the tree
    procAdapter.emitStop({ pid: 1000, parentPid: 1, processName: 'powershell.exe', timestamp: new Date().toISOString() });
    await waitFor(async () => (await store.getShellSession('shell-1')).status !== 'ACTIVE');
    assert.equal((await store.getShellSession('shell-1')).status, 'UNCLEAN');
  } finally {
    cleanup();
  }
});

test('shell-observer + process observer (V0.5B): a Git Bash session correlates a child Claude the same way a PowerShell one does', async () => {
  const { store, cleanup } = await setup();
  try {
    const shellFactory = createFakeIpcFactory();
    const shellObserver = new ShellObserver({ store, ipcServerFactory: shellFactory });
    await shellObserver.start(PROJECTS);

    const procAdapter = createFakeProcessAdapter();
    const procConfig = { process: { captureCommandLine: 'sanitized-minimal', startupSettleMs: 40, correlationWindowMs: 4000 } };
    const procObserver = new Observer({ store, config: procConfig, adapter: procAdapter, shellRegistry: shellObserver.registry });
    await procObserver.start(PROJECTS);
    await procObserver.whenReconciled();

    // Git Bash reports its cwd in the forward-slash form `pwd -W` actually produces — exercises
    // normalization end to end, not just the unit-level path-normalizer test.
    shellFactory.emit({
      type: 'SHELL_STARTED',
      shell_session_id: 'bash-shell-1',
      pid: 3000,
      parent_pid: 1,
      shell_type: 'bash',
      shell_version: '5.3.15(1)-release',
      host_name: 'MINGW64',
      cwd: 'D:/PROJECT-GUARDIAN',
      timestamp: 't0',
    });
    await waitFor(async () => (await store.listShellSessions({})).length === 1);
    assert.equal((await store.getShellSession('bash-shell-1')).cwd, 'D:\\PROJECT-GUARDIAN');

    procAdapter.emitStart({ pid: 4000, parentPid: 3000, processName: 'claude.exe', timestamp: new Date().toISOString() });
    await waitFor(async () => (await store.listAgentSessions({ active: true })).length === 1);

    const [agentSession] = await store.listAgentSessions({ active: true });
    assert.equal(agentSession.possible_project_id, 'pg');
    assert.equal(agentSession.project_confidence, 'HIGH');
  } finally {
    cleanup();
  }
});
