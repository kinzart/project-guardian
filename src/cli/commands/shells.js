import path from 'node:path';
import { createStore } from '../../store/createStore.js';

function parseArgs(args) {
  let active = false;
  let type = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--active') active = true;
    if (args[i] === '--type') type = args[i + 1];
  }
  return { active, type };
}

// shell_type on a persisted session/event is the raw hook-reported value ("Desktop"/"Core" for
// PowerShell, "bash" for Git Bash, "WSL_BASH" for WSL) — this maps the CLI's friendlier
// --type powershell|gitbash|wsl onto that.
function matchesType(shellType, filter) {
  if (!filter) return true;
  const f = filter.toLowerCase();
  if (f === 'powershell' || f === 'pwsh') return shellType === 'Desktop' || shellType === 'Core';
  if (f === 'gitbash') return shellType === 'bash';
  if (f === 'wsl') return shellType === 'WSL_BASH';
  return false;
}

// `guardian shells [--active] [--type powershell|gitbash|wsl]` — shell sessions observed via the
// local IPC hooks (V0.5A/B/C).
export async function shellsCommand({ projectRoot, args }) {
  const { active, type } = parseArgs(args);
  const { store } = await createStore(path.join(projectRoot, 'data', 'guardian.db'));
  let sessions = await store.listShellSessions(active ? { active: true } : {});
  sessions = sessions.filter((s) => matchesType(s.shell_type, type));
  const projects = await store.listProjects();
  await store.close();

  if (sessions.length === 0) {
    console.log('No shell sessions recorded. Run `guardian observe` (with the hook installed) to start observing.');
    return sessions;
  }

  console.log(active ? 'ACTIVE SHELL SESSIONS' : 'SHELL SESSIONS');
  console.log('');
  for (const s of sessions) {
    const project = s.cwd ? projects.find((p) => s.cwd.toLowerCase().startsWith(p.root_path.toLowerCase())) : null;
    console.log(`${s.shell_type || 'PowerShell'} ${s.shell_version || ''}`.trim());
    if (s.host_name) console.log(s.shell_type === 'WSL_BASH' ? `Distro: ${s.host_name}` : `Host: ${s.host_name}`);
    console.log(`PID: ${s.pid}${s.parent_pid ? `  Parent PID: ${s.parent_pid}` : ''}`);
    console.log(`Started: ${s.started_at}`);
    if (s.status !== 'ACTIVE') console.log(`Ended: ${s.ended_at || 'unknown'}`);
    console.log(`Status: ${s.status}`);
    console.log(`Current project: ${project ? project.name : 'UNKNOWN'}`);
    console.log(`CWD transitions: ${s.cwd_timeline?.length ?? 0}`);
    console.log('');
  }
  return sessions;
}
