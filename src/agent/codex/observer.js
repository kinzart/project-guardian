// Codex native-hook observer — see SPEC_V0.6B.md "Session unification"/"Process ancestry". Same
// unification model as src/agent/claude/observer.js: every event either enriches an existing V0.4
// process-observed `agentSessions` record (matched by pid, via the SAME process-ancestry walk
// V0.6A introduced for Claude — see #resolveProcessLink) or, if none exists yet, creates one
// directly in that SAME collection sourced by CODEX_NATIVE alone. No separate session store.

import { createCodexIpcServer, generateAuthToken, DEFAULT_CODEX_TCP_PORT } from './ipc-server.js';
import { normalizeCodexAgentEvent } from './normalizer.js';
import { resolveProjectForPath } from '../../process/project-correlator.js';
import { writeAuthToken } from './manager.js';
import { CONFIDENCE } from '../../intelligence/field.js';

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class CodexAgentObserver {
  // processTree: V0.4's ProcessTree instance (Observer's `.tree`) — see
  // src/agent/claude/observer.js's constructor doc for the full rationale (reused verbatim here,
  // matched against agentType === 'CODEX' instead of 'CLAUDE_CODE'). Codex hook commands may run
  // through cmd/PowerShell/bash/node wrappers just like Claude's did — never assume the hook's
  // immediate OS parent is codex.exe itself (see SPEC_V0.6B.md "Process ancestry").
  constructor({ store, port = DEFAULT_CODEX_TCP_PORT, dataDir = null, ipcServerFactory = createCodexIpcServer, processTree = null }) {
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
      sessionsEnded: 0,
      turnsCompleted: 0,
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

  async start(projects = []) {
    this.projects = projects;
    this.authToken = generateAuthToken();
    if (this.dataDir) {
      try {
        writeAuthToken(this.dataDir, this.authToken);
      } catch (err) {
        this.emit({ type: 'error', error: { message: `could not write codex-auth.token: ${err.message}` } });
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

  // Same ancestry-walk fix V0.6A introduced for Claude — see that observer's constructor doc.
  #resolveProcessLink(nativeProcessPid) {
    const candidatePids = [nativeProcessPid];
    let resolvedPid = nativeProcessPid;
    if (this.processTree) {
      const record = this.processTree.getByPid(nativeProcessPid);
      const chain = record ? [record, ...this.processTree.ancestors(record.runtimeId)] : [];
      for (const node of chain) {
        candidatePids.push(node.pid);
        if (node.agentType === 'CODEX') {
          resolvedPid = node.pid;
          break;
        }
      }
    }
    return { resolvedPid, candidatePids };
  }

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
      agent_identity: 'CODEX',
      pid: resolvedPid,
      parent_pid: null, // unknown — Guardian never saw this process start (V0.4's job when/if it does)
      started_at: null,
      detected_at: new Date().toISOString(),
      start_source: 'CODEX_NATIVE_HOOK',
      ended_at: null,
      duration_ms: null,
      status: 'ACTIVE',
      possible_project_id: null,
      project_confidence: CONFIDENCE.UNKNOWN,
      project_evidence: [],
      process_tree_summary: null,
      runtime_id: null,
      closure_note: null,
      evidence_sources: ['CODEX_NATIVE'],
      shell_session_id: null,
      native_session_id: normalized.native_session_id,
      native_metadata: null,
    };
    this.byNativeSessionId.set(normalized.native_session_id, session.session_id);
    return { session, isNew: true, enrichedFromProcess: false };
  }

  // No native CWD-change event exists for Codex (see SPEC_V0.6B.md section 1) — this only ever
  // fires from SessionStart's own cwd, once, at session creation/enrichment time. Only ever
  // UPGRADES: a cwd that doesn't resolve under any known project root is not proof of anything.
  #applyNativeCwdEvidence(session, cwd, evidenceLabel) {
    if (!cwd) return;
    const project = resolveProjectForPath(cwd, this.projects);
    if (!project) return;
    session.possible_project_id = project.id;
    session.project_confidence = CONFIDENCE.AUTHORITATIVE;
    session.project_evidence = [...(session.project_evidence || []), `${evidenceLabel} cwd resolves under project root: ${project.name}`];
  }

  // Same non-null-only merge fix V0.6A introduced for Claude's native_metadata — see that
  // observer's #mergeNativeMetadata doc.
  #mergeNativeMetadata(session, metadata) {
    const current = session.native_metadata || { start_source: null, end_reason: null, model: null, hook_version: null };
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
    const normalized = normalizeCodexAgentEvent(validated);

    try {
      if (normalized.native_event === 'AGENT_SESSION_STARTED' || normalized.native_event === 'AGENT_SESSION_RESUMED') {
        const { session, enrichedFromProcess } = await this.#findOrCreateSession(normalized);
        if (!session.started_at && normalized.native_event === 'AGENT_SESSION_STARTED') session.started_at = normalized.timestamp;
        session.status = 'ACTIVE';
        session.native_session_id = normalized.native_session_id;
        this.#mergeNativeMetadata(session, normalized.native_metadata);
        if (!session.evidence_sources.includes('CODEX_NATIVE')) session.evidence_sources = [...session.evidence_sources, 'CODEX_NATIVE'];
        this.#applyNativeCwdEvidence(session, normalized.cwd, 'Codex native SessionStart');
        await this.store.upsertAgentSession(session);
        this.stats[normalized.native_event === 'AGENT_SESSION_RESUMED' ? 'sessionsResumed' : 'sessionsStarted'] += 1;
        if (enrichedFromProcess) this.stats.sessionsEnrichedFromProcess += 1;
        this.#logNativeEvent(normalized, session);
        this.emit({ type: normalized.native_event === 'AGENT_SESSION_RESUMED' ? 'session-resumed' : 'session-started', session, enrichedFromProcess });
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
      } else if (normalized.native_event === 'AGENT_TURN_COMPLETED') {
        // TURN_ACTIVITY marker only — never mutates the session itself.
        const { session } = await this.#findOrCreateSession(normalized);
        this.stats.turnsCompleted += 1;
        this.#logNativeEvent(normalized, session);
        this.emit({ type: 'turn-completed', session });
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
