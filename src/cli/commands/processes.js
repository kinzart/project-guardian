import path from 'node:path';
import { createStore } from '../../store/createStore.js';

const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function parseSince(sinceArg) {
  if (!sinceArg) return null;
  const m = sinceArg.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!m) return null;
  return new Date(Date.now() - Number(m[1]) * UNIT_MS[m[2]]).toISOString();
}

function parseArgs(args) {
  let since = null;
  let type = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--since') since = args[i + 1];
    if (args[i] === '--type') type = args[i + 1];
  }
  return { since, type };
}

function projectLabel(projects, e) {
  if (!e.possible_project_id) return `UNKNOWN`;
  const project = projects.find((p) => p.id === e.possible_project_id);
  return `${project ? project.name : e.possible_project_id} (${e.project_confidence})`;
}

// `guardian processes [--since <1h|30m|...>] [--type PROCESS_STARTED|PROCESS_STOPPED|ALREADY_RUNNING]`
// Shows the classified process events Guardian has observed — never raw command lines, never
// OTHER-classified noise (those are never persisted at all — see SPEC_V0.4.md section 6).
export async function processesCommand({ projectRoot, args }) {
  const { since: sinceArg, type } = parseArgs(args);
  const { store } = await createStore(path.join(projectRoot, 'data', 'guardian.db'));

  const sinceIso = parseSince(sinceArg);
  const events = await store.listProcessEvents({ sinceIso, type });
  const projects = await store.listProjects();
  await store.close();

  if (events.length === 0) {
    console.log(`No process events recorded${sinceArg ? ` in the last ${sinceArg}` : ''}. Run \`guardian observe\` to start observing.`);
    return events;
  }

  for (const e of events) {
    console.log(
      `${e.timestamp}  ${e.type.padEnd(16)} ${e.classification.padEnd(13)} pid=${e.pid} ppid=${e.parent_pid ?? 'n/a'}  ${e.process_name}${
        e.agent_type ? `  agent=${e.agent_type}` : ''
      }  project=${projectLabel(projects, e)}`,
    );
  }
  return events;
}
