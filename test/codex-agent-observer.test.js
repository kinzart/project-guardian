import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JsonFileStore } from '../src/store/JsonFileStore.js';
import { CodexAgentObserver } from '../src/agent/codex/observer.js';
import { CONFIDENCE } from '../src/intelligence/field.js';
import { ProcessTree } from '../src/process/process-tree.js';

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
  const dbDir = mkdtempSync(path.join(os.tmpdir(), 'guardian-codex-agent-observer-'));
  const store = new JsonFileStore(path.join(dbDir, 'guardian.db.json'));
  await store.init();
  return { store, cleanup: () => rmSync(dbDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

const PROJECTS = [{ id: 'pg', name: 'PROJECT-GUARDIAN', root_path: 'D:\\PROJECT-GUARDIAN' }];

test('codex-observer: SessionStart with a cwd resolving under a project root creates an AUTHORITATIVE session', async () => {
  const { store, cleanup } = await setup();
  try {
    const factory = createFakeIpcFactory();
    const observer = new CodexAgentObserver({ store, ipcServerFactory: factory });
    await observer.start(PROJECTS);
    await factory.emit({ hook_event_name: 'SessionStart', session_id: 'native-1', cwd: 'D:\\PROJECT-GUARDIAN', model: 'gpt-5-codex', source: 'startup', native_process_pid: 999, timestamp: 't0' });

    const sessions = await store.listAgentSessions({});
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].agent_identity, 'CODEX');
    assert.equal(sessions[0].possible_project_id, 'pg');
    assert.equal(sessions[0].project_confidence, CONFIDENCE.AUTHORITATIVE);
    assert.deepEqual(sessions[0].evidence_sources, ['CODEX_NATIVE']);
    assert.equal(sessions[0].native_session_id, 'native-1');
    assert.equal(sessions[0].native_metadata.model, 'gpt-5-codex');
    assert.equal(observer.stats.sessionsStarted, 1);
  } finally {
    cleanup();
  }
});

test('codex-observer: a cwd that does not resolve under any known project stays UNKNOWN — never fabricated', async () => {
  const { store, cleanup } = await setup();
  try {
    const factory = createFakeIpcFactory();
    const observer = new CodexAgentObserver({ store, ipcServerFactory: factory });
    await observer.start(PROJECTS);
    await factory.emit({ hook_event_name: 'SessionStart', session_id: 'native-2', cwd: 'D:\\somewhere-else', source: 'startup', native_process_pid: 1000, timestamp: 't0' });

    const [session] = await store.listAgentSessions({});
    assert.equal(session.possible_project_id, null);
    assert.equal(session.project_confidence, CONFIDENCE.UNKNOWN);
  } finally {
    cleanup();
  }
});

test('codex-observer: enriches an existing PROCESS-sourced agentSession by direct pid match', async () => {
  const { store, cleanup } = await setup();
  try {
    await store.upsertAgentSession({
      session_id: 'proc-session-1',
      agent_identity: 'CODEX',
      pid: 5555,
      parent_pid: 100,
      started_at: '2026-08-20T09:00:00.000Z',
      status: 'ACTIVE',
      possible_project_id: null,
      project_confidence: CONFIDENCE.UNKNOWN,
      project_evidence: [],
      evidence_sources: ['PROCESS'],
      shell_session_id: 'shell-1',
      native_session_id: null,
      native_metadata: null,
    });

    const factory = createFakeIpcFactory();
    const observer = new CodexAgentObserver({ store, ipcServerFactory: factory });
    await observer.start(PROJECTS);
    await factory.emit({ hook_event_name: 'SessionStart', session_id: 'native-3', cwd: 'D:\\PROJECT-GUARDIAN', source: 'startup', native_process_pid: 5555, timestamp: 't0' });

    const sessions = await store.listAgentSessions({});
    assert.equal(sessions.length, 1); // enriched in place, never duplicated
    assert.equal(sessions[0].session_id, 'proc-session-1');
    assert.equal(sessions[0].native_session_id, 'native-3');
    assert.deepEqual(sessions[0].evidence_sources.sort(), ['CODEX_NATIVE', 'PROCESS'].sort());
    assert.equal(sessions[0].project_confidence, CONFIDENCE.AUTHORITATIVE);
    assert.equal(sessions[0].shell_session_id, 'shell-1'); // SHELL evidence preserved, not clobbered
    assert.equal(observer.stats.sessionsEnrichedFromProcess, 1);
  } finally {
    cleanup();
  }
});

