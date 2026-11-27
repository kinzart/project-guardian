import path from 'node:path';
import { loadConfig } from '../../config/loadConfig.js';
import { createStore } from '../../store/createStore.js';
import { Watcher } from '../../watch/watcher.js';
import { Observer } from '../../process/observer.js';
import { ShellObserver } from '../../shell/observer.js';
import { detectWsl } from '../../shell/wsl/discovery.js';
import { WslShellObserver } from '../../shell/wsl/observer.js';
import { detectClaudeCode } from '../../agent/claude/discovery.js';
import { ClaudeAgentObserver } from '../../agent/claude/observer.js';
import { detectCodex } from '../../agent/codex/discovery.js';
import { CodexAgentObserver } from '../../agent/codex/observer.js';
import { acquireInstanceLock } from '../../service/instanceLock.js';
import { pruneLogs, startMaintenanceScheduler } from '../../service/maintenance.js';
import { scanCommand } from './scan.js';
import { obsidianCommand } from './obsidian.js';
import { suggestNow } from './cerebro.js';

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour12: false });
}

function fmtDuration(ms) {
  if (ms == null) return 'unknown';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}m${(s % 60).toString().padStart(2, '0')}s`;
}

// `guardian observe` — runs the V0.3 filesystem watcher and the V0.4 process observer together
// in one foreground process, sharing one SIGINT/SIGTERM shutdown path. Either subsystem failing
// leaves the other running (see SPEC_V0.4.md section 12).
export async function observeCommand({ projectRoot, args }) {
  const instanceLock = acquireInstanceLock(path.join(projectRoot, 'data', 'guardian.lock'), { mode: args.includes('--service') ? 'service' : 'foreground' });
  process.once('exit', () => instanceLock.release());
  const projectIdx = args.indexOf('--project');
  const projectFilter = projectIdx !== -1 ? args[projectIdx + 1] : null;

  const configPath = path.join(projectRoot, 'guardian.config.json');
  const config = loadConfig(configPath, { autoDetectRoots: false });
  const { store } = await createStore(path.join(projectRoot, 'data', 'guardian.db'));

  let projects = await store.listProjects();
  if (projectFilter) {
    projects = projects.filter(
      (p) => p.root_path === projectFilter || p.name.toLowerCase() === projectFilter.toLowerCase() || p.name.toLowerCase().includes(projectFilter.toLowerCase()),
    );
    if (projects.length === 0) {
      console.error(`No project matching "${projectFilter}" found. Run \`guardian list\`.`);
      await store.close();
      process.exitCode = 1;
      return;
    }
  }
  if (projects.length === 0) {
    console.log('No projects in the inventory to observe. Run `guardian scan` first.');
    await store.close();
    return;
  }

  const guardianSelfPaths = [path.join(projectRoot, 'data'), path.join(projectRoot, 'reports'), path.join(projectRoot, 'logs')];
  const watcher = new Watcher({ store, config, reportsDir: path.join(projectRoot, 'reports'), guardianSelfPaths });
  const shellObserver = new ShellObserver({ store, pipeName: config.shell.pipeName, tcpPort: config.shell.tcpPort });
  const observer = new Observer({
    store,
    config,
    shellRegistry: shellObserver.registry,
    onShellProcessStopped: (pid, timestamp) => shellObserver.reconcileProcessStopped(pid, timestamp),
  });

  // WSL listener only binds when WSL is actually present on this machine (SPEC_V0.5C.md section
  // 4) — never started speculatively, since there is nothing to speak to it otherwise.
  const wslDetection = detectWsl();
  const wslShellObserver = wslDetection.installed
    ? new WslShellObserver({
        store,
        port: config.wsl.tcpPort,
        heartbeatIntervalMs: config.wsl.heartbeatIntervalMs,
        wslScanRoots: config.wsl.scanRoots,
        dataDir: path.join(projectRoot, 'data'),
      })
    : null;

  // Claude native-hook listener always binds (unlike WSL, this is loopback-only local IPC with no
  // dependency on anything being pre-installed elsewhere) — the hook script simply has nothing to
  // connect to until `guardian agent install claude` has been run at least once, and connecting
  // fails open regardless (see SPEC_V0.6A.md "Guardian offline").
  const claudeDetection = detectClaudeCode();
  const claudeAgentObserver = new ClaudeAgentObserver({
    store,
    port: config.claudeAgent.tcpPort,
    dataDir: path.join(projectRoot, 'data'),
    // Lets native-hook pid unification walk the SAME live ancestry V0.4 already builds — see
    // ClaudeAgentObserver's own constructor doc for why a bare pid match isn't enough (real E2E
    // finding: Claude Code runs hooks through an intermediate shell, not claude.exe directly).
    processTree: observer.tree,
  });

  // Same rationale as the Claude listener above — see SPEC_V0.6B.md "Fail open"/"Local transport".
  const codexDetection = detectCodex();
  const codexAgentObserver = new CodexAgentObserver({
    store,
    port: config.codexAgent.tcpPort,
    dataDir: path.join(projectRoot, 'data'),
    processTree: observer.tree,
  });

  console.log('PROJECT GUARDIAN LIVE');
  console.log('');
  console.log(`Watching projects: ${projects.length}`);
  console.log('Filesystem: starting');
  console.log('Processes: starting');
  console.log('Shell IPC: starting');
  console.log(`WSL: ${wslDetection.installed ? `detected (${wslDetection.distros.length} distro${wslDetection.distros.length === 1 ? '' : 's'}), starting` : 'not detected'}`);
  console.log(`Claude Code: ${claudeDetection.installed ? 'detected, starting native-hook listener' : 'not detected'}`);
  console.log(`Codex: ${codexDetection.installed ? 'detected, starting native-hook listener' : 'not detected'}`);
  console.log('');

  watcher.onEvent((evt) => {
    if (evt.type === 'refresh') {
      const changedWhat = evt.batch.paths.length === 1 ? path.basename(evt.batch.paths[0]) : `${evt.batch.paths.length} files changed`;
      console.log(`${fmtTime(evt.at)} ${evt.project.name} changed`);
      console.log(`         ${changedWhat}`);
      console.log(`         ${evt.intelligenceRecomputed ? 'intelligence refreshed' : 'activity refreshed'}`);
      observer.recheckActiveCorrelations().catch(() => {});
    } else if (evt.type === 'watch-error') {
      console.log(`${fmtTime(evt.at)} ${evt.project.name} watch error (${evt.status}): ${evt.error.message}`);
    } else if (evt.type === 'root-available') {
      console.log(`${fmtTime(evt.at)} ${evt.project.name} root available again`);
    } else if (evt.type === 'protected') {
      console.log(`${fmtTime(evt.at)} protected source changed (not read, not logged by name)`);
    } else if (evt.type === 'error') {
      console.log(`${fmtTime(evt.at)} watcher error: ${evt.error.message}`);
    }
  });

  const projectName = (id) => (id ? projects.find((p) => p.id === id)?.name || id : 'UNKNOWN');

  observer.onEvent((evt) => {
    if (evt.type === 'process-start' && evt.classification.classification === 'AI_AGENT') {
      console.log(`${fmtTime(evt.at)} ${evt.classification.agentType} started`);
      console.log(`         PID ${evt.record.pid}`);
      console.log(`         Project: ${projectName(evt.correlation.projectId)}`);
    } else if (evt.type === 'session-end') {
      console.log(`${fmtTime(evt.at)} ${evt.session.agent_identity} ended`);
      console.log(`         Duration: ${fmtDuration(evt.session.duration_ms)}`);
    } else if (evt.type === 'correlation-updated') {
      console.log(`${fmtTime(evt.at)} ${evt.session.agent_identity} correlation updated`);
      console.log(`         Project: ${projectName(evt.session.possible_project_id)}`);
      console.log(`         Confidence: ${evt.session.project_confidence}`);
    } else if (evt.type === 'error') {
      console.log(`${fmtTime(evt.at)} process observer error: ${evt.error.message}`);
    }
  });

  shellObserver.onEvent((evt) => {
    if (evt.type === 'shell-started') {
      const project = projects.find((p) => evt.session.cwd?.toLowerCase().startsWith(p.root_path.toLowerCase()));
      console.log(`${fmtTime(evt.at)} ${evt.session.shell_type || 'PowerShell'} started`);
      console.log(`         PID: ${evt.session.pid}`);
      console.log(`         CWD: ${project ? project.name : evt.session.cwd}`);
    } else if (evt.type === 'cwd-changed') {
      const previous = evt.session.cwd_timeline?.at(-2)?.cwd;
      console.log(`${fmtTime(evt.at)} ${evt.session.shell_type || 'PowerShell'} cwd changed`);
      console.log(`         ${previous ? path.basename(previous) : '?'} -> ${path.basename(evt.session.cwd)}`);
      observer.recheckActiveCorrelations().catch(() => {});
    } else if (evt.type === 'shell-exiting') {
      console.log(`${fmtTime(evt.at)} ${evt.session.shell_type || 'PowerShell'} exiting`);
      console.log(`         PID: ${evt.session.pid}`);
    } else if (evt.type === 'error') {
      console.log(`${fmtTime(evt.at)} shell IPC error: ${evt.error.message}`);
    }
  });

  claudeAgentObserver.onEvent((evt) => {
    if (evt.type === 'session-started' || evt.type === 'session-resumed') {
      console.log(`${fmtTime(evt.at)} CLAUDE ${evt.type === 'session-resumed' ? 'SESSION RESUMED' : 'SESSION START'}`);
      console.log(`         session ${evt.session.native_session_id}`);
      console.log(`         ${projectName(evt.session.possible_project_id)}`);
      console.log(`         ${evt.session.project_confidence}`);
    } else if (evt.type === 'cwd-changed') {
      console.log(`${fmtTime(evt.at)} CLAUDE CWD CHANGED`);
      console.log(`         ${projectName(evt.session.possible_project_id)}`);
      console.log(`         ${evt.session.project_confidence}`);
    } else if (evt.type === 'session-ended') {
      console.log(`${fmtTime(evt.at)} CLAUDE SESSION END`);
      console.log(`         duration ${fmtDuration(evt.session.duration_ms)}`);
    } else if (evt.type === 'turn-completed' || evt.type === 'turn-failed') {
      console.log(`${fmtTime(evt.at)} CLAUDE ${evt.type === 'turn-failed' ? 'TURN FAILED' : 'TURN COMPLETED'}`);
    } else if (evt.type === 'error') {
      console.log(`${fmtTime(evt.at)} Claude native-hook listener error: ${evt.error.message}`);
    }
  });

  codexAgentObserver.onEvent((evt) => {
    if (evt.type === 'session-started' || evt.type === 'session-resumed') {
      console.log(`${fmtTime(evt.at)} CODEX ${evt.type === 'session-resumed' ? 'SESSION RESUMED' : 'SESSION START'}`);
      console.log(`         session ${evt.session.native_session_id}`);
      console.log(`         model ${evt.session.native_metadata?.model || 'unknown'}`);
      console.log(`         ${projectName(evt.session.possible_project_id)}`);
      console.log(`         ${evt.session.project_confidence}`);
    } else if (evt.type === 'session-ended') {
      console.log(`${fmtTime(evt.at)} CODEX SESSION END`);
      console.log(`         reason ${evt.session.native_metadata?.end_reason || 'unknown'}`);
      console.log(`         duration ${fmtDuration(evt.session.duration_ms)}`);
    } else if (evt.type === 'turn-completed') {
      console.log(`${fmtTime(evt.at)} CODEX TURN COMPLETED`);
    } else if (evt.type === 'error') {
      console.log(`${fmtTime(evt.at)} Codex native-hook listener error: ${evt.error.message}`);
    }
  });

  if (wslShellObserver) {
    wslShellObserver.onEvent((evt) => {
      if (evt.type === 'shell-started') {
        console.log(`${fmtTime(evt.at)} WSL bash started (${evt.session.host_name})`);
        console.log(`         PID: ${evt.session.pid}`);
        console.log(`         CWD: ${evt.session.cwd || 'UNKNOWN (WSL-native path)'}`);
      } else if (evt.type === 'cwd-changed') {
        const previous = evt.session.cwd_timeline?.at(-2)?.cwd;
        console.log(`${fmtTime(evt.at)} WSL bash (${evt.session.host_name}) cwd changed`);
        console.log(`         ${previous ? path.basename(previous) : '?'} -> ${evt.session.cwd ? path.basename(evt.session.cwd) : 'UNKNOWN'}`);
        observer.recheckActiveCorrelations().catch(() => {});
      } else if (evt.type === 'shell-exiting') {
        console.log(`${fmtTime(evt.at)} WSL bash (${evt.session.host_name}) exiting`);
        console.log(`         PID: ${evt.session.pid}`);
      } else if (evt.type === 'session-stale') {
        console.log(`${fmtTime(evt.at)} WSL bash (${evt.session.host_name}) session stale`);
        console.log(`         PID: ${evt.session.pid}`);
      } else if (evt.type === 'error') {
        console.log(`${fmtTime(evt.at)} WSL shell IPC error: ${evt.error.message}`);
      }
    });
  }

  await watcher.start(projects);
  await observer.start(projects);
  await shellObserver.start(projects);
  if (wslShellObserver) await wslShellObserver.start(projects);
  await claudeAgentObserver.start(projects);
  await codexAgentObserver.start(projects);

  const maintenance = startMaintenanceScheduler({
    times: config.service.reconciliationTimes,
    run: async () => {
      await scanCommand({ projectRoot, store, config });
      if (config.obsidian.vaultPath) await obsidianCommand({ projectRoot, args: ['render'], store, config });
      pruneLogs(path.join(projectRoot, 'logs'), { retentionDays: config.service.logRetentionDays, maxTotalBytes: config.service.maxLogBytes });
    },
    onError: (error) => console.log(`${fmtTime(new Date().toISOString())} scheduled reconciliation error: ${error.message}`),
  });
  // Cérebro nightly: full scan + vault render + AI suggestions (only if a command is configured).
  const nightlyRun = config.cerebro?.nightlyTime ? startMaintenanceScheduler({
    times: [config.cerebro.nightlyTime],
    run: async () => {
      await scanCommand({ projectRoot, store, config });
      if (config.obsidian.vaultPath) {
        await obsidianCommand({ projectRoot, args: ['render'], store, config });
        await suggestNow({ projectRoot, store, config });
      }
    },
    onError: (error) => console.log(`${fmtTime(new Date().toISOString())} cerebro nightly error: ${error.message}`),
  }) : null;
  console.log('Filesystem: running');
  console.log('Processes: running');
  console.log(`Shell IPC: ${shellObserver.health().status.toLowerCase()}`);
  if (wslShellObserver) console.log(`WSL IPC: ${wslShellObserver.health().status.toLowerCase()}`);
  console.log(`Claude native-hook IPC: ${claudeAgentObserver.health().status.toLowerCase()}`);
  console.log(`Codex native-hook IPC: ${codexAgentObserver.health().status.toLowerCase()}`);
  console.log('');

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('');
    console.log('Ctrl+C');
    console.log('         stopping filesystem watcher');
    await watcher.stop('STOPPED');
    console.log('         stopping process observer');
    await observer.stop('STOPPED');
    console.log('         stopping shell IPC server');
    await shellObserver.stop('STOPPED');
    if (wslShellObserver) {
      console.log('         stopping WSL shell IPC server');
      await wslShellObserver.stop('STOPPED');
    }
    console.log('         stopping Claude native-hook IPC server');
    await claudeAgentObserver.stop('STOPPED');
    console.log('         stopping Codex native-hook IPC server');
    await codexAgentObserver.stop('STOPPED');
    maintenance.stop();
    nightlyRun?.stop();
    console.log('         closing database');
    await store.close();
    instanceLock.release();
    console.log('');
    console.log('Guardian stopped cleanly');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise(() => {}); // foreground: block until a signal handler calls process.exit
}
