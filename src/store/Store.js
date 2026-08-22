// Documents the persistence interface every backend (JsonFileStore, NodeSqliteStore)
// implements. This file has no logic — it exists so the contract is written down once.
//
// interface Store {
//   async init(): Promise<void>
//   async upsertProject(project: Project): Promise<void>
//   async removeProject(id: string): Promise<void>   // also drops its sources/observations
//   async getProject(idOrPath: string): Promise<Project | null>
//   async listProjects(): Promise<Project[]>
//   async addSource(source: Source): Promise<void>
//   async listSourcesForProject(projectId: string): Promise<Source[]>
//   async addObservation(observation: Observation): Promise<void>
//   async listObservationsForProject(projectId: string): Promise<Observation[]>
//   async recordScan(scan: Scan): Promise<void>
//   async getLastScan(): Promise<Scan | null>
//   // V0.2 — intelligence layer (see ARCHITECTURE.md "V0.2 — intelligence layer"):
//   async upsertIntelligence(snapshot: ProjectIntelligence): Promise<void>
//   async getIntelligence(projectId: string): Promise<ProjectIntelligence | null>
//   async listIntelligence(): Promise<ProjectIntelligence[]>
//   async upsertFamilyRollup(rollup: FamilyRollup): Promise<void>
//   async getFamilyRollup(projectFamily: string): Promise<FamilyRollup | null>
//   async listFamilyRollups(): Promise<FamilyRollup[]>
//   // V0.3 — watcher (see SPEC_V0.3.md):
//   async addWatchEvent(event: WatchEvent): Promise<void>
//   async listWatchEvents(filter?: { projectId?: string, sinceIso?: string }): Promise<WatchEvent[]>
//   async startWatchSession(session: WatchSession): Promise<void>
//   async updateWatchSession(sessionId: string, patch: Partial<WatchSession>): Promise<void>
//   async getWatchSession(sessionId: string): Promise<WatchSession | null>
//   async listWatchSessions(): Promise<WatchSession[]>
//   async getLatestWatchSession(): Promise<WatchSession | null>
//   // V0.4 — process & agent session observer (see SPEC_V0.4.md):
//   async addProcessEvent(event: ProcessEvent): Promise<void>
//   async listProcessEvents(filter?: { sinceIso?: string, type?: string }): Promise<ProcessEvent[]>
//   async upsertAgentSession(session: AgentSession): Promise<void>
//   async getAgentSession(sessionId: string): Promise<AgentSession | null>
//   async listAgentSessions(filter?: { active?: boolean }): Promise<AgentSession[]>
//   async startObserverSession(session: ObserverSession): Promise<void>
//   async updateObserverSession(sessionId: string, patch: Partial<ObserverSession>): Promise<void>
//   async getObserverSession(sessionId: string): Promise<ObserverSession | null>
//   async listObserverSessions(): Promise<ObserverSession[]>
//   async getLatestObserverSession(): Promise<ObserverSession | null>
//   // V0.5A — PowerShell shell context hooks (see SPEC_V0.5A.md):
//   async addShellEvent(event: ShellEvent): Promise<void>
//   async listShellEvents(filter?: { sinceIso?: string, type?: string, projectId?: string }): Promise<ShellEvent[]>
//   async upsertShellSession(session: ShellSession): Promise<void>
//   async getShellSession(sessionId: string): Promise<ShellSession | null>
//   async listShellSessions(filter?: { active?: boolean }): Promise<ShellSession[]>
//   // V0.6A — Claude Code native hooks (see SPEC_V0.6A.md). Native events enrich the SAME
//   // agentSessions record V0.4 created (matched by pid) rather than a separate collection — see
//   // src/agent/claude/observer.js. This log is metadata-only turn-activity/lifecycle history.
//   async addNativeAgentEvent(event: NativeAgentEvent): Promise<void>
//   async listNativeAgentEvents(filter?: { sinceIso?: string, type?: string, sessionId?: string }): Promise<NativeAgentEvent[]>
//   // V0.6C — derived unified activity, never a second source of project memory:
//   async upsertProjectRuntimeState(state: ProjectRuntimeState): Promise<void>
//   async getProjectRuntimeState(projectId: string): Promise<ProjectRuntimeState | null>
//   async listProjectRuntimeStates(): Promise<ProjectRuntimeState[]>
//   async upsertWorkSession(session: WorkSession): Promise<void>
//   async listWorkSessions(filter?: { projectId?: string }): Promise<WorkSession[]>
//   async close(): Promise<void>
// }
//
// See ARCHITECTURE.md "Data model" for the Project/Source/Observation/Scan shapes.
