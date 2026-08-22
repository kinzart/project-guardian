import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JsonFileStore } from '../src/store/JsonFileStore.js';
import { WslShellObserver } from '../src/shell/wsl/observer.js';

// Fake IPC server factory — mirrors test/shell-observer.test.js's createFakeIpcFactory, but for
// the WSL-specific factory shape (still onEvent/onRejected/onError, no pid-liveness concept).
function createFakeIpcFactory() {
  let handlers = null;
  const factory = (opts) => {
    handlers = opts;
    return { start: () => Promise.resolve(), stop: () => Promise.resolve() };
  };
  factory.emit = (validEvent) => handlers.onEvent(validEvent);
  factory.emitRejected = (info) => handlers.onRejected?.(info);
  factory.emitError = (err) => handlers.onError?.(err);
  return factory;
}

async function setup() {
  const dbDir = mkdtempSync(path.join(os.tmpdir(), 'guardian-wsl-observer-db-'));
  const store = new JsonFileStore(path.join(dbDir, 'guardian.db.json'));
  await store.init();
  return { store, dbDir, cleanup: () => rmSync(dbDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
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

test('wsl-observer: SHELL_STARTED with a Windows-backed cwd persists a session + event and resolves the project', async () => {
  const { store, cleanup } = await setup();
  try {
    const factory = createFakeIpcFactory();
    const observer = new WslShellObserver({ store, ipcServerFactory: factory });
    await observer.start(PROJECTS);
    factory.emit({
      type: 'SHELL_STARTED',
      shell_session_id: 'wsl-s1',
      shell_type: 'WSL_BASH',
      distro: 'Ubuntu',
      wsl_version: '2',
      linux_pid: 500,
      linux_parent_pid: 1,
      bash_version: '5.1.16(1)-release',
      cwd_linux: '/mnt/d/PROJECT-GUARDIAN',
      cwd_project_identity: 'windows:D:\\PROJECT-GUARDIAN',
      timestamp: 't0',
    });
    await waitFor(async () => (await store.listShellSessions({})).length === 1);
    const [session] = await store.listShellSessions({});
    assert.equal(session.status, 'ACTIVE');
    assert.equal(session.shell_type, 'WSL_BASH');
    assert.equal(session.host_name, 'Ubuntu');
    const [event] = await store.listShellEvents({});
    assert.equal(event.project_id, 'pg');
  } finally {
    cleanup();
  }
});

test('wsl-observer: a WSL-native cwd (no Windows equivalent) stays UNKNOWN, never guessed', async () => {
  const { store, cleanup } = await setup();
  try {
    const factory = createFakeIpcFactory();
    const observer = new WslShellObserver({ store, ipcServerFactory: factory });
    await observer.start(PROJECTS);
    factory.emit({
      type: 'SHELL_STARTED',
      shell_session_id: 'wsl-s2',
      shell_type: 'WSL_BASH',
      distro: 'Ubuntu',
      wsl_version: '2',
      linux_pid: 501,
      linux_parent_pid: 1,
      bash_version: '5.1.16(1)-release',
      cwd_linux: '/home/tester/native-only-project',
      cwd_project_identity: 'wsl:Ubuntu:/home/tester/native-only-project',
      timestamp: 't0',
    });
    await waitFor(async () => (await store.listShellSessions({})).length === 1);
    const [event] = await store.listShellEvents({});
    assert.equal(event.project_id, null);
    assert.equal(event.cwd, null);
  } finally {
    cleanup();
  }
});

test('wsl-observer: duplicate CWD_CHANGED is suppressed, a real change persists', async () => {
  const { store, cleanup } = await setup();
  try {
    const factory = createFakeIpcFactory();
    const observer = new WslShellObserver({ store, ipcServerFactory: factory });
    await observer.start(PROJECTS);
    factory.emit({ type: 'SHELL_STARTED', shell_session_id: 'wsl-s3', shell_type: 'WSL_BASH', distro: 'Ubuntu', wsl_version: '2', linux_pid: 502, linux_parent_pid: 1, bash_version: '5.1', cwd_linux: '/home/x', cwd_project_identity: 'wsl:Ubuntu:/home/x', timestamp: 't0' });
    await waitFor(async () => (await store.listShellSessions({})).length === 1);

    factory.emit({ type: 'CWD_CHANGED', shell_session_id: 'wsl-s3', distro: 'Ubuntu', linux_pid: 502, cwd_linux: '/home/x', cwd_project_identity: 'wsl:Ubuntu:/home/x', timestamp: 't1' });
    factory.emit({ type: 'CWD_CHANGED', shell_session_id: 'wsl-s3', distro: 'Ubuntu', linux_pid: 502, cwd_linux: '/mnt/d/PROJECT-GUARDIAN', cwd_project_identity: 'windows:D:\\PROJECT-GUARDIAN', timestamp: 't2' });
    await waitFor(async () => (await store.listShellEvents({ type: 'CWD_CHANGED' })).length === 1);

    assert.equal(observer.stats.duplicateCwdSuppressed, 1);
    assert.equal(observer.stats.cwdChanges, 1);
  } finally {
    cleanup();
  }
});

test('wsl-observer: SHELL_EXITING marks the session ENDED', async () => {
  const { store, cleanup } = await setup();
  try {
    const factory = createFakeIpcFactory();
    const observer = new WslShellObserver({ store, ipcServerFactory: factory });
    await observer.start(PROJECTS);
    factory.emit({ type: 'SHELL_STARTED', shell_session_id: 'wsl-s4', shell_type: 'WSL_BASH', distro: 'Ubuntu', wsl_version: '2', linux_pid: 503, linux_parent_pid: 1, bash_version: '5.1', cwd_linux: '/home/x', timestamp: 't0' });
    await waitFor(async () => (await store.listShellSessions({})).length === 1);

    factory.emit({ type: 'SHELL_EXITING', shell_session_id: 'wsl-s4', distro: 'Ubuntu', linux_pid: 503, timestamp: 't1' });
    await waitFor(async () => (await store.getShellSession('wsl-s4')).status !== 'ACTIVE');
    assert.equal((await store.getShellSession('wsl-s4')).status, 'ENDED');
  } finally {
    cleanup();
  }
});

test('wsl-observer: HEARTBEAT keeps a session out of the staleness sweep without mutating it', async () => {
  const { store, cleanup } = await setup();
  try {
    const factory = createFakeIpcFactory();
    const observer = new WslShellObserver({ store, ipcServerFactory: factory, heartbeatIntervalMs: 60_000 });
    await observer.start(PROJECTS);
    factory.emit({ type: 'SHELL_STARTED', shell_session_id: 'wsl-s5', shell_type: 'WSL_BASH', distro: 'Ubuntu', wsl_version: '2', linux_pid: 504, linux_parent_pid: 1, bash_version: '5.1', cwd_linux: '/home/x', timestamp: 't0' });
    await waitFor(async () => (await store.listShellSessions({})).length === 1);

    factory.emit({ type: 'HEARTBEAT', shell_session_id: 'wsl-s5', linux_pid: 504, timestamp: 't1' });
    await waitFor(() => observer.stats.heartbeats === 1);
    assert.equal((await store.getShellSession('wsl-s5')).status, 'ACTIVE');
  } finally {
    cleanup();
  }
});

test('wsl-observer: staleness sweep marks a silent ACTIVE session STALE, never ENDED (no reconciliation path exists for WSL)', async () => {
  const { store, cleanup } = await setup();
  try {
    const factory = createFakeIpcFactory();
    const observer = new WslShellObserver({ store, ipcServerFactory: factory, heartbeatIntervalMs: 50 });
    await observer.start(PROJECTS);
    factory.emit({ type: 'SHELL_STARTED', shell_session_id: 'wsl-s6', shell_type: 'WSL_BASH', distro: 'Ubuntu', wsl_version: '2', linux_pid: 505, linux_parent_pid: 1, bash_version: '5.1', cwd_linux: '/home/x', timestamp: 't0' });
    await waitFor(async () => (await store.listShellSessions({})).length === 1);

    await waitFor(async () => (await store.getShellSession('wsl-s6')).status === 'STALE', { timeout: 2000 });
    assert.equal(observer.stats.staleDetected >= 1, true);
    assert.notEqual((await store.getShellSession('wsl-s6')).status, 'ENDED');
  } finally {
    cleanup();
  }
});

test('wsl-observer: two distros reporting the SAME linux_pid stay isolated via shell_session_id (no cross-distro collision)', async () => {
  const { store, cleanup } = await setup();
  try {
    const factory = createFakeIpcFactory();
    const observer = new WslShellObserver({ store, ipcServerFactory: factory });
    await observer.start(PROJECTS);

    factory.emit({ type: 'SHELL_STARTED', shell_session_id: 'ubuntu-s1', shell_type: 'WSL_BASH', distro: 'Ubuntu', wsl_version: '2', linux_pid: 700, linux_parent_pid: 1, bash_version: '5.1', cwd_linux: '/home/ubuntu-home', cwd_project_identity: 'wsl:Ubuntu:/home/ubuntu-home', timestamp: 't0' });
    factory.emit({ type: 'SHELL_STARTED', shell_session_id: 'debian-s1', shell_type: 'WSL_BASH', distro: 'Debian', wsl_version: '2', linux_pid: 700, linux_parent_pid: 1, bash_version: '5.1', cwd_linux: '/home/debian-home', cwd_project_identity: 'wsl:Debian:/home/debian-home', timestamp: 't0' });
    await waitFor(async () => (await store.listShellSessions({})).length === 2);

    factory.emit({ type: 'CWD_CHANGED', shell_session_id: 'ubuntu-s1', distro: 'Ubuntu', linux_pid: 700, cwd_linux: '/mnt/d/PROJECT-GUARDIAN', cwd_project_identity: 'windows:D:\\PROJECT-GUARDIAN', timestamp: 't1' });
    await waitFor(async () => (await store.getShellSession('ubuntu-s1')).cwd_timeline.length === 2);

    const ubuntu = await store.getShellSession('ubuntu-s1');
    const debian = await store.getShellSession('debian-s1');
    assert.equal(ubuntu.cwd, 'D:\\PROJECT-GUARDIAN');
    assert.equal(debian.cwd_timeline.length, 1); // untouched by the Ubuntu session's cwd change
  } finally {
    cleanup();
  }
});

test('wsl-observer: writes a fresh auth token to dataDir on start (never baked into a startup file)', async () => {
  const { store, cleanup } = await setup();
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'guardian-wsl-observer-token-'));
  try {
    const factory = createFakeIpcFactory();
    const observer = new WslShellObserver({ store, ipcServerFactory: factory, dataDir });
    await observer.start(PROJECTS);
    const token = readFileSync(path.join(dataDir, 'wsl-auth.token'), 'utf8');
    assert.equal(token, observer.authToken);
    assert.ok(token.length > 0);
  } finally {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    cleanup();
  }
});

test('wsl-observer: a schema-rejected event is counted and never crashes the observer', async () => {
  const { store, cleanup } = await setup();
  try {
    const factory = createFakeIpcFactory();
    const observer = new WslShellObserver({ store, ipcServerFactory: factory });
    await observer.start(PROJECTS);
    factory.emitRejected({ reason: 'forbidden field: bash_command' });
    assert.equal(observer.stats.schemaRejections, 1);
    assert.equal(observer.health().status, 'RUNNING');
  } finally {
    cleanup();
  }
});
