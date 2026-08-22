const ACTIVE_FS_MS = 5 * 60 * 1000;
const RECENT_MS = 24 * 60 * 60 * 1000;

function timeOf(value) {
  const n = value ? Date.parse(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function evidence(source, value, at) {
  return { source, value, at: at || null };
}

function latestTimestamp(values) {
  return values.map(timeOf).filter((v) => v !== null).sort((a, b) => b - a)[0] || null;
}

export function buildWorkSessions({ projectId, agentSessions = [], shellSessions = [] }) {
  const shells = new Map(shellSessions.map((s) => [s.shell_session_id, s]));
  return agentSessions
    .filter((s) => s.possible_project_id === projectId)
    .map((s) => {
      const shell = s.shell_session_id ? shells.get(s.shell_session_id) : null;
      return {
        session_id: s.session_id,
        project_id: projectId,
        agents: [s.agent_identity],
        shells: shell ? [shell.shell_session_id] : [],
        processes: s.pid ? [s.pid] : [],
        started_at: s.started_at || null,
        last_activity_at: s.ended_at || s.last_activity_at || s.started_at || null,
        ended_at: s.ended_at || null,
        focus: null,
        evidence_sources: [...new Set(s.evidence_sources || [])],
        confidence: s.project_confidence || 'UNKNOWN',
      };
    });
}

export function buildProjectRuntimeState({ project, intelligence, agentSessions = [], shellSessions = [], watchEvents = [], nativeEvents = [], now = new Date() }) {
  const nowMs = now.getTime();
  const workSessions = buildWorkSessions({ projectId: project.id, agentSessions, shellSessions });
  const activeWork = workSessions.filter((s) => !s.ended_at && agentSessions.find((a) => a.session_id === s.session_id)?.status === 'ACTIVE');
  const projectWatch = watchEvents.filter((e) => e.project_id === project.id);
  const agentIds = new Set(workSessions.map((w) => w.session_id));
  const projectNative = nativeEvents.filter((e) => agentIds.has(e.session_id));
  const lastMs = latestTimestamp([
    ...workSessions.flatMap((s) => [s.last_activity_at, s.started_at]),
    ...projectWatch.map((e) => e.occurred_at),
    intelligence?.last_meaningful_work?.at,
  ]);
  const recentFs = projectWatch.some((e) => nowMs - (timeOf(e.occurred_at) || 0) <= ACTIVE_FS_MS);
  const blockers = intelligence?.blockers || [];
  let operationalStatus = 'UNKNOWN';
  let confidence = 'UNKNOWN';
  const stateEvidence = [];
  if (activeWork.length) {
    operationalStatus = 'ACTIVE_NOW';
    confidence = 'HIGH';
    stateEvidence.push(evidence('agent_session', `${activeWork.length} active correlated native/process session(s)`, now.toISOString()));
  } else if (recentFs) {
    operationalStatus = 'ACTIVE_NOW';
    confidence = 'MEDIUM';
    stateEvidence.push(evidence('filesystem', 'meaningful project activity within five minutes', new Date(lastMs).toISOString()));
  } else if (blockers.length) {
    operationalStatus = 'BLOCKED';
    confidence = blockers.some((b) => b.confidence === 'HIGH') ? 'HIGH' : 'MEDIUM';
    stateEvidence.push(...blockers.flatMap((b) => b.evidence || []).map((e) => evidence(e.source, bText(e), e.timestamp)));
  } else if (lastMs && nowMs - lastMs <= RECENT_MS) {
    operationalStatus = 'RECENTLY_ACTIVE';
    confidence = 'MEDIUM';
    stateEvidence.push(evidence('activity_timeline', 'last meaningful activity within 24 hours', new Date(lastMs).toISOString()));
  } else if (lastMs) {
    operationalStatus = 'IDLE';
    confidence = 'MEDIUM';
    stateEvidence.push(evidence('activity_timeline', 'no meaningful activity within 24 hours', new Date(lastMs).toISOString()));
  }
  const timeline = [
    ...projectNative.map((e) => ({ at: e.timestamp, type: e.type, source: e.agent || 'NATIVE_AGENT', session_id: e.session_id })),
    ...projectWatch.map((e) => ({ at: e.occurred_at, type: e.event_type, source: 'FILESYSTEM', session_id: null })),
  ].filter((e) => e.at).sort((a, b) => a.at.localeCompare(b.at));
  const activeAgents = activeWork.map((w) => w.agents[0]);
  const recentAgents = [...new Set(workSessions.map((w) => w.agents[0]))];
  return {
    project_id: project.id,
    generated_at: now.toISOString(),
    operational_status: operationalStatus,
    active_agents: [...new Set(activeAgents)],
    recent_agents: recentAgents,
    current_focus: intelligence?.current_focus || { value: null, confidence: 'UNKNOWN', evidence: [] },
    current_phase: null,
    last_meaningful_activity: lastMs ? new Date(lastMs).toISOString() : null,
    open_blockers: blockers,
    next_actions: intelligence?.next_steps || [],
    activity_sources: [...new Set([...workSessions.flatMap((w) => w.evidence_sources), ...(projectWatch.length ? ['FILESYSTEM'] : []), ...(intelligence ? ['PROJECT_INTELLIGENCE'] : [])])],
    confidence,
    evidence: stateEvidence,
    work_sessions: workSessions,
    timeline,
  };
}

function bText(e) { return e.snippet || e.value || 'explicit blocker evidence'; }

export async function refreshRuntimeStates(store, now = new Date()) {
  const [projects, intelligence, agentSessions, shellSessions, watchEvents, nativeEvents] = await Promise.all([
    store.listProjects(), store.listIntelligence(), store.listAgentSessions({}), store.listShellSessions({}), store.listWatchEvents({}), store.listNativeAgentEvents({}),
  ]);
  const intelById = new Map(intelligence.map((i) => [i.project_id, i]));
  const states = [];
  for (const project of projects) {
    const state = buildProjectRuntimeState({ project, intelligence: intelById.get(project.id), agentSessions, shellSessions, watchEvents, nativeEvents, now });
    await store.upsertProjectRuntimeState(state);
    for (const session of state.work_sessions) await store.upsertWorkSession(session);
    states.push(state);
  }
  return states;
}
