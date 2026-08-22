import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JsonFileStore } from '../src/store/JsonFileStore.js';
import { Observer } from '../src/process/observer.js';
import { createFakeProcessAdapter } from '../src/process/adapter.js';

const BASE_CONFIG = {
  exclude: [],
  excludePaths: [],
  process: { captureCommandLine: 'sanitized-minimal', startupSettleMs: 40, correlationWindowMs: 4000 },
};

async function setup() {
  const dbDir = mkdtempSync(path.join(os.tmpdir(), 'guardian-proc-db-'));
  const store = new JsonFileStore(path.join(dbDir, 'guardian.db.json'));
  await store.init();
  return {
    store,
    cleanup: () => rmSync(dbDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
}

async function waitFor(conditionFn, { timeout = 3000, interval = 20 } = {}) {
  const start = Date.now();
  for (;;) {
    const result = await conditionFn();
    if (result) return result;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, interval));
  }
}

test('observer: a shell process start is classified and persisted', async () => {
  const { store, cleanup } = await setup();
  try {
    const adapter = createFakeProcessAdapter();
    const observer = new Observer({ store, config: BASE_CONFIG, adapter });
    await observer.start([]);
    await observer.whenReconciled();

    adapter.emitStart({ pid: 100, parentPid: 1, processName: 'powershell.exe', timestamp: new Date().toISOString() });
    await waitFor(async () => (await store.listProcessEvents({})).length >= 1);

    const events = await store.listProcessEvents({});
    assert.equal(events[0].classification, 'SHELL');
    assert.equal(events[0].pid, 100);
    assert.equal(events[0].parent_pid, 1);
  } finally {
    cleanup();
  }
});

test('observer: process stop is persisted and matched to the started record', async () => {
  const { store, cleanup } = await setup();
  try {
    const adapter = createFakeProcessAdapter();
    const observer = new Observer({ store, config: BASE_CONFIG, adapter });
    await observer.start([]);
    await observer.whenReconciled();

    adapter.emitStart({ pid: 200, parentPid: 1, processName: 'node.exe', timestamp: new Date().toISOString() });
    await waitFor(async () => (await store.listProcessEvents({ type: 'PROCESS_STARTED' })).length >= 1);
    adapter.emitStop({ pid: 200, parentPid: 1, processName: 'node.exe', timestamp: new Date().toISOString() });
    await waitFor(async () => (await store.listProcessEvents({ type: 'PROCESS_STOPPED' })).length >= 1);

    const stopped = (await store.listProcessEvents({ type: 'PROCESS_STOPPED' }))[0];
    assert.equal(stopped.classification, 'DEV_RUNTIME');
    assert.equal(stopped.pid, 200);
  } finally {
    cleanup();
  }
});

test('observer: OTHER-classified processes are never persisted', async () => {
  const { store, cleanup } = await setup();
  try {
    const adapter = createFakeProcessAdapter();
    const observer = new Observer({ store, config: BASE_CONFIG, adapter });
    await observer.start([]);
    await observer.whenReconciled();

    adapter.emitStart({ pid: 300, parentPid: 1, processName: 'SomeRandomApp.exe', timestamp: new Date().toISOString() });
    adapter.emitStop({ pid: 300, parentPid: 1, processName: 'SomeRandomApp.exe', timestamp: new Date().toISOString() });
    await new Promise((r) => setTimeout(r, 150));

    const events = await store.listProcessEvents({});
    assert.equal(events.length, 0);
  } finally {
    cleanup();
  }
});

test('observer: parent-child relationship is reflected in an agent session tree summary', async () => {
  const { store, cleanup } = await setup();
  try {
    const adapter = createFakeProcessAdapter();
    const observer = new Observer({ store, config: BASE_CONFIG, adapter });
    await observer.start([]);
    await observer.whenReconciled();

    const t = new Date().toISOString();
    adapter.emitStart({ pid: 400, parentPid: 1, processName: 'powershell.exe', timestamp: t });
    adapter.emitStart({ pid: 401, parentPid: 400, processName: 'claude.exe', timestamp: t });
    await waitFor(async () => (await store.listAgentSessions({})).length >= 1);

    const [session] = await store.listAgentSessions({});
    assert.equal(session.process_tree_summary, 'powershell.exe > claude.exe');
  } finally {
    cleanup();
  }
});

