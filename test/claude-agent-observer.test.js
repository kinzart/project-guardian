import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JsonFileStore } from '../src/store/JsonFileStore.js';
import { ClaudeAgentObserver } from '../src/agent/claude/observer.js';
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
  const dbDir = mkdtempSync(path.join(os.tmpdir(), 'guardian-claude-agent-observer-'));
  const store = new JsonFileStore(path.join(dbDir, 'guardian.db.json'));
  await store.init();
  return { store, cleanup: () => rmSync(dbDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

const PROJECTS = [{ id: 'pg', name: 'PROJECT-GUARDIAN', root_path: 'D:\\PROJECT-GUARDIAN' }];

test('claude-observer: SessionStart with a cwd resolving under a project root creates an AUTHORITATIVE session', async () => {
  const { store, cleanup } = await setup();
  try {
    const factory = createFakeIpcFactory();
    const observer = new ClaudeAgentObserver({ store, ipcServerFactory: factory });
    await observer.start(PROJECTS);
    await factory.emit({ hook_event_name: 'SessionStart', session_id: 'native-1', cwd: 'D:\\PROJECT-GUARDIAN', source: 'startup', native_process_pid: 999, timestamp: 't0' });

    const sessions = await store.listAgentSessions({});
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].agent_identity, 'CLAUDE_CODE');
    assert.equal(sessions[0].possible_project_id, 'pg');
    assert.equal(sessions[0].project_confidence, CONFIDENCE.AUTHORITATIVE);
    assert.deepEqual(sessions[0].evidence_sources, ['CLAUDE_NATIVE']);
    assert.equal(sessions[0].native_session_id, 'native-1');
    assert.equal(sessions[0].pid, 999);
    assert.equal(observer.stats.sessionsStarted, 1);
  } finally {
    cleanup();
  }
});

test('claude-observer: a cwd that does not resolve under any known project stays UNKNOWN — never fabricated', async () => {
  const { store, cleanup } = await setup();
  try {
    const factory = createFakeIpcFactory();
    const observer = new ClaudeAgentObserver({ store, ipcServerFactory: factory });
    await observer.start(PROJECTS);
    await factory.emit({ hook_event_name: 'SessionStart', session_id: 'native-2', cwd: 'D:\\somewhere-else', source: 'startup', native_process_pid: 1000, timestamp: 't0' });

    const [session] = await store.listAgentSessions({});
    assert.equal(session.possible_project_id, null);
    assert.equal(session.project_confidence, CONFIDENCE.UNKNOWN);
  } finally {
    cleanup();
  }
});

