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
  let projectFilter = null;
  let verbose = false;
  let type = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--since') since = args[i + 1];
    if (args[i] === '--project') projectFilter = args[i + 1];
    if (args[i] === '--verbose') verbose = true;
    if (args[i] === '--type') type = args[i + 1];
  }
  return { since, projectFilter, verbose, type };
}

// See shells.js's matchesType — same mapping, kept in sync deliberately (small enough that a
// shared import isn't worth the indirection).
function matchesType(shellType, filter) {
  if (!filter) return true;
  const f = filter.toLowerCase();
  if (f === 'powershell' || f === 'pwsh') return shellType === 'Desktop' || shellType === 'Core';
  if (f === 'gitbash') return shellType === 'bash';
  if (f === 'wsl') return shellType === 'WSL_BASH';
  return false;
}

// `guardian shell-events [--since <1h|30m|...>] [--project <name>] [--verbose]` — structural
// shell IPC events only (SHELL_STARTED/CWD_CHANGED/SHELL_EXITING). Never a command, never
// stdout/stderr. Paths are shown as project names by default — see SPEC_V0.5A.md "Privacidade
// de path"; --verbose reveals the local CWD path.
export async function shellEventsCommand({ projectRoot, args }) {
  const { since: sinceArg, projectFilter, verbose, type } = parseArgs(args);
  const { store } = await createStore(path.join(projectRoot, 'data', 'guardian.db'));

  const projects = await store.listProjects();
  let projectId;
  if (projectFilter) {
    const project = projects.find(
      (p) => p.root_path === projectFilter || p.name.toLowerCase() === projectFilter.toLowerCase() || p.name.toLowerCase().includes(projectFilter.toLowerCase()),
    );
    if (!project) {
      console.error(`No project matching "${projectFilter}" found.`);
      await store.close();
      process.exitCode = 1;
      return null;
    }
    projectId = project.id;
  }

  const sinceIso = parseSince(sinceArg);
  let events = await store.listShellEvents({ sinceIso, projectId });
  events = events.filter((e) => matchesType(e.shell_type, type));
  await store.close();

  if (events.length === 0) {
    console.log(`No shell events recorded${projectFilter ? ` for "${projectFilter}"` : ''}${sinceArg ? ` in the last ${sinceArg}` : ''}.`);
    return events;
  }

  for (const e of events) {
    const project = e.project_id ? projects.find((p) => p.id === e.project_id) : null;
    const projectLabel = project ? project.name : 'UNKNOWN';
    const cwdPart = e.cwd ? (verbose ? `  cwd=${e.cwd}` : `  project=${projectLabel}`) : '';
    console.log(`${e.timestamp}  ${e.type.padEnd(16)} shell=${e.shell_session_id.slice(0, 8)}  pid=${e.pid}${cwdPart}`);
  }
  return events;
}