test('observer: agent session start -> stop reconstructs one ENDED session with duration', async () => {
  const { store, cleanup } = await setup();
  try {
    const adapter = createFakeProcessAdapter();
    const observer = new Observer({ store, config: BASE_CONFIG, adapter });
    await observer.start([]);
    await observer.whenReconciled();

    const started = new Date();
    adapter.emitStart({ pid: 500, parentPid: 1, processName: 'claude.exe', timestamp: started.toISOString() });
    await waitFor(async () => (await store.listAgentSessions({ active: true })).length >= 1);

    const ended = new Date(started.getTime() + 5000);
    adapter.emitStop({ pid: 500, parentPid: 1, processName: 'claude.exe', timestamp: ended.toISOString() });
    await waitFor(async () => (await store.listAgentSessions({ active: true })).length === 0);

    const [session] = await store.listAgentSessions({});
    assert.equal(session.status, 'ENDED');
    assert.equal(session.agent_identity, 'CLAUDE_CODE');
    assert.equal(session.duration_ms, 5000);
    assert.equal(session.started_at, started.toISOString());
  } finally {
    cleanup();
  }
});

test('observer: already-running snapshot never invents a start time when the OS could not report one', async () => {
  const { store, cleanup } = await setup();
  try {
    const adapter = createFakeProcessAdapter();
    const observer = new Observer({ store, config: BASE_CONFIG, adapter });
    await observer.start([]);
    // Emitted synchronously right after start() resolves — adapter.start() has already wired up
    // handlers by this point, and no timer callback can fire before this next line runs.
    adapter.emitAlreadyRunning({ pid: 600, parentPid: 1, processName: 'codex.exe', startTimeKnown: false, timestamp: new Date().toISOString() });
    await observer.whenReconciled();

    const [session] = await store.listAgentSessions({});
    assert.equal(session.start_source, 'ALREADY_RUNNING_AT_OBSERVER_START');
    assert.equal(session.started_at, null);
    assert.ok(session.detected_at);
    assert.equal(session.status, 'ACTIVE');
  } finally {
    cleanup();
  }
});

test('observer: already-running snapshot uses the real OS creation time when it is known', async () => {
  const { store, cleanup } = await setup();
  try {
    const adapter = createFakeProcessAdapter();
    const observer = new Observer({ store, config: BASE_CONFIG, adapter });
    const realStart = '2026-01-01T00:00:00.000Z';
    await observer.start([]);
    adapter.emitAlreadyRunning({ pid: 601, parentPid: 1, processName: 'claude.exe', startTimeKnown: true, timestamp: realStart });
    await observer.whenReconciled();

    const [session] = await store.listAgentSessions({});
    assert.equal(session.started_at, realStart);
  } finally {
    cleanup();
  }
});

test('observer: startup reconciliation continues a still-alive session across a restart (no duplicate)', async () => {
  const { store, cleanup } = await setup();
  try {
    const priorStart = '2026-01-01T00:00:00.000Z';
    await store.upsertAgentSession({
      session_id: 'prior-1',
      agent_identity: 'CLAUDE_CODE',
      pid: 700,
      parent_pid: 1,
      started_at: priorStart,
      detected_at: null,
      start_source: 'OBSERVED_START',
      ended_at: null,
      duration_ms: null,
      status: 'ACTIVE',
      possible_project_id: null,
      project_confidence: 'UNKNOWN',
      project_evidence: [],
      process_tree_summary: 'powershell.exe > claude.exe',
      runtime_id: '700:old',
      closure_note: null,
    });
    await store.startObserverSession({ session_id: 'obs-prior', started_at: priorStart, stopped_at: '2026-01-01T01:00:00.000Z', status: 'STOPPED', pid: 99999999 });

    const adapter = createFakeProcessAdapter();
    const observer = new Observer({ store, config: BASE_CONFIG, adapter });
    await observer.start([]);
    adapter.emitAlreadyRunning({ pid: 700, parentPid: 1, processName: 'claude.exe', startTimeKnown: true, timestamp: priorStart });
    await observer.whenReconciled();

    const activeSessions = await store.listAgentSessions({ active: true });
    assert.equal(activeSessions.length, 1);
    assert.equal(activeSessions[0].session_id, 'prior-1'); // reused, not duplicated
    assert.equal(activeSessions[0].started_at, priorStart); // original start time preserved
  } finally {
    cleanup();
  }
});