// Same real-E2E-derived shape as V0.6A's Claude test — a hook's OS parent may be a shell wrapper,
// not codex.exe itself (see SPEC_V0.6B.md "Process ancestry"). Reuses the SAME ProcessTree walk.
test('codex-observer: unifies with a PROCESS session via ancestry when native_process_pid is a shell wrapper, not codex.exe itself', async () => {
  const { store, cleanup } = await setup();
  try {
    const tree = new ProcessTree();
    const codexRt = tree.addStart({ pid: 51000, parentPid: null, processName: 'codex.exe', timestamp: 't-3' });
    tree.get(codexRt).agentType = 'CODEX';
    const shellRt = tree.addStart({ pid: 51001, parentPid: 51000, processName: 'cmd.exe', timestamp: 't-2' });
    tree.get(shellRt).agentType = null;
    tree.addStart({ pid: 51002, parentPid: 51001, processName: 'node.exe', timestamp: 't-1' }); // hook.mjs itself

    await store.upsertAgentSession({
      session_id: 'proc-session-real',
      agent_identity: 'CODEX',
      pid: 51000,
      parent_pid: 6000,
      started_at: '2026-08-20T22:00:00.000Z',
      status: 'ACTIVE',
      possible_project_id: null,
      project_confidence: CONFIDENCE.UNKNOWN,
      project_evidence: [],
      evidence_sources: ['PROCESS'],
      shell_session_id: null,
      native_session_id: null,
      native_metadata: null,
    });

    const factory = createFakeIpcFactory();
    const observer = new CodexAgentObserver({ store, ipcServerFactory: factory, processTree: tree });
    await observer.start(PROJECTS);
    await factory.emit({ hook_event_name: 'SessionStart', session_id: 'native-real', cwd: 'D:\\PROJECT-GUARDIAN', source: 'startup', native_process_pid: 51002, timestamp: 't0' });

    const sessions = await store.listAgentSessions({});
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].session_id, 'proc-session-real');
    assert.equal(sessions[0].pid, 51000); // untouched — stays the real codex.exe pid
    assert.deepEqual(sessions[0].evidence_sources.sort(), ['CODEX_NATIVE', 'PROCESS'].sort());
    assert.equal(observer.stats.sessionsEnrichedFromProcess, 1);
  } finally {
    cleanup();
  }
});

test('codex-observer: missing process evidence -> a native-only session is accepted, never forced', async () => {
  const { store, cleanup } = await setup();
  try {
    const factory = createFakeIpcFactory();
    const observer = new CodexAgentObserver({ store, ipcServerFactory: factory, processTree: new ProcessTree() });
    await observer.start(PROJECTS);
    await factory.emit({ hook_event_name: 'SessionStart', session_id: 'native-lonely', cwd: 'D:\\PROJECT-GUARDIAN', source: 'startup', native_process_pid: 77777, timestamp: 't0' });

    const [session] = await store.listAgentSessions({});
    assert.deepEqual(session.evidence_sources, ['CODEX_NATIVE']);
    assert.equal(session.pid, 77777);
  } finally {
    cleanup();
  }
});

test('codex-observer: SessionEnd marks the session ENDED with a computed duration and merges native_metadata (model + start_source + end_reason all retained)', async () => {
  const { store, cleanup } = await setup();
  try {
    const factory = createFakeIpcFactory();
    const observer = new CodexAgentObserver({ store, ipcServerFactory: factory });
    await observer.start(PROJECTS);
    await factory.emit({ hook_event_name: 'SessionStart', session_id: 'native-5', cwd: 'D:\\PROJECT-GUARDIAN', model: 'gpt-5-codex', source: 'startup', native_process_pid: 222, timestamp: '2026-08-20T10:00:00.000Z' });
    await factory.emit({ hook_event_name: 'SessionEnd', session_id: 'native-5', reason: 'other', native_process_pid: 222, timestamp: '2026-08-20T10:05:00.000Z' });

    const [session] = await store.listAgentSessions({});
    assert.equal(session.status, 'ENDED');
    assert.equal(session.duration_ms, 5 * 60 * 1000);
    assert.equal(session.native_metadata.end_reason, 'other');
    assert.equal(session.native_metadata.start_source, 'startup'); // not wiped by SessionEnd's own metadata
    assert.equal(session.native_metadata.model, 'gpt-5-codex');
    assert.equal(observer.stats.sessionsEnded, 1);
  } finally {
    cleanup();
  }
});

