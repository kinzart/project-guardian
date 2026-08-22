// Backend used when node:sqlite (DatabaseSync) is available (Node >= 22.5). Not exercised by
// the test suite on this host (Node v20.11.0 has no node:sqlite) — createStore.js only ever
// instantiates this class after successfully importing the module, so a missing module never
// reaches this file's runtime code. Kept alongside JsonFileStore behind the same interface so
// upgrading Node is a drop-in backend swap, not a rewrite.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
  project_id TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS observations (
  project_id TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scans (
  scan_id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS intelligence (
  project_id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS family_rollups (
  project_family TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS watch_events (
  event_id TEXT PRIMARY KEY,
  project_id TEXT,
  occurred_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS watch_sessions (
  session_id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS process_events (
  event_id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  type TEXT,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_sessions (
  session_id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS observer_sessions (
  session_id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shell_events (
  event_id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  type TEXT,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shell_sessions (
  shell_session_id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS native_agent_events (
  event_id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  type TEXT,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_runtime_states (project_id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS work_sessions (session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL);
`;

export class NodeSqliteStore {
  constructor(filePath, sqliteModule) {
    this.filePath = filePath;
    this.DatabaseSync = sqliteModule.DatabaseSync;
    this.db = null;
  }

  async init() {
    this.db = new this.DatabaseSync(this.filePath);
    this.db.exec(SCHEMA);
  }

  async upsertProject(project) {
    this.db
      .prepare('INSERT INTO projects (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(project.id, JSON.stringify(project));
  }

  async removeProject(id) {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM sources WHERE project_id = ?').run(id);
    this.db.prepare('DELETE FROM observations WHERE project_id = ?').run(id);
  }

  async getProject(idOrPath) {
    const row = this.db.prepare('SELECT data FROM projects WHERE id = ?').get(idOrPath);
    if (row) return JSON.parse(row.data);
    const all = await this.listProjects();
    return all.find((p) => p.root_path === idOrPath) || null;
  }

  async listProjects() {
    const rows = this.db.prepare('SELECT data FROM projects').all();
    return rows.map((r) => JSON.parse(r.data));
  }

  async addSource(source) {
    this.db.prepare('INSERT INTO sources (project_id, data) VALUES (?, ?)').run(source.project_id, JSON.stringify(source));
  }

  async listSourcesForProject(projectId) {
    const rows = this.db.prepare('SELECT data FROM sources WHERE project_id = ?').all(projectId);
    return rows.map((r) => JSON.parse(r.data));
  }

  async addObservation(observation) {
    this.db
      .prepare('INSERT INTO observations (project_id, data) VALUES (?, ?)')
      .run(observation.project_id, JSON.stringify(observation));
  }

  async listObservationsForProject(projectId) {
    const rows = this.db.prepare('SELECT data FROM observations WHERE project_id = ?').all(projectId);
    return rows.map((r) => JSON.parse(r.data));
  }

  async recordScan(scan) {
    this.db
      .prepare('INSERT INTO scans (scan_id, data) VALUES (?, ?) ON CONFLICT(scan_id) DO UPDATE SET data = excluded.data')
      .run(scan.scan_id, JSON.stringify(scan));
  }

  async getLastScan() {
    const row = this.db.prepare('SELECT data FROM scans ORDER BY rowid DESC LIMIT 1').get();
    return row ? JSON.parse(row.data) : null;
  }

  async upsertIntelligence(snapshot) {
    this.db
      .prepare('INSERT INTO intelligence (project_id, data) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET data = excluded.data')
      .run(snapshot.project_id, JSON.stringify(snapshot));
  }

  async getIntelligence(projectId) {
    const row = this.db.prepare('SELECT data FROM intelligence WHERE project_id = ?').get(projectId);
    return row ? JSON.parse(row.data) : null;
  }

  async listIntelligence() {
    const rows = this.db.prepare('SELECT data FROM intelligence').all();
    return rows.map((r) => JSON.parse(r.data));
  }

  async upsertFamilyRollup(rollup) {
    this.db
      .prepare('INSERT INTO family_rollups (project_family, data) VALUES (?, ?) ON CONFLICT(project_family) DO UPDATE SET data = excluded.data')
      .run(rollup.project_family, JSON.stringify(rollup));
  }

  async getFamilyRollup(projectFamily) {
    const row = this.db.prepare('SELECT data FROM family_rollups WHERE project_family = ?').get(projectFamily);
    return row ? JSON.parse(row.data) : null;
  }

  async listFamilyRollups() {
    const rows = this.db.prepare('SELECT data FROM family_rollups').all();
    return rows.map((r) => JSON.parse(r.data));
  }

  async addWatchEvent(event) {
    this.db
      .prepare('INSERT INTO watch_events (event_id, project_id, occurred_at, data) VALUES (?, ?, ?, ?)')
      .run(event.event_id, event.project_id || null, event.occurred_at, JSON.stringify(event));
  }

  async listWatchEvents({ projectId, sinceIso } = {}) {
    let rows;
    if (projectId && sinceIso) {
      rows = this.db.prepare('SELECT data FROM watch_events WHERE project_id = ? AND occurred_at >= ? ORDER BY occurred_at').all(projectId, sinceIso);
    } else if (projectId) {
      rows = this.db.prepare('SELECT data FROM watch_events WHERE project_id = ? ORDER BY occurred_at').all(projectId);
    } else if (sinceIso) {
      rows = this.db.prepare('SELECT data FROM watch_events WHERE occurred_at >= ? ORDER BY occurred_at').all(sinceIso);
    } else {
      rows = this.db.prepare('SELECT data FROM watch_events ORDER BY occurred_at').all();
    }
    return rows.map((r) => JSON.parse(r.data));
  }

  async startWatchSession(session) {
    this.db
      .prepare('INSERT INTO watch_sessions (session_id, data) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET data = excluded.data')
      .run(session.session_id, JSON.stringify(session));
  }

  async updateWatchSession(sessionId, patch) {
    const existing = await this.getWatchSession(sessionId);
    await this.startWatchSession({ ...existing, ...patch, session_id: sessionId });
  }

  async getWatchSession(sessionId) {
    const row = this.db.prepare('SELECT data FROM watch_sessions WHERE session_id = ?').get(sessionId);
    return row ? JSON.parse(row.data) : null;
  }

  async listWatchSessions() {
    const rows = this.db.prepare('SELECT data FROM watch_sessions').all();
    return rows.map((r) => JSON.parse(r.data));
  }

  async getLatestWatchSession() {
    const sessions = await this.listWatchSessions();
    if (!sessions.length) return null;
    return sessions.reduce((latest, s) => (!latest || s.started_at > latest.started_at ? s : latest), null);
  }

  async addProcessEvent(event) {
    this.db
      .prepare('INSERT INTO process_events (event_id, timestamp, type, data) VALUES (?, ?, ?, ?)')
      .run(event.event_id, event.timestamp, event.type || null, JSON.stringify(event));
  }

  async listProcessEvents({ sinceIso, type } = {}) {
    let rows;
    if (sinceIso && type) {
      rows = this.db.prepare('SELECT data FROM process_events WHERE timestamp >= ? AND type = ? ORDER BY timestamp').all(sinceIso, type);
    } else if (sinceIso) {
      rows = this.db.prepare('SELECT data FROM process_events WHERE timestamp >= ? ORDER BY timestamp').all(sinceIso);
    } else if (type) {
      rows = this.db.prepare('SELECT data FROM process_events WHERE type = ? ORDER BY timestamp').all(type);
    } else {
      rows = this.db.prepare('SELECT data FROM process_events ORDER BY timestamp').all();
    }
    return rows.map((r) => JSON.parse(r.data));
  }

  async upsertAgentSession(session) {
    this.db
      .prepare('INSERT INTO agent_sessions (session_id, data) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET data = excluded.data')
      .run(session.session_id, JSON.stringify(session));
  }

  async getAgentSession(sessionId) {
    const row = this.db.prepare('SELECT data FROM agent_sessions WHERE session_id = ?').get(sessionId);
    return row ? JSON.parse(row.data) : null;
  }

  async listAgentSessions({ active } = {}) {
    const rows = this.db.prepare('SELECT data FROM agent_sessions').all();
    let sessions = rows.map((r) => JSON.parse(r.data));
    if (active !== undefined) sessions = sessions.filter((s) => (active ? s.status === 'ACTIVE' : s.status !== 'ACTIVE'));
    return sessions;
  }

  async startObserverSession(session) {
    this.db
      .prepare('INSERT INTO observer_sessions (session_id, data) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET data = excluded.data')
      .run(session.session_id, JSON.stringify(session));
  }

  async updateObserverSession(sessionId, patch) {
    const existing = await this.getObserverSession(sessionId);
    await this.startObserverSession({ ...existing, ...patch, session_id: sessionId });
  }

  async getObserverSession(sessionId) {
    const row = this.db.prepare('SELECT data FROM observer_sessions WHERE session_id = ?').get(sessionId);
    return row ? JSON.parse(row.data) : null;
  }

  async listObserverSessions() {
    const rows = this.db.prepare('SELECT data FROM observer_sessions').all();
    return rows.map((r) => JSON.parse(r.data));
  }

  async getLatestObserverSession() {
    const sessions = await this.listObserverSessions();
    if (!sessions.length) return null;
    return sessions.reduce((latest, s) => (!latest || s.started_at > latest.started_at ? s : latest), null);
  }

  async addShellEvent(event) {
    this.db
      .prepare('INSERT INTO shell_events (event_id, timestamp, type, data) VALUES (?, ?, ?, ?)')
      .run(event.id, event.timestamp, event.type || null, JSON.stringify(event));
  }

  async listShellEvents({ sinceIso, type, projectId } = {}) {
    const rows = this.db.prepare('SELECT data FROM shell_events ORDER BY timestamp').all();
    let events = rows.map((r) => JSON.parse(r.data));
    if (sinceIso) events = events.filter((e) => e.timestamp >= sinceIso);
    if (type) events = events.filter((e) => e.type === type);
    if (projectId) events = events.filter((e) => e.project_id === projectId);
    return events;
  }

  async upsertShellSession(session) {
    this.db
      .prepare('INSERT INTO shell_sessions (shell_session_id, data) VALUES (?, ?) ON CONFLICT(shell_session_id) DO UPDATE SET data = excluded.data')
      .run(session.shell_session_id, JSON.stringify(session));
  }

  async getShellSession(sessionId) {
    const row = this.db.prepare('SELECT data FROM shell_sessions WHERE shell_session_id = ?').get(sessionId);
    return row ? JSON.parse(row.data) : null;
  }

  async listShellSessions({ active } = {}) {
    const rows = this.db.prepare('SELECT data FROM shell_sessions').all();
    let sessions = rows.map((r) => JSON.parse(r.data));
    if (active !== undefined) sessions = sessions.filter((s) => (active ? s.status === 'ACTIVE' : s.status !== 'ACTIVE'));
    return sessions;
  }

  async addNativeAgentEvent(event) {
    this.db
      .prepare('INSERT INTO native_agent_events (event_id, timestamp, type, data) VALUES (?, ?, ?, ?)')
      .run(event.event_id, event.timestamp, event.type || null, JSON.stringify(event));
  }

  async listNativeAgentEvents({ sinceIso, type, sessionId } = {}) {
    const rows = this.db.prepare('SELECT data FROM native_agent_events ORDER BY timestamp').all();
    let events = rows.map((r) => JSON.parse(r.data));
    if (sinceIso) events = events.filter((e) => e.timestamp >= sinceIso);
    if (type) events = events.filter((e) => e.type === type);
    if (sessionId) events = events.filter((e) => e.session_id === sessionId || e.native_session_id === sessionId);
    return events;
  }

  async upsertProjectRuntimeState(state) { this.db.prepare('INSERT INTO project_runtime_states (project_id, data) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET data = excluded.data').run(state.project_id, JSON.stringify(state)); }
  async getProjectRuntimeState(projectId) { const row = this.db.prepare('SELECT data FROM project_runtime_states WHERE project_id = ?').get(projectId); return row ? JSON.parse(row.data) : null; }
  async listProjectRuntimeStates() { return this.db.prepare('SELECT data FROM project_runtime_states').all().map((r) => JSON.parse(r.data)); }
  async upsertWorkSession(session) { this.db.prepare('INSERT INTO work_sessions (session_id, project_id, data) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET project_id = excluded.project_id, data = excluded.data').run(session.session_id, session.project_id, JSON.stringify(session)); }
  async listWorkSessions({ projectId } = {}) { const rows = projectId ? this.db.prepare('SELECT data FROM work_sessions WHERE project_id = ?').all(projectId) : this.db.prepare('SELECT data FROM work_sessions').all(); return rows.map((r) => JSON.parse(r.data)); }

  async close() {
    this.db.close();
  }
}