test('observer: PID reuse at reconciliation closes the stale session instead of continuing it', async () => {
  const { store, cleanup } = await setup();
  try {
    const priorStart = '2026-01-01T00:00:00.000Z';
    await store.upsertAgentSession({
      session_id: 'prior-2',
      agent_identity: 'CLAUDE_CODE',
      pid: 701,
      parent_pid: 1,
      started_at: priorStart,
      detected_at: null,
      start_source: 'OBSERVED_START',
      ended_at: null,
      duration_ms: null,
      status: 'ACTIVE',
      possible_project_id: null,
      project_confidence: 'UNKNOWN',
      project_evidence: [],
      process_tree_summary: null,
      runtime_id: '701:old',
      closure_note: null,
    });
    await store.startObserverSession({ session_id: 'obs-prior2', started_at: priorStart, stopped_at: '2026-01-01T01:00:00.000Z', status: 'STOPPED', pid: 99999999 });

    const adapter = createFakeProcessAdapter();
    const observer = new Observer({ store, config: BASE_CONFIG, adapter });
    await observer.start([]);
    // Same pid, but a creation time 10 minutes later — genuinely a different process instance.
    adapter.emitAlreadyRunning({ pid: 701, parentPid: 1, processName: 'python.exe', startTimeKnown: true, timestamp: '2026-01-01T00:10:00.000Z' });
    await observer.whenReconciled();

    const sessions = await store.listAgentSessions({});
    const stale = sessions.find((s) => s.session_id === 'prior-2');
    assert.notEqual(stale.status, 'ACTIVE');
    // python.exe is not an agent, so no new session is created for it — but the old one must not
    // be reported as still active either.
    const active = await store.listAgentSessions({ active: true });
    assert.equal(active.length, 0);
  } finally {
    cleanup();
  }
});

test('observer: an unclean prior observer session marks orphaned agent sessions UNCLEAN, never ENDED', async () => {
  const { store, cleanup } = await setup();
  try {
    await store.upsertAgentSession({
      session_id: 'prior-3',
      agent_identity: 'CODEX',
      pid: 702,
      parent_pid: 1,
      started_at: '2026-01-01T00:00:00.000Z',
      detected_at: null,
      start_source: 'OBSERVED_START',
      ended_at: null,
      duration_ms: null,
      status: 'ACTIVE',
      possible_project_id: null,
      project_confidence: 'UNKNOWN',
      project_evidence: [],
      process_tree_summary: null,
      runtime_id: '702:old',
      closure_note: null,
    });
    // Prior observer session never got a clean stop, and its pid is not alive — an unclean end.
    await store.startObserverSession({ session_id: 'obs-crashed', started_at: '2026-01-01T00:00:00.000Z', stopped_at: null, status: 'RUNNING', pid: 99999999 });

    const adapter = createFakeProcessAdapter();
    const observer = new Observer({ store, config: BASE_CONFIG, adapter });
    await observer.start([]); // no ALREADY_RUNNING for pid 702 — process is really gone
    await observer.whenReconciled();

    const [session] = await store.listAgentSessions({});
    assert.equal(session.status, 'UNCLEAN');
    assert.notEqual(session.status, 'ENDED'); // never invent that we witnessed a clean stop
    assert.ok(session.closure_note);
  } finally {
    cleanup();
  }
});

test('observer: multiple simultaneous agent sessions — Claude and Codex tracked independently', async () => {
  const { store, cleanup } = await setup();
  try {
    const adapter = createFakeProcessAdapter();
    const observer = new Observer({ store, config: BASE_CONFIG, adapter });
    await observer.start([]);
    await observer.whenReconciled();

    adapter.emitStart({ pid: 800, parentPid: 1, processName: 'claude.exe', timestamp: new Date().toISOString() });
    adapter.emitStart({ pid: 801, parentPid: 1, processName: 'codex.exe', timestamp: new Date().toISOString() });
    await waitFor(async () => (await store.listAgentSessions({ active: true })).length >= 2);

    const sessions = await store.listAgentSessions({ active: true });
    const identities = sessions.map((s) => s.agent_identity).sort();
    assert.deepEqual(identities, ['CLAUDE_CODE', 'CODEX']);
  } finally {
    cleanup();
  }
});

test('observer: a parent and its child starting back-to-back (no gap) still correlate correctly — event processing is serialized (V0.5B real E2E fix)', async () => {
  const { store, cleanup } = await setup();
  try {
    const adapter = createFakeProcessAdapter();
    const observer = new Observer({ store, config: BASE_CONFIG, adapter });
    await observer.start([{ id: 'pg', name: 'PROJECT-GUARDIAN', root_path: 'D:\\PROJECT-GUARDIAN' }]);
    await observer.whenReconciled();

    // Fired with zero delay between them, exactly like a real shell immediately spawning a
    // child process — before this fix, the child's #handleStart could run its "inherited from
    // correlated ancestor" lookup before the parent's own correlation had been computed and
    // stored, silently losing evidence that was genuinely available a moment later.
    adapter.emitStart({ pid: 900, parentPid: 1, processName: 'powershell.exe', executablePath: 'D:\\PROJECT-GUARDIAN\\shim\\powershell.exe', timestamp: new Date().toISOString() });
    adapter.emitStart({ pid: 901, parentPid: 900, processName: 'claude.exe', timestamp: new Date().toISOString() });

    await waitFor(async () => (await store.listAgentSessions({ active: true })).length >= 1);
    const [session] = await store.listAgentSessions({ active: true });
    assert.equal(session.possible_project_id, 'pg');
    assert.notEqual(session.project_confidence, 'UNKNOWN');
  } finally {
    cleanup();
  }
});

