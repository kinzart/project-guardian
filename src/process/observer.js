// Process & agent session observer orchestrator — see SPEC_V0.4.md sections 4, 8, 11. Wires
// adapter -> normalizer -> classifier -> sanitizer -> process tree -> project correlator ->
// session engine -> store, mirroring the shape of src/watch/watcher.js (start/stop/onEvent/
// health) so `guardian observe` can run both subsystems side by side.

import { createWindowsProcessAdapter } from './windows-adapter.js';
import { normalizeProcessEvent } from './normalizer.js';
import { classifyProcess } from './classifier.js';
import { sanitizeCommandMetadata, sanitizeExecutablePath } from './sanitizer.js';
import { ProcessTree } from './process-tree.js';
import { SessionEngine } from './session-engine.js';
import { correlateProject } from './project-correlator.js';
import { CONFIDENCE } from '../intelligence/field.js';

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class Observer {
  // shellRegistry: optional src/shell/session-store.js ShellSessionRegistry — when a starting
  // process's parent pid is a known shell session, its explicit CWD becomes HIGH-confidence
  // project-correlation evidence (see SPEC_V0.5A.md section 8). Absent in V0.4-only usage.
  constructor({ store, config, adapter = createWindowsProcessAdapter(), shellRegistry = null, onShellProcessStopped = null }) {
    this.store = store;
    this.config = config;
    this.adapter = adapter;
    this.shellRegistry = shellRegistry;
    this.onShellProcessStopped = onShellProcessStopped;
    this.projects = [];

    this.tree = new ProcessTree();
    this.sessions = new SessionEngine();
    this.correlations = new Map(); // runtimeId -> { projectId, confidence, evidence }

    this.stats = {
      eventsReceived: 0,
      processStarts: 0,
      processStops: 0,
      processesClassified: 0,
      agentSessionsDetected: 0,
      sanitizationCount: 0,
      errors: 0,
    };

    this.listeners = [];
    this.sessionId = null;
    this.startedAt = null;
    this.running = false;
    this.degraded = false;
    this.lastEvent = null;

    this.adapterHandle = null;
    this.reconciled = false;
    this.startupBuffer = [];
    this.pendingLive = [];
    this.startupTimer = null;
    this.startupFallbackTimer = null;
    this.priorActiveSessions = [];
    this.priorObserverEndedCleanly = true;

    // Serializes #processEvent calls — see #enqueue(). Without this, a burst of real events
    // (parent process starting immediately followed by its child) can have their async
    // #handleStart calls interleave: the child's correlateProject() can run its "inherited from
    // correlated ancestor" lookup before the parent's own correlation has finished being
    // computed and stored, silently losing evidence that was genuinely available a few
    // milliseconds later. Found via real E2E (a real shell -> real Claude invocation raced this
    // way), not reachable by the fake-adapter unit tests, which never fire two starts this close
    // together.
    this.eventQueue = Promise.resolve();
  }

  #enqueue(raw) {
    this.eventQueue = this.eventQueue.then(() => this.#processEvent(raw)).catch((err) => this.#handleAdapterError(err));
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

  // Resolves once the startup ALREADY_RUNNING snapshot has settled and reconciliation has run —
  // useful for tests/CLI that want to wait past the ambiguous startup window before asserting.
  whenReconciled() {
    if (this.reconciled) return Promise.resolve();
    return new Promise((resolve) => {
      const unsubscribe = this.onEvent((evt) => {
        if (evt.type === 'reconciled') {
          unsubscribe();
          resolve();
        }
      });
    });
  }

  async start(projects = []) {
    this.projects = projects;
    this.startedAt = new Date();
    this.sessionId = newId();
    this.running = true;
    this.degraded = false;

    this.priorActiveSessions = await this.store.listAgentSessions({ active: true });
    const priorObserverSession = await this.store.getLatestObserverSession();
    this.priorObserverEndedCleanly = !priorObserverSession || priorObserverSession.status === 'STOPPED';
    if (priorObserverSession?.status === 'RUNNING' && !isPidAlive(priorObserverSession.pid)) {
      await this.store.updateObserverSession(priorObserverSession.session_id, {
        status: 'UNCLEAN_END',
        stopped_at: priorObserverSession.stopped_at || new Date().toISOString(),
      });
      this.priorObserverEndedCleanly = false;
    }

    try {
      this.adapterHandle = this.adapter.start({
        onEvent: (raw) => this.#handleRaw(raw),
        onError: (err) => this.#handleAdapterError(err),
      });
    } catch (err) {
      this.#handleAdapterError(err);
    }

    // Fallback: finalize reconciliation even if zero ALREADY_RUNNING events ever arrive (adapter
    // failure, or a test adapter with nothing to snapshot). Deliberately NOT unref'd — callers
    // (e.g. whenReconciled()) await this firing, so it must be able to keep the process alive on
    // its own rather than being silently skipped if nothing else is scheduled at that moment.
    this.startupFallbackTimer = setTimeout(() => this.#finalizeReconciliation(), this.config.process.startupSettleMs * 4);

    await this.store.startObserverSession({
      session_id: this.sessionId,
      started_at: this.startedAt.toISOString(),
      stopped_at: null,
      status: 'RUNNING',
      pid: process.pid,
    });

    return this.sessionId;
  }

  #handleRaw(raw) {
    // Only route into the startup-reconciliation buffer while reconciliation hasn't run yet. On
    // a real machine the snapshot can carry hundreds of processes and take longer to fully
    // stream than the fallback timer (e.g. under real load); once #finalizeReconciliation has
    // run once it never runs again (see its own guard), so a late ALREADY_RUNNING arriving after
    // that point must fall through to the normal live path instead of being buffered into a
    // startupBuffer nothing will ever drain again — silently losing the event otherwise.
    if (raw.type === 'ALREADY_RUNNING' && !this.reconciled) {
      this.startupBuffer.push(raw);
      if (this.startupTimer) clearTimeout(this.startupTimer);
      this.startupTimer = setTimeout(() => this.#finalizeReconciliation(), this.config.process.startupSettleMs); // not unref'd — see startupFallbackTimer above
      return;
    }
    if (!this.reconciled) {
      this.pendingLive.push(raw);
      return;
    }
    this.#enqueue(raw);
  }

  #sameProcessInstance(session, record) {
    if (session.pid !== record.pid) return false;
    if (session.started_at && record.startTimeKnown && record.timestamp) {
      const diffMs = Math.abs(new Date(record.timestamp).getTime() - new Date(session.started_at).getTime());
      return diffMs < 5000;
    }
    return true; // timestamps not verifiable on one side or the other — best-effort trust of pid
  }

  #continueSession(priorSession, record) {
    const runtimeId = this.tree.addStart(record);
    const treeRecord = this.tree.get(runtimeId);
    treeRecord.classification = 'AI_AGENT';
    treeRecord.agentType = priorSession.agent_identity;
    this.correlations.set(runtimeId, {
      projectId: priorSession.possible_project_id,
      confidence: priorSession.project_confidence,
      evidence: priorSession.project_evidence,
    });

    const continued = { ...priorSession, status: 'ACTIVE', runtime_id: runtimeId, closure_note: null };
    this.sessions.hydrateActive(continued, runtimeId);
    this.store.upsertAgentSession(continued).catch((err) => this.#handleAdapterError(err));
    this.emit({ type: 'session-continued', session: continued });
  }

  async #finalizeReconciliation() {
    if (this.reconciled) return;
    this.reconciled = true;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.startupFallbackTimer) clearTimeout(this.startupFallbackTimer);

    const buffer = this.startupBuffer;
    this.startupBuffer = [];
    const consumed = new Set();

    for (const raw of buffer) {
      const record = normalizeProcessEvent(raw);
      if (!record) continue;
      const priorSession = this.priorActiveSessions.find((s) => !consumed.has(s.session_id) && this.#sameProcessInstance(s, record));
      if (priorSession) {
        consumed.add(priorSession.session_id);
        this.#continueSession(priorSession, record);
        continue;
      }
      this.#enqueue(raw);
    }

    // A prior ACTIVE session whose process never showed up in this run's snapshot is one we lost
    // track of in the gap — never invent when/how it ended (see SPEC_V0.4.md section 8/11).
    for (const session of this.priorActiveSessions) {
      if (consumed.has(session.session_id)) continue;
      const closed = {
        ...session,
        status: this.priorObserverEndedCleanly ? 'UNKNOWN' : 'UNCLEAN',
        closure_note: this.priorObserverEndedCleanly
          ? 'observer restarted; process no longer alive; end time unknown'
          : 'observer ended uncleanly while this session was active; final state uncertain',
      };
      this.store.upsertAgentSession(closed).catch((err) => this.#handleAdapterError(err));
      this.sessions.hydrateClosed(closed);
    }

    const pending = this.pendingLive;
    this.pendingLive = [];
    for (const raw of pending) this.#enqueue(raw);

    // Wait for every #enqueue'd event above (buffered ALREADY_RUNNING + drained pendingLive) to
    // actually finish processing before declaring reconciliation done — otherwise a caller
    // awaiting whenReconciled() could observe the store before these writes land.
    await this.eventQueue;

    this.emit({ type: 'reconciled', reused: consumed.size, lost: this.priorActiveSessions.length - consumed.size });
  }

  async #processEvent(raw) {
    const record = normalizeProcessEvent(raw);
    if (!record) return;
    this.stats.eventsReceived += 1;

    if (record.type === 'PROCESS_STOPPED') {
      await this.#handleStop(record);
      return;
    }
    await this.#handleStart(record, record.type === 'ALREADY_RUNNING');
  }

  async #handleStart(record, alreadyRunning) {
    const runtimeId = this.tree.addStart(record);
    // correlateProject's "inherited from ancestor" tier reads record.runtimeId directly (its own
    // JSDoc always documented this) — without setting it here, tree.ancestors(record.runtimeId)
    // silently resolves to an empty array every time, and inheritance-tier correlation can never
    // fire. Found via real E2E: a real shell -> real Claude chain that could only be correlated
    // through inheritance (no direct evidence available) stayed UNKNOWN despite the shell itself
    // correlating HIGH just one hop up.
    record.runtimeId = runtimeId;
    const classification = classifyProcess(record.processName, { executablePath: record.executablePath }, this.config);
    this.stats.processesClassified += 1;

    const treeRecord = this.tree.get(runtimeId);
    treeRecord.classification = classification.classification;
    treeRecord.agentType = classification.agentType;

    if (classification.classification === 'OTHER') return; // tree kept for ancestry only

    if (!alreadyRunning) this.stats.processStarts += 1;

    const commandMetadata = sanitizeCommandMetadata(record.commandLine, this.config.process.captureCommandLine);
    this.stats.sanitizationCount += commandMetadata.redactedCount;
    record.commandLine = null; // never retained beyond sanitization

    let recentFsEvents = [];
    try {
      const sinceIso = new Date(new Date(record.timestamp).getTime() - this.config.process.correlationWindowMs).toISOString();
      recentFsEvents = await this.store.listWatchEvents({ sinceIso });
    } catch (err) {
      this.#handleAdapterError(err);
    }

    const shellCwd = this.shellRegistry?.getByPid(record.parentPid)?.cwd || null;
    const correlation = correlateProject({
      record,
      commandMetadata,
      tree: this.tree,
      projects: this.projects,
      correlations: this.correlations,
      recentFsEvents,
      correlationWindowMs: this.config.process.correlationWindowMs,
      shellCwd,
    });
    this.correlations.set(runtimeId, correlation);

    let sessionId = null;
    if (classification.classification === 'AI_AGENT') {
      const session = this.sessions.startSession({
        runtimeId,
        agentType: classification.agentType,
        pid: record.pid,
        parentPid: record.parentPid,
        timestamp: record.timestamp,
        startTimeKnown: record.startTimeKnown,
        correlation,
        treeSummary: this.tree.treeSummary(runtimeId),
        alreadyRunning,
        shellSessionId: this.shellRegistry?.getByPid(record.parentPid)?.shell_session_id || null,
      });
      sessionId = session.session_id;
      this.stats.agentSessionsDetected += 1;
      await this.store.upsertAgentSession(session);
      this.emit({ type: 'session-start', session });
    }

    await this.store.addProcessEvent({
      event_id: newId(),
      type: alreadyRunning ? 'ALREADY_RUNNING' : 'PROCESS_STARTED',
      timestamp: record.timestamp,
      pid: record.pid,
      parent_pid: record.parentPid,
      process_name: record.processName,
      executable_path_sanitized: sanitizeExecutablePath(record.executablePath),
      command_metadata: commandMetadata,
      classification: classification.classification,
      agent_type: classification.agentType,
      possible_project_id: correlation.projectId,
      project_confidence: correlation.confidence,
      session_id: sessionId,
      evidence: [...classification.evidence, ...correlation.evidence],
    });

    this.emit({ type: 'process-start', record, classification, correlation, alreadyRunning });
  }

  async #handleStop(record) {
    const treeRecord = this.tree.getByPid(record.pid);
    const runtimeId = this.tree.markStop(record.pid, record.timestamp);
    this.stats.processStops += 1;

    if (!treeRecord || !treeRecord.classification || treeRecord.classification === 'OTHER') return;

    let sessionId = null;
    if (treeRecord.classification === 'AI_AGENT' && runtimeId) {
      const session = this.sessions.endSession(runtimeId, record.timestamp);
      if (session) {
        sessionId = session.session_id;
        await this.store.upsertAgentSession(session);
        this.emit({ type: 'session-end', session });
      }
    } else if (treeRecord.classification === 'SHELL') {
      // SHELL_EXITING from the PowerShell hook isn't reliable (killed window, crashed host) —
      // this is what actually reconciles a shell session the hook never got to close cleanly.
      this.onShellProcessStopped?.(record.pid, record.timestamp);
    }

    await this.store.addProcessEvent({
      event_id: newId(),
      type: 'PROCESS_STOPPED',
      timestamp: record.timestamp,
      pid: record.pid,
      parent_pid: record.parentPid,
      process_name: record.processName,
      executable_path_sanitized: sanitizeExecutablePath(treeRecord.executablePath),
      command_metadata: null,
      classification: treeRecord.classification,
      agent_type: treeRecord.agentType,
      possible_project_id: null,
      project_confidence: null,
      session_id: sessionId,
      evidence: [],
    });

    this.emit({ type: 'process-stop', record, classification: treeRecord.classification });
  }

  // Re-evaluates project correlation for every currently ACTIVE agent session whose confidence
  // isn't already HIGH — called by `guardian observe` whenever the filesystem watcher reports a
  // refresh, so fresh filesystem activity can raise (never fabricate) a session's correlation.
  // See SPEC_V0.4.md section 12's worked example ("Claude correlation updated").
  async recheckActiveCorrelations() {
    const updates = [];
    for (const session of this.sessions.list({ active: true })) {
      const runtimeId = session.runtime_id;
      if (!runtimeId || session.project_confidence === CONFIDENCE.HIGH) continue;
      const treeRecord = this.tree.get(runtimeId);
      if (!treeRecord) continue;

      let recentFsEvents = [];
      try {
        const sinceIso = new Date(Date.now() - this.config.process.correlationWindowMs).toISOString();
        recentFsEvents = await this.store.listWatchEvents({ sinceIso });
      } catch (err) {
        this.#handleAdapterError(err);
        continue;
      }

      const correlation = correlateProject({
        record: { runtimeId, timestamp: new Date().toISOString(), executablePath: treeRecord.executablePath },
        commandMetadata: { pathLikeArgs: [] },
        tree: this.tree,
        projects: this.projects,
        correlations: this.correlations,
        recentFsEvents,
        correlationWindowMs: this.config.process.correlationWindowMs,
      });

      if (correlation.projectId && (correlation.projectId !== session.possible_project_id || correlation.confidence !== session.project_confidence)) {
        this.correlations.set(runtimeId, correlation);
        const updated = this.sessions.updateCorrelation(runtimeId, correlation);
        if (updated) {
          await this.store.upsertAgentSession(updated);
          this.emit({ type: 'correlation-updated', session: updated });
          updates.push(updated);
        }
      }
    }
    return updates;
  }

  #handleAdapterError(err) {
    this.stats.errors += 1;
    this.degraded = true;
    this.emit({ type: 'error', error: { message: err?.message || String(err) } });
  }

  async stop(status = 'STOPPED') {
    if (!this.running) return;
    this.running = false;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.startupFallbackTimer) clearTimeout(this.startupFallbackTimer);
    if (this.adapterHandle) {
      try {
        this.adapterHandle.stop();
      } catch {
        // already gone
      }
    }
    if (this.sessionId) {
      await this.store.updateObserverSession(this.sessionId, {
        stopped_at: new Date().toISOString(),
        status,
        events_received: this.stats.eventsReceived,
        process_starts: this.stats.processStarts,
        process_stops: this.stats.processStops,
        errors: this.stats.errors,
      });
    }
  }

  health() {
    return {
      status: !this.running ? 'STOPPED' : this.degraded ? 'DEGRADED' : 'RUNNING',
      startedAt: this.startedAt?.toISOString() || null,
      stats: { ...this.stats },
      activeAgentSessions: this.sessions.list({ active: true }).length,
      lastEvent: this.lastEvent,
    };
  }

  snapshot() {
    return { activeSessions: this.sessions.list({ active: true }), allSessions: this.sessions.list() };
  }
}