test('claude-observer: enriches an existing PROCESS-sourced agentSession by pid instead of creating a duplicate', async () => {
  const { store, cleanup } = await setup();
  try {
    await store.upsertAgentSession({
      session_id: 'proc-session-1',
      agent_identity: 'CLAUDE_CODE',
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
    const observer = new ClaudeAgentObserver({ store, ipcServerFactory: factory });
    await observer.start(PROJECTS);
    await factory.emit({ hook_event_name: 'SessionStart', session_id: 'native-3', cwd: 'D:\\PROJECT-GUARDIAN', source: 'startup', native_process_pid: 5555, timestamp: 't0' });

    const sessions = await store.listAgentSessions({});
    assert.equal(sessions.length, 1); // enriched in place, never duplicated
    assert.equal(sessions[0].session_id, 'proc-session-1');
    assert.equal(sessions[0].native_session_id, 'native-3');
    assert.deepEqual(sessions[0].evidence_sources.sort(), ['CLAUDE_NATIVE', 'PROCESS'].sort());
    assert.equal(sessions[0].project_confidence, CONFIDENCE.AUTHORITATIVE);
    assert.equal(sessions[0].shell_session_id, 'shell-1'); // SHELL evidence preserved, not clobbered
    assert.equal(observer.stats.sessionsEnrichedFromProcess, 1);
  } finally {
    cleanup();
  }
});

test('claude-observer: CwdChanged updates project correlation for an already-known native session', async () => {
  const { store, cleanup } = await setup();
  try {
    const factory = createFakeIpcFactory();
    const observer = new ClaudeAgentObserver({ store, ipcServerFactory: factory });
    await observer.start(PROJECTS);
    await factory.emit({ hook_event_name: 'SessionStart', session_id: 'native-4', cwd: 'D:\\elsewhere', source: 'startup', native_process_pid: 111, timestamp: 't0' });
    await factory.emit({ hook_event_name: 'CwdChanged', session_id: 'native-4', old_cwd: 'D:\\elsewhere', new_cwd: 'D:\\PROJECT-GUARDIAN', native_process_pid: 111, timestamp: 't1' });

    const [session] = await store.listAgentSessions({});
    assert.equal(session.possible_project_id, 'pg');
    assert.equal(session.project_confidence, CONFIDENCE.AUTHORITATIVE);
    assert.equal(observer.stats.cwdChanges, 1);
  } finally {
    cleanup();
  }
});

test('claude-observer: SessionEnd marks the session ENDED with a computed duration, never fabricated for an unknown start', async () => {
  const { store, cleanup } = await setup();
  try {
    const factory = createFakeIpcFactory();
    const observer = new ClaudeAgentObserver({ store, ipcServerFactory: factory });
    await observer.start(PROJECTS);
    await factory.emit({ hook_event_name: 'SessionStart', session_id: 'native-5', cwd: 'D:\\PROJECT-GUARDIAN', source: 'startup', native_process_pid: 222, timestamp: '2026-08-20T10:00:00.000Z' });
    await factory.emit({ hook_event_name: 'SessionEnd', session_id: 'native-5', reason: 'clear', native_process_pid: 222, timestamp: '2026-08-20T10:05:00.000Z' });

    const [session] = await store.listAgentSessions({});
    assert.equal(session.status, 'ENDED');
    assert.equal(session.duration_ms, 5 * 60 * 1000);
    assert.equal(session.native_metadata.end_reason, 'clear');
    // regression: SessionEnd's own native_metadata carries no start_source (always null on that
    // event) — a naive wholesale overwrite would wipe out what SessionStart recorded earlier.
    assert.equal(session.native_metadata.start_source, 'startup');
    assert.equal(observer.stats.sessionsEnded, 1);
  } finally {
    cleanup();
  }
});

test('claude-observer: SessionEnd never fabricated — only ever produced by an actual native SessionEnd event', async () => {
  const { store, cleanup } = await setup();
  try {
    const factory = createFakeIpcFactory();
    const observer = new ClaudeAgentObserver({ store, ipcServerFactory: factory });
    await observer.start(PROJECTS);
    await factory.emit({ hook_event_name: 'SessionStart', session_id: 'native-6', cwd: 'D:\\PROJECT-GUARDIAN', source: 'startup', native_process_pid: 333, timestamp: 't0' });
    const [session] = await store.listAgentSessions({});
    assert.equal(session.status, 'ACTIVE');
  } finally {
    cleanup();
  }
});

test('claude-observer: Stop/StopFailure log a turn-activity marker but never mutate session status/project', async () => {
  const { store, cleanup } = await setup();
  try {
    const factory = createFakeIpcFactory();
    const observer = new ClaudeAgentObserver({ store, ipcServerFactory: factory });
    await observer.start(PROJECTS);
    await factory.emit({ hook_event_name: 'SessionStart', session_id: 'native-7', cwd: 'D:\\PROJECT-GUARDIAN', source: 'startup', native_process_pid: 444, timestamp: 't0' });
    await factory.emit({ hook_event_name: 'Stop', session_id: 'native-7', native_process_pid: 444, timestamp: 't1' });
    await factory.emit({ hook_event_name: 'StopFailure', session_id: 'native-7', native_process_pid: 444, timestamp: 't2' });

    const [session] = await store.listAgentSessions({});
    assert.equal(session.status, 'ACTIVE');
    assert.equal(observer.stats.turnsCompleted, 1);
    assert.equal(observer.stats.turnsFailed, 1);

    const nativeEvents = await store.listNativeAgentEvents({});
    assert.equal(nativeEvents.length, 3); // SessionStart + Stop + StopFailure
    assert.ok(nativeEvents.some((e) => e.type === 'AGENT_TURN_COMPLETED'));
    assert.ok(nativeEvents.some((e) => e.type === 'AGENT_TURN_FAILED'));
    // metadata-only — no conversation-content field ever reaches the store
    for (const e of nativeEvents) {
      assert.equal('last_assistant_message' in e, false);
      assert.equal('tool_input' in e, false);
    }
  } finally {
    cleanup();
  }
});

test('claude-observer: two distinct native sessions on two distinct pids stay isolated', async () => {
  const { store, cleanup } = await setup();
  try {
    const factory = createFakeIpcFactory();
    const observer = new ClaudeAgentObserver({ store, ipcServerFactory: factory });
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

// Real-E2E finding (see observer.js's constructor doc): on this machine, Claude Code runs
// `type: "command"` hooks through an intermediate Git-Bash shell, so hook.mjs's own
// `process.ppid` is a bash.exe pid two hops away from the real claude.exe pid — never a bare
// match against agentSessions.pid. These tests reproduce that exact shape via a real ProcessTree.
test('claude-observer: unifies with a PROCESS session via ancestry when native_process_pid is a shell wrapper, not claude.exe itself', async () => {
  const { store, cleanup } = await setup();
  try {
    const tree = new ProcessTree();
    const claudeRt = tree.addStart({ pid: 43832, parentPid: null, processName: 'claude.exe', timestamp: 't-4' });
    tree.get(claudeRt).agentType = 'CLAUDE_CODE';
    const bash1Rt = tree.addStart({ pid: 4780, parentPid: 43832, processName: 'bash.exe', timestamp: 't-3' });
    tree.get(bash1Rt).agentType = null;
    const bash2Rt = tree.addStart({ pid: 23528, parentPid: 4780, processName: 'bash.exe', timestamp: 't-2' });
    tree.get(bash2Rt).agentType = null;
    tree.addStart({ pid: 43780, parentPid: 23528, processName: 'node.exe', timestamp: 't-1' }); // hook.mjs itself

    await store.upsertAgentSession({
      session_id: 'proc-session-real',
      agent_identity: 'CLAUDE_CODE',
      pid: 43832, // the REAL claude.exe pid, as V0.4 (WMI) observed it
      parent_pid: 5628,
      started_at: '2026-08-20T22:43:24.000Z',
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
    const observer = new ClaudeAgentObserver({ store, ipcServerFactory: factory, processTree: tree });
    await observer.start(PROJECTS);
    // native_process_pid = 23528 — hook.mjs's immediate OS parent (a bash.exe), NOT claude.exe.
    await factory.emit({ hook_event_name: 'SessionStart', session_id: 'native-real', cwd: 'D:\\PROJECT-GUARDIAN', source: 'startup', native_process_pid: 23528, timestamp: 't0' });

    const sessions = await store.listAgentSessions({});
    assert.equal(sessions.length, 1); // enriched via ancestry, never duplicated
    assert.equal(sessions[0].session_id, 'proc-session-real');
    assert.equal(sessions[0].pid, 43832); // untouched — stays the real claude.exe pid
    assert.deepEqual(sessions[0].evidence_sources.sort(), ['CLAUDE_NATIVE', 'PROCESS'].sort());
    assert.equal(observer.stats.sessionsEnrichedFromProcess, 1);
  } finally {
    cleanup();
  }
});

test('claude-observer: with a process tree but no known CLAUDE_CODE ancestor, falls back to native_process_pid (never guesses)', async () => {
  const { store, cleanup } = await setup();
  try {
    const tree = new ProcessTree();
    const bashRt = tree.addStart({ pid: 999, parentPid: null, processName: 'bash.exe', timestamp: 't-1' });
    tree.get(bashRt).agentType = null; // V0.4 never classified anything above this as CLAUDE_CODE

    const factory = createFakeIpcFactory();
    const observer = new ClaudeAgentObserver({ store, ipcServerFactory: factory, processTree: tree });
    await observer.start(PROJECTS);
    await factory.emit({ hook_event_name: 'SessionStart', session_id: 'native-unresolved', cwd: 'D:\\PROJECT-GUARDIAN', source: 'startup', native_process_pid: 999, timestamp: 't0' });

    const [session] = await store.listAgentSessions({});
    assert.equal(session.pid, 999); // fallback: native_process_pid itself, same as no-processTree behavior
    assert.deepEqual(session.evidence_sources, ['CLAUDE_NATIVE']);
  } finally {
    cleanup();
  }
});

test('claude-observer: writes a fresh auth token to dataDir on start (never baked into settings.json)', async () => {
  const { store, cleanup } = await setup();
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'guardian-claude-agent-token-'));
  try {
    const factory = createFakeIpcFactory();
    const observer = new ClaudeAgentObserver({ store, ipcServerFactory: factory, dataDir });
    await observer.start(PROJECTS);
    const token = readFileSync(path.join(dataDir, 'claude-auth.token'), 'utf8');
    assert.equal(token, observer.authToken);
    assert.ok(token.length > 0);
  } finally {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    cleanup();
  }
});

test('claude-observer: a schema-rejected event is counted and never crashes the observer', async () => {
  const { store, cleanup } = await setup();
  try {
    const factory = createFakeIpcFactory();
    const observer = new ClaudeAgentObserver({ store, ipcServerFactory: factory });
    await observer.start(PROJECTS);
    factory.emitRejected({ reason: 'forbidden field: last_assistant_message' });
    assert.equal(observer.stats.schemaRejections, 1);
    assert.equal(observer.health().status, 'RUNNING');
  } finally {
    cleanup();
  }
});
