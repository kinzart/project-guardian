// Agent session reconstruction — see SPEC_V0.4.md "Agent session engine". Pure in-memory engine;
// observer.js is responsible for persisting the objects this produces and for startup
// reconciliation against previously-stored sessions.

import { CONFIDENCE } from '../intelligence/field.js';

function newSessionId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class SessionEngine {
  constructor() {
    this.sessions = new Map(); // session_id -> session
    this.byRuntimeId = new Map(); // runtimeId -> session_id, active tracking only
  }

  // alreadyRunning: true for a process discovered via the observer's one-time startup snapshot,
  // never a live start event. startTimeKnown: whether `timestamp` is the process's real OS
  // creation time (known even for an already-running process) or just "when Guardian noticed
  // it" — only the latter forces started_at to stay null (see SPEC_V0.4.md section 8).
  startSession({ runtimeId, agentType, pid, parentPid, timestamp, startTimeKnown = true, correlation, treeSummary, alreadyRunning = false, shellSessionId = null }) {
    const sessionId = newSessionId();
    const session = {
      session_id: sessionId,
      agent_identity: agentType,
      pid,
      parent_pid: parentPid,
      started_at: startTimeKnown ? timestamp : null,
      detected_at: alreadyRunning ? new Date().toISOString() : null,
      start_source: alreadyRunning ? 'ALREADY_RUNNING_AT_OBSERVER_START' : 'OBSERVED_START',
      ended_at: null,
      duration_ms: null,
      status: 'ACTIVE',
      possible_project_id: correlation?.projectId ?? null,
      project_confidence: correlation?.confidence ?? CONFIDENCE.UNKNOWN,
      project_evidence: correlation?.evidence ?? [],
      process_tree_summary: treeSummary || null,
      runtime_id: runtimeId,
      closure_note: null,
      // V0.6A — unified agent_session concept (see SPEC_V0.6A.md "Session deduplication"). A
      // process-observed session starts life sourced by PROCESS (and SHELL, when a parent shell's
      // explicit CWD was known); a later Claude native hook enriches this SAME record in place
      // (src/agent/claude/observer.js) rather than creating a second session.
      evidence_sources: shellSessionId ? ['PROCESS', 'SHELL'] : ['PROCESS'],
      shell_session_id: shellSessionId,
      native_session_id: null,
      native_metadata: null,
    };
    this.sessions.set(sessionId, session);
    this.byRuntimeId.set(runtimeId, sessionId);
    return session;
  }

  endSession(runtimeId, timestamp) {
    const sessionId = this.byRuntimeId.get(runtimeId);
    if (!sessionId) return null;
    const session = this.sessions.get(sessionId);
    session.status = 'ENDED';
    session.ended_at = timestamp;
    session.duration_ms = session.started_at ? new Date(timestamp).getTime() - new Date(session.started_at).getTime() : null;
    this.byRuntimeId.delete(runtimeId);
    return session;
  }

  updateCorrelation(runtimeId, correlation) {
    const sessionId = this.byRuntimeId.get(runtimeId);
    if (!sessionId) return null;
    const session = this.sessions.get(sessionId);
    session.possible_project_id = correlation.projectId;
    session.project_confidence = correlation.confidence;
    session.project_evidence = correlation.evidence;
    return session;
  }

  get(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  getByRuntimeId(runtimeId) {
    const sessionId = this.byRuntimeId.get(runtimeId);
    return sessionId ? this.sessions.get(sessionId) : null;
  }

  isTrackedPid(pid) {
    for (const session of this.sessions.values()) {
      if (session.status === 'ACTIVE' && session.pid === pid) return true;
    }
    return false;
  }

  list({ active } = {}) {
    const all = Array.from(this.sessions.values());
    if (active === undefined) return all;
    return all.filter((s) => (active ? s.status === 'ACTIVE' : s.status !== 'ACTIVE'));
  }

  // Re-registers a previously-persisted session that startup reconciliation determined is still
  // genuinely active, so a later PROCESS_STOPPED for its pid can find and end it.
  hydrateActive(session, runtimeId) {
    this.sessions.set(session.session_id, session);
    this.byRuntimeId.set(runtimeId, session.session_id);
  }

  // Registers a previously-persisted session in its final (non-active) form — for display via
  // list()/get() without making it reachable by a future stop event.
  hydrateClosed(session) {
    this.sessions.set(session.session_id, session);
  }
}
