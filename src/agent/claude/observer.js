// Claude Code native-hook observer — see SPEC_V0.6A.md "Session deduplication"/"Combined
// correlation". The core job here is NOT creating a new session type: every event either enriches
// an existing V0.4 process-observed `agentSessions` record (matched by pid — see
// src/process/session-engine.js's `evidence_sources`/`shell_session_id` fields, added in V0.6A)
// or, if no process session exists yet, creates one directly in that SAME collection sourced by
// CLAUDE_NATIVE alone — so a later process-observer sighting of the same pid can still find and
// enrich it in turn. There is deliberately no separate "native session" store.

import { createClaudeIpcServer, generateAuthToken, DEFAULT_CLAUDE_TCP_PORT } from './ipc-server.js';
import { normalizeClaudeAgentEvent } from './normalizer.js';
import { resolveProjectForPath } from '../../process/project-correlator.js';
import { writeAuthToken } from './manager.js';
import { CONFIDENCE } from '../../intelligence/field.js';

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class ClaudeAgentObserver {
  // dataDir: where the fresh auth token is written each start — hook.mjs reads it fresh before
  // every connection attempt, same pattern as src/shell/wsl/observer.js.
  //
  // processTree: V0.4's own src/process/process-tree.js ProcessTree instance (Observer's `.tree`)
  // — optional, but required for correct pid unification. Found via real E2E (a real Claude Code
  // session, this repo's own hooks, this machine's real Git-Bash install): `native_process_pid`
  // (hook.mjs's own `process.ppid`) is NOT claude.exe's pid — Claude Code runs `type: "command"`
  // hooks through a shell wrapper (bash.exe on this Windows+Git-Bash setup, observed TWO hops
  // above hook.mjs's own node.exe process: node.exe -> bash.exe -> bash.exe -> claude.exe). A
  // bare `session.pid === native_process_pid` check therefore never matches, and unification never
  // fires. Instead of hardcoding a hop count (fragile — Claude Code's own hook-execution mechanism
  // is an implementation detail this project doesn't control, and may differ by shell/version),
  // #resolveProcessLink walks the SAME live ancestry tree V0.4 already builds from real WMI
  // process-start events, however many hops deep it actually is.
  constructor({ store, port = DEFAULT_CLAUDE_TCP_PORT, dataDir = null, ipcServerFactory = createClaudeIpcServer, processTree = null }) {
    this.store = store;
    this.port = port;
    this.dataDir = dataDir;
    this.ipcServerFactory = ipcServerFactory;
    this.processTree = processTree;
    this.projects = [];
    this.byNativeSessionId = new Map(); // native_session_id -> guardian agent session_id (in-run cache only)

    this.stats = {
      eventsReceived: 0,
      sessionsStarted: 0,
      sessionsResumed: 0,
      sessionsEnrichedFromProcess: 0,
      cwdChanges: 0,
      sessionsEnded: 0,
      turnsCompleted: 0,
      turnsFailed: 0,
      schemaRejections: 0,
      errors: 0,
    };

    this.listeners = [];
    this.running = false;
    this.degraded = false;
    this.lastEvent = null;
    this.server = null;
    this.authToken = null;
  }

  onEvent(callback) {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== callback);
    };
  }

  emit(evt) {
    this.lastEvent = { ...evt, at: new Date().toISOString() };
    for (const listener of this.listeners) {
      try {
        listener(this.lastEvent);
      } catch {
        // a listener throwing must never break the observer
      }
    }
  }

  updateProjects(projects) {
    this.projects = projects;
  }

  // Resolves the best-known REAL Claude Code process pid for a hook's reported
  // native_process_pid, plus every pid along the way — used to match against V0.4's
  // agentSessions.pid (which is always the real claude.exe pid, discovered independently via
  // WMI). Falls back to native_process_pid itself, unchanged, when no process tree is wired in
  // (e.g. a unit test) or the hook's immediate parent has no known AI_AGENT ancestor (V0.4 hasn't
  // observed this process tree yet — a real possibility given the two subsystems are otherwise
  // independent; never blocks on it, never guesses).
  #resolveProcessLink(nativeProcessPid) {
    const candidatePids = [nativeProcessPid];
    let resolvedPid = nativeProcessPid;
    if (this.processTree) {
      const record = this.processTree.getByPid(nativeProcessPid);
      const chain = record ? [record, ...this.processTree.ancestors(record.runtimeId)] : [];
      for (const node of chain) {
        candidatePids.push(node.pid);
        if (node.agentType === 'CLAUDE_CODE') {
          resolvedPid = node.pid;
          break;
        }
      }
    }
    return { resolvedPid, candidatePids };
  }

  async start(projects = []) {
    this.projects = projects;
    this.authToken = generateAuthToken();
    if (this.dataDir) {
      try {
        writeAuthToken(this.dataDir, this.authToken);
      } catch (err) {
        this.emit({ type: 'error', error: { message: `could not write claude-auth.token: ${err.message}` } });
      }
    }

    this.server = this.ipcServerFactory({
      port: this.port,
      authToken: this.authToken,
      onEvent: (validated) => this.#handleEvent(validated),
      onRejected: (info) => {
        this.stats.schemaRejections += 1;
        this.emit({ type: 'rejected', reason: info.reason });
      },
      onError: (err) => {
        this.stats.errors += 1;
        this.degraded = true;
        this.emit({ type: 'error', error: { message: err?.message || String(err) } });
      },
    });

    try {
      await this.server.start();
      this.running = true;
      this.degraded = false;
    } catch (err) {
      this.running = false;
      this.degraded = true;
      this.emit({ type: 'error', error: { message: err?.message || String(err) } });
      return false;
    }
    return true;
  }

  // Finds the ONE agent_session this native event belongs to, in priority order:
  //  1. Already known this run (native_session_id seen before).
  //  2. Already persisted with this native_session_id (observer restarted mid-session).
  //  3. An ACTIVE process-observed session with the same pid that has no native_session_id yet —
  //     enrich it in place (this is the "don't create two independent sessions" case).
  //  4. Nothing found — create a fresh CLAUDE_NATIVE-only session.
  async #findOrCreateSession(normalized) {
    const cached = this.byNativeSessionId.get(normalized.native_session_id);
    if (cached) {
      const session = await this.store.getAgentSession(cached);
      if (session) return { session, isNew: false, enrichedFromProcess: false };
    }

    const all = await this.store.listAgentSessions({});
    const byNativeId = all.find((s) => s.native_session_id === normalized.native_session_id);
    if (byNativeId) {
      this.byNativeSessionId.set(normalized.native_session_id, byNativeId.session_id);
      return { session: byNativeId, isNew: false, enrichedFromProcess: false };
    }

    const { resolvedPid, candidatePids } = this.#resolveProcessLink(normalized.native_process_pid);
    const byPid = all.find((s) => s.status === 'ACTIVE' && !s.native_session_id && candidatePids.includes(s.pid));
    if (byPid) {
      this.byNativeSessionId.set(normalized.native_session_id, byPid.session_id);
      return { session: byPid, isNew: false, enrichedFromProcess: true };
    }

    const session = {
      session_id: newId(),
      agent_identity: 'CLAUDE_CODE',
      pid: resolvedPid,
      parent_pid: null, // unknown — Guardian never saw this process start (V0.4's job when/if it does)
      started_at: null,
      detected_at: new Date().toISOString(),
      start_source: 'CLAUDE_NATIVE_HOOK',
      ended_at: null,
      duration_ms: null,
      status: 'ACTIVE',
      possible_project_id: null,
      project_confidence: CONFIDENCE.UNKNOWN,
      project_evidence: [],
      process_tree_summary: null,
      runtime_id: null,
      closure_note: null,
      evidence_sources: ['CLAUDE_NATIVE'],
      shell_session_id: null,
      native_session_id: normalized.native_session_id,
      native_metadata: null,
    };
    this.byNativeSessionId.set(normalized.native_session_id, session.session_id);
    return { session, isNew: true, enrichedFromProcess: false };
  }

  // Native cwd evidence is authoritative for Claude's OWN working directory (see SPEC_V0.6A.md
  // "Cwd changed" — "shell cwd changing does not necessarily mean Claude's cwd changed... Native
  // Claude CwdChanged wins"). Only ever UPGRADES: a cwd that doesn't resolve under any known
  // project root is not proof of anything (never fabricate), so existing PROCESS/SHELL evidence,
  // if any, is left alone rather than being downgraded to UNKNOWN.
  #applyNativeCwdEvidence(session, cwd, evidenceLabel) {
    if (!cwd) return;
    const project = resolveProjectForPath(cwd, this.projects);
    if (!project) return;
    session.possible_project_id = project.id;
    session.project_confidence = CONFIDENCE.AUTHORITATIVE;
    session.project_evidence = [...(session.project_evidence || []), `${evidenceLabel} cwd resolves under project root: ${project.name}`];
  }

  // Each normalized event's native_metadata only ever carries ONE meaningful field (start_source
  // for SessionStart, end_reason for SessionEnd — the other is always null on that event), so a
  // bare assignment overwrites the whole object on every event and loses earlier fields (found
  // via real E2E: a session that received both SessionStart and SessionEnd ended up with
  // start_source wiped back to null). Only ever merges non-null fields in.
  #mergeNativeMetadata(session, metadata) {
    const current = session.native_metadata || { start_source: null, end_reason: null, hook_version: null };
    const updates = Object.fromEntries(Object.entries(metadata || {}).filter(([, v]) => v !== null && v !== undefined));
    session.native_metadata = { ...current, ...updates };
  }

  #logNativeEvent(normalized, session) {
    this.store
      .addNativeAgentEvent({
        event_id: normalized.event_id,
        type: normalized.native_event,
        agent: normalized.agent,
        native_session_id: normalized.native_session_id,
        session_id: session?.session_id ?? null,
        cwd: normalized.cwd,
        resolved_project_id: session?.possible_project_id ?? null,
        project_confidence: session?.project_confidence ?? CONFIDENCE.UNKNOWN,
        timestamp: normalized.timestamp,
        received_at: normalized.received_at,
        source: normalized.source,
        native_metadata: normalized.native_metadata,
      })
      .catch(() => {
        this.stats.errors += 1;
      });
  }

  async #handleEvent(validated) {
    this.stats.eventsReceived += 1;
    const normalized = normalizeClaudeAgentEvent(validated);

    try {
      if (normalized.native_event === 'AGENT_SESSION_STARTED' || normalized.native_event === 'AGENT_SESSION_RESUMED') {
        const { session, enrichedFromProcess } = await this.#findOrCreateSession(normalized);
        if (!session.started_at && normalized.native_event === 'AGENT_SESSION_STARTED') session.started_at = normalized.timestamp;
        session.status = 'ACTIVE';
        session.native_session_id = normalized.native_session_id;
        this.#mergeNativeMetadata(session, normalized.native_metadata);
        if (!session.evidence_sources.includes('CLAUDE_NATIVE')) session.evidence_sources = [...session.evidence_sources, 'CLAUDE_NATIVE'];
        this.#applyNativeCwdEvidence(session, normalized.cwd, 'Claude native SessionStart');
        await this.store.upsertAgentSession(session);
        this.stats[normalized.native_event === 'AGENT_SESSION_RESUMED' ? 'sessionsResumed' : 'sessionsStarted'] += 1;
        if (enrichedFromProcess) this.stats.sessionsEnrichedFromProcess += 1;
        this.#logNativeEvent(normalized, session);
        this.emit({ type: normalized.native_event === 'AGENT_SESSION_RESUMED' ? 'session-resumed' : 'session-started', session, enrichedFromProcess });
      } else if (normalized.native_event === 'AGENT_CWD_CHANGED') {
        const { session } = await this.#findOrCreateSession(normalized);
        this.#applyNativeCwdEvidence(session, normalized.cwd, 'Claude native CwdChanged');
        await this.store.upsertAgentSession(session);
        this.stats.cwdChanges += 1;
        this.#logNativeEvent(normalized, session);
        this.emit({ type: 'cwd-changed', session });
      } else if (normalized.native_event === 'AGENT_SESSION_ENDED') {
        const { session } = await this.#findOrCreateSession(normalized);
        session.status = 'ENDED';
        session.ended_at = normalized.timestamp;
        session.duration_ms = session.started_at ? new Date(normalized.timestamp).getTime() - new Date(session.started_at).getTime() : null;
        this.#mergeNativeMetadata(session, normalized.native_metadata);
        await this.store.upsertAgentSession(session);
        this.stats.sessionsEnded += 1;
        this.byNativeSessionId.delete(normalized.native_session_id);
        this.#logNativeEvent(normalized, session);
        this.emit({ type: 'session-ended', session });
      } else if (normalized.native_event === 'AGENT_TURN_COMPLETED' || normalized.native_event === 'AGENT_TURN_FAILED') {
        // TURN_ACTIVITY marker only — never mutates the session itself (see SPEC_V0.6A.md "Hook
        // events allowed in this phase").
        const { session } = await this.#findOrCreateSession(normalized);
        this.stats[normalized.native_event === 'AGENT_TURN_FAILED' ? 'turnsFailed' : 'turnsCompleted'] += 1;
        this.#logNativeEvent(normalized, session);
        this.emit({ type: normalized.native_event === 'AGENT_TURN_FAILED' ? 'turn-failed' : 'turn-completed', session });
      }
    } catch (err) {
      this.stats.errors += 1;
      this.emit({ type: 'error', error: { message: err?.message || String(err) } });
    }
  }

  async stop(status = 'STOPPED') {
    if (this.server) await this.server.stop();
    this.running = false;
    void status;
  }

  health() {
    return {
      status: this.running ? (this.degraded ? 'DEGRADED' : 'RUNNING') : this.degraded ? 'DEGRADED' : 'STOPPED',
      port: this.port,
      stats: { ...this.stats },
      lastEvent: this.lastEvent,
    };
  }
}
