import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const EMPTY = {
  projects: {},
  sources: [],
  observations: [],
  scans: [],
  intelligence: {},
  familyRollups: {},
  watchEvents: [],
  watchSessions: {},
  processEvents: [],
  agentSessions: {},
  observerSessions: {},
  shellEvents: [],
  shellSessions: {},
  nativeAgentEvents: [],
  projectRuntimeStates: {},
  workSessions: {},
};

// Bounded retention for the operational watch-event log — see SPEC_V0.3.md "Persistência de
// eventos": not meant as invasive telemetry, a reasonable rolling window is enough for V0.3.
const MAX_WATCH_EVENTS = 1000;

// Same rationale, V0.4 process-event log — see SPEC_V0.4.md section 13.
const MAX_PROCESS_EVENTS = 1000;

// Same rationale, V0.5A shell-event log — see SPEC_V0.5A.md section 10.
const MAX_SHELL_EVENTS = 1000;

// Same rationale, V0.6A native-agent-event log (SessionStart/CwdChanged/SessionEnd/Stop/
// StopFailure, metadata only — see SPEC_V0.6A.md section 3).
const MAX_NATIVE_AGENT_EVENTS = 1000;

// Fallback backend used when node:sqlite is unavailable. Keeps the whole dataset as one JSON
// document and writes atomically (write to a temp file, then rename over the target) so a
// crash mid-write can never corrupt the previous good state.
export class JsonFileStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = EMPTY;
  }

  async init() {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (existsSync(this.filePath)) {
      const text = readFileSync(this.filePath, 'utf8');
      this.data = text.trim() ? JSON.parse(text) : structuredClone(EMPTY);
      // Forward-compat: a store written before V0.2/V0.3 won't have these keys yet.
      this.data.intelligence = this.data.intelligence || {};
      this.data.familyRollups = this.data.familyRollups || {};
      this.data.watchEvents = this.data.watchEvents || [];
      this.data.watchSessions = this.data.watchSessions || {};
      this.data.processEvents = this.data.processEvents || [];
      this.data.agentSessions = this.data.agentSessions || {};
      this.data.observerSessions = this.data.observerSessions || {};
      this.data.shellEvents = this.data.shellEvents || [];
      this.data.shellSessions = this.data.shellSessions || {};
      this.data.nativeAgentEvents = this.data.nativeAgentEvents || [];
      this.data.projectRuntimeStates = this.data.projectRuntimeStates || {};
      this.data.workSessions = this.data.workSessions || {};
    } else {
      this.data = structuredClone(EMPTY);
      this.#flush();
    }
  }

  #flush() {
    const tmpPath = `${this.filePath}.tmp-${process.pid}`;
    writeFileSync(tmpPath, JSON.stringify(this.data, null, 2));
    renameSync(tmpPath, this.filePath);
  }

  async upsertProject(project) {
    this.data.projects[project.id] = { ...this.data.projects[project.id], ...project };
    this.#flush();
  }

  async removeProject(id) {
    delete this.data.projects[id];
    this.data.sources = this.data.sources.filter((s) => s.project_id !== id);
    this.data.observations = this.data.observations.filter((o) => o.project_id !== id);
    this.#flush();
  }

  async getProject(idOrPath) {
    if (this.data.projects[idOrPath]) return this.data.projects[idOrPath];
    return Object.values(this.data.projects).find((p) => p.root_path === idOrPath) || null;
  }

  async listProjects() {
    return Object.values(this.data.projects);
  }

  async addSource(source) {
    this.data.sources.push(source);
    this.#flush();
  }

  async listSourcesForProject(projectId) {
    return this.data.sources.filter((s) => s.project_id === projectId);
  }

  async addObservation(observation) {
    this.data.observations.push(observation);
    this.#flush();
  }

  async listObservationsForProject(projectId) {
    return this.data.observations.filter((o) => o.project_id === projectId);
  }

  async recordScan(scan) {
    this.data.scans.push(scan);
    this.#flush();
  }

  async getLastScan() {
    return this.data.scans.length ? this.data.scans[this.data.scans.length - 1] : null;
  }

  async upsertIntelligence(snapshot) {
    this.data.intelligence[snapshot.project_id] = snapshot;
    this.#flush();
  }

  async getIntelligence(projectId) {
    return this.data.intelligence[projectId] || null;
  }

  async listIntelligence() {
    return Object.values(this.data.intelligence);
  }

  async upsertFamilyRollup(rollup) {
    this.data.familyRollups[rollup.project_family] = rollup;
    this.#flush();
  }

  async getFamilyRollup(projectFamily) {
    return this.data.familyRollups[projectFamily] || null;
  }

  async listFamilyRollups() {
    return Object.values(this.data.familyRollups);
  }

  async addWatchEvent(event) {
    this.data.watchEvents.push(event);
    if (this.data.watchEvents.length > MAX_WATCH_EVENTS) {
      this.data.watchEvents = this.data.watchEvents.slice(-MAX_WATCH_EVENTS);
    }
    this.#flush();
  }

  async listWatchEvents({ projectId, sinceIso } = {}) {
    let events = this.data.watchEvents;
    if (projectId) events = events.filter((e) => e.project_id === projectId);
    if (sinceIso) events = events.filter((e) => e.occurred_at >= sinceIso);
    return events;
  }

  async startWatchSession(session) {
    this.data.watchSessions[session.session_id] = session;
    this.#flush();
  }

  async updateWatchSession(sessionId, patch) {
    this.data.watchSessions[sessionId] = { ...this.data.watchSessions[sessionId], ...patch };
    this.#flush();
  }

  async getWatchSession(sessionId) {
    return this.data.watchSessions[sessionId] || null;
  }

  async listWatchSessions() {
    return Object.values(this.data.watchSessions);
  }

  async getLatestWatchSession() {
    const sessions = Object.values(this.data.watchSessions);
    if (!sessions.length) return null;
    return sessions.reduce((latest, s) => (!latest || s.started_at > latest.started_at ? s : latest), null);
  }

  async addProcessEvent(event) {
    this.data.processEvents.push(event);
    if (this.data.processEvents.length > MAX_PROCESS_EVENTS) {
      this.data.processEvents = this.data.processEvents.slice(-MAX_PROCESS_EVENTS);
    }
    this.#flush();
  }

  async listProcessEvents({ sinceIso, type } = {}) {
    let events = this.data.processEvents;
    if (sinceIso) events = events.filter((e) => e.timestamp >= sinceIso);
    if (type) events = events.filter((e) => e.type === type);
    return events;
  }

  async upsertAgentSession(session) {
    this.data.agentSessions[session.session_id] = session;
    this.#flush();
  }

  async getAgentSession(sessionId) {
    return this.data.agentSessions[sessionId] || null;
  }

  async listAgentSessions({ active } = {}) {
    let sessions = Object.values(this.data.agentSessions);
    if (active !== undefined) sessions = sessions.filter((s) => (active ? s.status === 'ACTIVE' : s.status !== 'ACTIVE'));
    return sessions;
  }

  async startObserverSession(session) {
    this.data.observerSessions[session.session_id] = session;
    this.#flush();
  }

  async updateObserverSession(sessionId, patch) {
    this.data.observerSessions[sessionId] = { ...this.data.observerSessions[sessionId], ...patch };
    this.#flush();
  }

  async getObserverSession(sessionId) {
    return this.data.observerSessions[sessionId] || null;
  }

  async listObserverSessions() {
    return Object.values(this.data.observerSessions);
  }

  async getLatestObserverSession() {
    const sessions = Object.values(this.data.observerSessions);
    if (!sessions.length) return null;
    return sessions.reduce((latest, s) => (!latest || s.started_at > latest.started_at ? s : latest), null);
  }

  async addShellEvent(event) {
    this.data.shellEvents.push(event);
    if (this.data.shellEvents.length > MAX_SHELL_EVENTS) {
      this.data.shellEvents = this.data.shellEvents.slice(-MAX_SHELL_EVENTS);
    }
    this.#flush();
  }

  async listShellEvents({ sinceIso, type, projectId } = {}) {
    let events = this.data.shellEvents;
    if (sinceIso) events = events.filter((e) => e.timestamp >= sinceIso);
    if (type) events = events.filter((e) => e.type === type);
    if (projectId) events = events.filter((e) => e.project_id === projectId);
    return events;
  }

  async upsertShellSession(session) {
    this.data.shellSessions[session.shell_session_id] = session;
    this.#flush();
  }

  async getShellSession(sessionId) {
    return this.data.shellSessions[sessionId] || null;
  }

  async listShellSessions({ active } = {}) {
    let sessions = Object.values(this.data.shellSessions);
    if (active !== undefined) sessions = sessions.filter((s) => (active ? s.status === 'ACTIVE' : s.status !== 'ACTIVE'));
    return sessions;
  }

  async addNativeAgentEvent(event) {
    this.data.nativeAgentEvents.push(event);
    if (this.data.nativeAgentEvents.length > MAX_NATIVE_AGENT_EVENTS) {
      this.data.nativeAgentEvents = this.data.nativeAgentEvents.slice(-MAX_NATIVE_AGENT_EVENTS);
    }
    this.#flush();
  }

  async listNativeAgentEvents({ sinceIso, type, sessionId } = {}) {
    let events = this.data.nativeAgentEvents;
    if (sinceIso) events = events.filter((e) => e.timestamp >= sinceIso);
    if (type) events = events.filter((e) => e.type === type);
    if (sessionId) events = events.filter((e) => e.session_id === sessionId || e.native_session_id === sessionId);
    return events;
  }

  async upsertProjectRuntimeState(state) { this.data.projectRuntimeStates[state.project_id] = state; this.#flush(); }
  async getProjectRuntimeState(projectId) { return this.data.projectRuntimeStates[projectId] || null; }
  async listProjectRuntimeStates() { return Object.values(this.data.projectRuntimeStates); }
  async upsertWorkSession(session) { this.data.workSessions[session.session_id] = session; this.#flush(); }
  async listWorkSessions({ projectId } = {}) { const all = Object.values(this.data.workSessions); return projectId ? all.filter((s) => s.project_id === projectId) : all; }

  async close() {
    this.#flush();
  }
}