test('observer: no secret ever persisted in a process event', async () => {
  const { store, cleanup } = await setup();
  try {
    const adapter = createFakeProcessAdapter();
    const observer = new Observer({ store, config: BASE_CONFIG, adapter });
    await observer.start([]);
    await observer.whenReconciled();

    adapter.emitStart({
      pid: 900,
      parentPid: 1,
      processName: 'node.exe',
      commandLine: 'node deploy.js --api-key sk-THIS-IS-SECRET --token TOKEN-SECRET Authorization: Bearer BEARER-SECRET',
      timestamp: new Date().toISOString(),
    });
    await waitFor(async () => (await store.listProcessEvents({})).length >= 1);

    const dump = JSON.stringify(await store.listProcessEvents({}));
    assert.ok(!dump.includes('SECRET'));
    const [event] = await store.listProcessEvents({});
    assert.equal(event.command_metadata.redactedCount > 0, true);
    assert.ok(!('commandLine' in event));
  } finally {
    cleanup();
  }
});

test('observer: adapter failure marks DEGRADED without crashing, and the observer keeps working', async () => {
  const { store, cleanup } = await setup();
  try {
    const adapter = createFakeProcessAdapter();
    const observer = new Observer({ store, config: BASE_CONFIG, adapter });
    await observer.start([]);
    await observer.whenReconciled();

    adapter.emitError(new Error('CIM registration denied'));
    assert.equal(observer.health().status, 'DEGRADED');

    adapter.emitStart({ pid: 1000, parentPid: 1, processName: 'git.exe', timestamp: new Date().toISOString() });
    await waitFor(async () => (await store.listProcessEvents({})).length >= 1);
    assert.equal((await store.listProcessEvents({}))[0].classification, 'VERSION_CONTROL');
  } finally {
    cleanup();
  }
});

test('observer: event persistence — filters by type and since work', async () => {
  const { store, cleanup } = await setup();
  try {
    const adapter = createFakeProcessAdapter();
    const observer = new Observer({ store, config: BASE_CONFIG, adapter });
    await observer.start([]);
    await observer.whenReconciled();

    adapter.emitStart({ pid: 1100, parentPid: 1, processName: 'git.exe', timestamp: new Date().toISOString() });
    await waitFor(async () => (await store.listProcessEvents({ type: 'PROCESS_STARTED' })).length >= 1);
    adapter.emitStop({ pid: 1100, parentPid: 1, processName: 'git.exe', timestamp: new Date().toISOString() });
    await waitFor(async () => (await store.listProcessEvents({ type: 'PROCESS_STOPPED' })).length >= 1);

    const future = new Date(Date.now() + 60_000).toISOString();
    assert.equal((await store.listProcessEvents({ sinceIso: future })).length, 0);
    assert.equal((await store.listProcessEvents({ type: 'PROCESS_STARTED' })).length, 1);
    assert.equal((await store.listProcessEvents({ type: 'PROCESS_STOPPED' })).length, 1);
  } finally {
    cleanup();
  }
});

test('observer: graceful stop records STOPPED without ending sessions it did not witness stopping', async () => {
  const { store, cleanup } = await setup();
  try {
    const adapter = createFakeProcessAdapter();
    const observer = new Observer({ store, config: BASE_CONFIG, adapter });
    await observer.start([]);
    await observer.whenReconciled();

    adapter.emitStart({ pid: 1200, parentPid: 1, processName: 'claude.exe', timestamp: new Date().toISOString() });
    await waitFor(async () => (await store.listAgentSessions({ active: true })).length >= 1);

    await observer.stop('STOPPED');

    const active = await store.listAgentSessions({ active: true });
    assert.equal(active.length, 1, 'a clean Guardian stop must not fabricate an end for a still-running agent');

    const observerSession = await store.getLatestObserverSession();
    assert.equal(observerSession.status, 'STOPPED');
  } finally {
    cleanup();
  }
});
