import path from 'node:path';
import { createStore } from '../../store/createStore.js';

function parseArgs(args) {
  let active = false;
  let agent = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--active') active = true;
    if (args[i] === '--agent') agent = args[i + 1];
  }
  return { active, agent };
}

function fmtDuration(ms) {
  if (ms == null) return 'n/a';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}m${(s % 60).toString().padStart(2, '0')}s`;
}

// Shared by `guardian agents` and `guardian agent sessions` (see agent.js) — a V0.6A-aware view
// of the SAME unified agentSessions collection `guardian sessions` (V0.4) reads, additionally
// surfacing evidence_sources/native_session_id so it's visible which sessions have authoritative
// Claude native evidence vs. process/shell-only inference. Never a second data source.
export async function listAgentSessions({ projectRoot, active, agentFilter }) {
  const { store } = await createStore(path.join(projectRoot, 'data', 'guardian.db'));
  let sessions = await store.listAgentSessions(active ? { active: true } : {});
  const projects = await store.listProjects();
  await store.close();

  if (agentFilter) sessions = sessions.filter((s) => s.agent_identity?.toLowerCase().includes(agentFilter.toLowerCase()));
  return { sessions, projects };
}

export function printAgentSessions(sessions, projects, { active } = {}) {
  if (sessions.length === 0) {
    console.log('No agent sessions recorded. Run `guardian observe` to start observing.');
    return;
  }

  console.log(active ? 'ACTIVE AGENT SESSIONS' : 'AGENT SESSIONS');
  console.log('');
  for (const s of sessions) {
    const project = s.possible_project_id ? projects.find((p) => p.id === s.possible_project_id) : null;
    console.log(`${s.agent_identity}  (session ${s.session_id})`);
    console.log(`PID: ${s.pid ?? 'unknown'}`);
    console.log(`Started: ${s.started_at || `unknown (${s.start_source})`}`);
    if (s.status === 'ENDED') console.log(`Ended: ${s.ended_at}  Duration: ${fmtDuration(s.duration_ms)}`);
    console.log(`Status: ${s.status}`);
    console.log(`Project: ${project ? project.name : 'UNKNOWN'}`);
    console.log(`Confidence: ${s.project_confidence}`);
    console.log(`Evidence sources: ${(s.evidence_sources || ['PROCESS']).join(', ')}`);
    if (s.native_session_id) console.log(`Claude native session: ${s.native_session_id}`);
    if (s.shell_session_id) console.log(`Shell session: ${s.shell_session_id}`);
    if (s.closure_note) console.log(`Note: ${s.closure_note}`);
    console.log('');
  }
}

// `guardian agents [--active] [--agent <name>]`
export async function agentsCommand({ projectRoot, args }) {
  const { active, agent } = parseArgs(args);
  const { sessions, projects } = await listAgentSessions({ projectRoot, active, agentFilter: agent });
  printAgentSessions(sessions, projects, { active });
  return sessions;
}
