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

// `guardian sessions [--active] [--agent <name>]` — reconstructed AI-agent sessions (V0.4). A
// session with `possible_project_id: null` / `project_confidence: UNKNOWN` is a valid, expected
// result — Guardian never guesses which project an agent is working on without evidence.
export async function sessionsCommand({ projectRoot, args }) {
  const { active, agent } = parseArgs(args);
  const { store } = await createStore(path.join(projectRoot, 'data', 'guardian.db'));

  let sessions = await store.listAgentSessions(active ? { active: true } : {});
  const projects = await store.listProjects();
  await store.close();

  if (agent) sessions = sessions.filter((s) => s.agent_identity?.toLowerCase().includes(agent.toLowerCase()));

  if (sessions.length === 0) {
    console.log('No agent sessions recorded. Run `guardian observe` to start observing.');
    return sessions;
  }

  console.log(active ? 'ACTIVE AGENT SESSIONS' : 'AGENT SESSIONS');
  console.log('');
  for (const s of sessions) {
    const project = s.possible_project_id ? projects.find((p) => p.id === s.possible_project_id) : null;
    console.log(s.agent_identity);
    console.log(`PID: ${s.pid}`);
    console.log(`Started: ${s.started_at || `unknown (${s.start_source})`}`);
    if (s.status === 'ENDED') console.log(`Ended: ${s.ended_at}  Duration: ${fmtDuration(s.duration_ms)}`);
    console.log(`Status: ${s.status}`);
    console.log(`Project: ${project ? project.name : 'UNKNOWN'}`);
    console.log(`Confidence: ${s.project_confidence}`);
    if (s.closure_note) console.log(`Note: ${s.closure_note}`);
    console.log('');
  }
  return sessions;
}