test('codex-observer: SessionEnd never fabricated — a session with no native SessionEnd stays ACTIVE', async () => {
  const { store, cleanup } = await setup();
  try {
    const factory = createFakeIpcFactory();
    const observer = new CodexAgentObserver({ store, ipcServerFactory: factory });
    await observer.start(PROJECTS);
    await factory.emit({ hook_event_name: 'SessionStart', session_id: 'native-6', cwd: 'D:\\PROJECT-GUARDIAN', source: 'startup', native_process_pid: 333, timestamp: 't0' });
    const [session] = await store.listAgentSessions({});
    assert.equal(session.status, 'ACTIVE');
  } finally {
    cleanup();
  }
});

test('codex-observer: Stop logs a turn-activity marker but never mutates session status/project', async () => {
  const { store, cleanup } = await setup();
  try {
    const factory = createFakeIpcFactory();
    const observer = new CodexAgentObserver({ store, ipcServerFactory: factory });
    await observer.start(PROJECTS);
    await factory.emit({ hook_event_name: 'SessionStart', session_id: 'native-7', cwd: 'D:\\PROJECT-GUARDIAN', source: 'startup', native_process_pid: 444, timestamp: 't0' });
    await factory.emit({ hook_event_name: 'Stop', session_id: 'native-7', native_process_pid: 444, timestamp: 't1' });

    const [session] = await store.listAgentSessions({});
    assert.equal(session.status, 'ACTIVE');
    assert.equal(observer.stats.turnsCompleted, 1);

    const nativeEvents = await store.listNativeAgentEvents({});
    assert.equal(nativeEvents.length, 2); // SessionStart + Stop
    assert.ok(nativeEvents.some((e) => e.type === 'AGENT_TURN_COMPLETED'));
    for (const e of nativeEvents) {
      assert.equal('transcript_path' in e, false);
      assert.equal('tool_input' in e, false);
    }
  } finally {
    cleanup();
  }
});

test('codex-observer: multiple simultaneous Codex sessions on distinct pids stay isolated', async () => {
  const { store, cleanup } = await setup();
  try {
    const factory = createFakeIpcFactory();
    const observer = new CodexAgentObserver({ store, ipcServerFactory: factory });
    await observer.start(PROJECTS);
    await factory.emit({ hook_event_name: 'SessionStart', session_id: 'native-a', cwd: 'D:\\PROJECT-GUARDIAN', source: 'startup', native_process_pid: 10, timestamp: 't0' });
    await factory.emit({ hook_event_name: 'SessionStart', session_id: 'native-b', cwd: 'D:\\PROJECT-GUARDIAN', source: 'startup', native_process_pid: 20, timestamp: 't0' });

    const sessions = await store.listAgentSessions({});
    assert.equal(sessions.length, 2);
    assert.notEqual(sessions[0].session_id, sessions[1].session_id);
  } finally {
    cleanup();
  }
});

test('codex-observer: same session lifecycle merge — SessionStart then SessionEnd resolve to the SAME session_id, not two', async () => {
  const { store, cleanup } = await setup();
  try {
    const factory = createFakeIpcFactory();
    const observer = new CodexAgentObserver({ store, ipcServerFactory: factory });
    await observer.start(PROJECTS);
    await factory.emit({ hook_event_name: 'SessionStart', session_id: 'native-life', cwd: 'D:\\PROJECT-GUARDIAN', source: 'startup', native_process_pid: 88, timestamp: 't0' });
    await factory.emit({ hook_event_name: 'SessionEnd', session_id: 'native-life', reason: 'other', native_process_pid: 88, timestamp: 't1' });

    const sessions = await store.listAgentSessions({});
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].status, 'ENDED');
  } finally {
    cleanup();
  }
});

test('codex-observer: writes a fresh auth token to dataDir on start (never baked into hooks.json)', async () => {
  const { store, cleanup } = await setup();
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'guardian-codex-agent-token-'));
  try {
    const factory = createFakeIpcFactory();
    const observer = new CodexAgentObserver({ store, ipcServerFactory: factory, dataDir });
    await observer.start(PROJECTS);
    const token = readFileSync(path.join(dataDir, 'codex-auth.token'), 'utf8');
    assert.equal(token, observer.authToken);
    assert.ok(token.length > 0);
  } finally {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    cleanup();
  }
});

test('codex-observer: a schema-rejected event is counted and never crashes the observer', async () => {
  const { store, cleanup } = await setup();
  try {
    const factory = createFakeIpcFactory();
    const observer = new CodexAgentObserver({ store, ipcServerFactory: factory });
    await observer.start(PROJECTS);
    factory.emitRejected({ reason: 'forbidden field: transcript_path' });
    assert.equal(observer.stats.schemaRejections, 1);
    assert.equal(observer.health().status, 'RUNNING');
  } finally {
    cleanup();
  }
});
