import path from 'node:path';
import { createStore } from '../../store/createStore.js';
import { detectClaudeCode, globalSettingsPath } from '../../agent/claude/discovery.js';
import { probeClaudeTcp } from '../../agent/claude/ipc-server.js';
import {
  HOOK_PATH as CLAUDE_HOOK_PATH,
  readHookVersion as readClaudeHookVersion,
  install as installClaude,
  uninstall as uninstallClaude,
  doctor as claudeDoctor,
  readInstallState as readClaudeInstallState,
  writeInstallState as writeClaudeInstallState,
} from '../../agent/claude/manager.js';
import { detectCodex, globalHooksJsonPath } from '../../agent/codex/discovery.js';
import { probeCodexTcp } from '../../agent/codex/ipc-server.js';
import {
  HOOK_PATH as CODEX_HOOK_PATH,
  readHookVersion as readCodexHookVersion,
  install as installCodex,
  uninstall as uninstallCodex,
  doctor as codexDoctor,
  readInstallState as readCodexInstallState,
  writeInstallState as writeCodexInstallState,
} from '../../agent/codex/manager.js';
import { listAgentSessions, printAgentSessions } from './agents.js';

async function sessionsSubcommand({ projectRoot, args }) {
  const agentIdx = args.indexOf('--agent');
  const agentFilter = agentIdx !== -1 ? args[agentIdx + 1] : null;
  const active = args.includes('--active');
  const { sessions, projects } = await listAgentSessions({ projectRoot, active, agentFilter });
  printAgentSessions(sessions, projects, { active });
  return sessions;
}

async function findSession({ projectRoot, sessionQuery }) {
  const { store } = await createStore(path.join(projectRoot, 'data', 'guardian.db'));
  const sessions = await store.listAgentSessions({});
  const projects = await store.listProjects();
  await store.close();
  const session = sessions.find((s) => s.session_id === sessionQuery || s.native_session_id === sessionQuery);
  return { session, projects };
}

// `guardian agent show <session>` — full record dump, structural fields only (no conversation
// content is ever stored on an agent_session in the first place — see SPEC_V0.6A.md/V0.6B.md).
async function showSubcommand({ projectRoot, sessionQuery }) {
  if (!sessionQuery) {
    console.error('Usage: guardian agent show <session-id>');
    process.exitCode = 1;
    return null;
  }
  const { session, projects } = await findSession({ projectRoot, sessionQuery });
  if (!session) {
    console.error(`No agent session matching "${sessionQuery}" found. Run \`guardian agents\`.`);
    process.exitCode = 1;
    return null;
  }
  const project = session.possible_project_id ? projects.find((p) => p.id === session.possible_project_id) : null;

  console.log(`AGENT SESSION: ${session.session_id}`);
  console.log('');
  console.log(`Agent: ${session.agent_identity}`);
  console.log(`PID: ${session.pid ?? 'unknown'}   Parent PID: ${session.parent_pid ?? 'unknown'}`);
  console.log(`Status: ${session.status}`);
  console.log(`Started: ${session.started_at || `unknown (${session.start_source})`}`);
  if (session.status === 'ENDED') console.log(`Ended: ${session.ended_at}`);
  console.log(`Project: ${project ? project.name : 'UNKNOWN'}   Confidence: ${session.project_confidence}`);
  console.log(`Evidence sources: ${(session.evidence_sources || ['PROCESS']).join(', ')}`);
  console.log(`Native session: ${session.native_session_id || 'n/a'}`);
  console.log(`Shell session: ${session.shell_session_id || 'n/a'}`);
  if (session.native_metadata) console.log(`Native metadata: ${JSON.stringify(session.native_metadata)}`);
  if (session.closure_note) console.log(`Note: ${session.closure_note}`);
  return session;
}

// `guardian agent explain <session>` — see SPEC_V0.6A.md/V0.6B.md "Explain": every piece of
// correlation evidence Guardian has for this session's project, numbered, no conversation content.
async function explainSubcommand({ projectRoot, sessionQuery }) {
  if (!sessionQuery) {
    console.error('Usage: guardian agent explain <session-id>');
    process.exitCode = 1;
    return null;
  }
  const { session, projects } = await findSession({ projectRoot, sessionQuery });
  if (!session) {
    console.error(`No agent session matching "${sessionQuery}" found. Run \`guardian agents\`.`);
    process.exitCode = 1;
    return null;
  }
  const project = session.possible_project_id ? projects.find((p) => p.id === session.possible_project_id) : null;

  console.log('Agent:');
  console.log(session.agent_identity);
  console.log('');
  console.log('Project:');
  console.log(project ? project.name : 'UNKNOWN');
  console.log('');
  console.log('Confidence:');
  console.log(session.project_confidence);
  console.log('');
  console.log('Evidence:');
  console.log('');
  const evidence = session.project_evidence || [];
  if (!evidence.length) {
    console.log('  none — no correlation evidence has been recorded for this session yet');
  } else {
    evidence.forEach((e, i) => console.log(`${i + 1}. ${e}`));
  }
  console.log('');
  if (session.native_metadata) console.log(`Native metadata: ${JSON.stringify(session.native_metadata)}`);
  console.log('');
  console.log('No conversation content.');
  return session;
}

async function claudeStatusSubcommand({ projectRoot }) {
  const detection = detectClaudeCode();
  const dataDir = path.join(projectRoot, 'data');
  const state = readClaudeInstallState(dataDir);
  const hookVersion = readClaudeHookVersion();
  const portOpen = await probeClaudeTcp();

  console.log(`Claude Code detected: ${detection.installed ? 'yes' : 'no'}${detection.installed ? ` (${detection.homeDir})` : ''}`);
  console.log(`Global settings: ${globalSettingsPath()}`);
  const checks = claudeDoctor({ settingsPath: globalSettingsPath() });
  const installedEverywhere = Object.values(checks.guardianHooksPresent || {}).length > 0 && Object.values(checks.guardianHooksPresent).every(Boolean);
  console.log(`Guardian hooks installed: ${installedEverywhere ? 'yes' : 'no'}`);
  console.log(`Hook version: ${installedEverywhere ? hookVersion : 'n/a'}`);
  if (state.installedAt) console.log(`Last install: ${state.installedAt}`);
  console.log(`Native-hook IPC: ${portOpen ? 'running' : 'stopped'}`);

  const { store } = await createStore(path.join(projectRoot, 'data', 'guardian.db'));
  const events = await store.listNativeAgentEvents({});
  await store.close();
  const claudeEvents = events.filter((e) => e.agent === 'CLAUDE_CODE');
  const last = claudeEvents[claudeEvents.length - 1];
  console.log(`Last native event: ${last ? `${last.timestamp} ${last.type}` : 'none'}`);
}

async function claudeDoctorSubcommand({ projectRoot }) {
  const detection = detectClaudeCode();
  let issues = 0;
  console.log(`Claude Code detected: ${detection.installed ? 'yes' : 'no'}`);
  if (!detection.installed) {
    console.log('  not detected — skipped');
    return;
  }
  if (!detection.settings.parseable) {
    console.log('  global settings.json: NOT PARSEABLE — refusing to touch it. Fix the JSON manually, then re-run doctor.');
    issues += 1;
  }
  const checks = claudeDoctor({ settingsPath: globalSettingsPath() });
  console.log(`  settings found: ${checks.settingsFound}`);
  console.log(`  parseable: ${checks.parseable}`);
  for (const event of Object.keys(checks.guardianHooksPresent || {})) {
    console.log(`  ${event}: guardian hook present=${checks.guardianHooksPresent[event]} duplicate=${checks.duplicateEntries[event]} other-tool entries=${checks.otherToolEntries[event]}`);
    if (checks.duplicateEntries[event]) issues += 1;
  }
  const portOpen = await probeClaudeTcp();
  console.log(`  native-hook IPC connectivity: ${portOpen ? 'ok' : 'no server listening (Guardian not running, or not yet started)'}`);
  console.log('');
  console.log(issues === 0 ? 'No issues found. Nothing was changed (run `guardian agent install claude` explicitly to fix).' : `${issues} issue(s) found. Nothing was auto-fixed — review above.`);
  if (issues > 0) process.exitCode = 1;
}

// install/uninstall touch the GLOBAL ~/.claude/settings.json — a shared, cross-project,
// cross-session file. Both are explicit, user-invoked actions only; `guardian observe` never
// calls these itself (see SPEC_V0.6A.md "Installation").
async function claudeInstallSubcommand({ projectRoot }) {
  const detection = detectClaudeCode();
  if (!detection.installed) {
    console.log('Claude Code: not detected — skipped');
    return;
  }
  const dataDir = path.join(projectRoot, 'data');
  const backupDir = path.join(dataDir, 'agent-backups');
  const state = readClaudeInstallState(dataDir);

  const result = installClaude({ settingsPath: globalSettingsPath(), backupDir, hookPath: CLAUDE_HOOK_PATH });
  state.claude = { installedAt: new Date().toISOString(), settingsPath: globalSettingsPath(), guardianHooksHash: result.guardianHooksHash, backupPath: result.backupPath };
  writeClaudeInstallState(dataDir, state);

  console.log(`Claude Code: ${result.alreadyInstalled ? 'reinstalled (updated)' : 'installed'} into ${globalSettingsPath()}`);
  console.log(`  backup: ${result.backupPath}`);
  console.log('');
  console.log('Existing hooks from other tools were left untouched. New Claude Code sessions will load the Guardian hooks; already-running sessions are not modified.');
}

async function claudeUninstallSubcommand({ projectRoot }) {
  const detection = detectClaudeCode();
  if (!detection.installed) {
    console.log('Claude Code: not detected — skipped');
    return;
  }
  const dataDir = path.join(projectRoot, 'data');
  const backupDir = path.join(dataDir, 'agent-backups');
  const state = readClaudeInstallState(dataDir);

  const result = uninstallClaude({ settingsPath: globalSettingsPath(), backupDir, hookPath: CLAUDE_HOOK_PATH });
  if (result.removed) {
    delete state.claude;
    writeClaudeInstallState(dataDir, state);
    console.log(`Claude Code: Guardian hooks removed from ${globalSettingsPath()}`);
    console.log(`  backup: ${result.backupPath}`);
  } else {
    console.log(`Claude Code: ${result.reason}`);
  }
}

// --- Codex ---------------------------------------------------------------------------------
// install/uninstall touch the GLOBAL ~/.codex/hooks.json — see SPEC_V0.6B.md "Installation
// location". Codex additionally requires interactive `/hooks` review before a newly-installed
// command hook will actually run (see "Codex trust model" — status/doctor surface this as
// trusted: yes/unknown, never spoofed, never bypassed).

async function codexStatusSubcommand({ projectRoot }) {
  const detection = detectCodex();
  const dataDir = path.join(projectRoot, 'data');
  const state = readCodexInstallState(dataDir);
  const hookVersion = readCodexHookVersion();
  const portOpen = await probeCodexTcp();

  console.log(`Codex detected: ${detection.installed ? 'yes' : 'no'}${detection.installed ? ` (${detection.homeDir})` : ''}`);
  console.log(`Global hooks.json: ${globalHooksJsonPath()}`);
  const checks = codexDoctor({ hooksJsonPath: globalHooksJsonPath() });
  const installedEverywhere = Object.values(checks.guardianHooksPresent || {}).length > 0 && Object.values(checks.guardianHooksPresent).every(Boolean);
  console.log(`Guardian hooks installed: ${installedEverywhere ? 'yes' : 'no'}`);
  console.log(`Hook version: ${installedEverywhere ? hookVersion : 'n/a'}`);
  if (installedEverywhere) {
    for (const [event, trust] of Object.entries(checks.trustStatus || {})) {
      console.log(`  ${event} trusted: ${trust}`);
    }
    if (Object.values(checks.trustStatus || {}).some((t) => t !== 'trusted')) {
      console.log('  Codex requires reviewing new/changed command hooks before it will run them.');
      console.log('  Run an interactive `codex` session and use the /hooks command to review and trust the Guardian hooks.');
    }
  }
  if (state.installedAt) console.log(`Last install: ${state.installedAt}`);
  console.log(`Native-hook IPC: ${portOpen ? 'running' : 'stopped'}`);

  const { store } = await createStore(path.join(projectRoot, 'data', 'guardian.db'));
  const events = await store.listNativeAgentEvents({});
  await store.close();
  const codexEvents = events.filter((e) => e.agent === 'CODEX');
  const last = codexEvents[codexEvents.length - 1];
  console.log(`Last native event: ${last ? `${last.timestamp} ${last.type}` : 'none'}`);
}

async function codexDoctorSubcommand({ projectRoot }) {
  const detection = detectCodex();
  let issues = 0;
  console.log(`Codex detected: ${detection.installed ? 'yes' : 'no'}`);
  if (!detection.installed) {
    console.log('  not detected — skipped');
    return;
  }
  if (detection.configTomlHasHookDefinitions) {
    console.log('  NOTE: config.toml already defines its own [hooks.*] table — Guardian only ever writes hooks.json, never config.toml, so both are preserved independently (Codex merges both layers).');
  }
  const checks = codexDoctor({ hooksJsonPath: globalHooksJsonPath() });
  console.log(`  hooks.json found: ${checks.hooksJsonFound}`);
  console.log(`  parseable: ${checks.parseable}`);
  for (const event of Object.keys(checks.guardianHooksPresent || {})) {
    console.log(`  ${event}: guardian hook present=${checks.guardianHooksPresent[event]} duplicate=${checks.duplicateEntries[event]} other-tool entries=${checks.otherToolEntries[event]} trusted=${checks.trustStatus?.[event] ?? 'unknown'}`);
    if (checks.duplicateEntries[event]) issues += 1;
  }
  const portOpen = await probeCodexTcp();
  console.log(`  native-hook IPC connectivity: ${portOpen ? 'ok' : 'no server listening (Guardian not running, or not yet started)'}`);
  console.log('');
  console.log(issues === 0 ? 'No issues found. Nothing was changed (run `guardian agent install codex` explicitly to fix).' : `${issues} issue(s) found. Nothing was auto-fixed — review above.`);
  if (issues > 0) process.exitCode = 1;
}

async function codexInstallSubcommand({ projectRoot }) {
  const detection = detectCodex();
  if (!detection.installed) {
    console.log('Codex: not detected — skipped');
    return;
  }
  const dataDir = path.join(projectRoot, 'data');
  const backupDir = path.join(dataDir, 'agent-backups');
  const state = readCodexInstallState(dataDir);

  const result = installCodex({ hooksJsonPath: globalHooksJsonPath(), backupDir, hookPath: CODEX_HOOK_PATH });
  state.codex = { installedAt: new Date().toISOString(), hooksJsonPath: globalHooksJsonPath(), guardianHooksHash: result.guardianHooksHash, backupPath: result.backupPath };
  writeCodexInstallState(dataDir, state);

  console.log(`Codex: ${result.alreadyInstalled ? 'reinstalled (updated)' : 'installed'} into ${globalHooksJsonPath()}`);
  console.log(`  backup: ${result.backupPath}`);
  console.log('');
  console.log('Existing hooks from other tools were left untouched. Codex requires reviewing new/changed command hooks before it will run them —');
  console.log('run an interactive `codex` session and use the /hooks command to review and trust the Guardian hooks before they take effect.');
}

async function codexUninstallSubcommand({ projectRoot }) {
  const detection = detectCodex();
  if (!detection.installed) {
    console.log('Codex: not detected — skipped');
    return;
  }
  const dataDir = path.join(projectRoot, 'data');
  const backupDir = path.join(dataDir, 'agent-backups');
  const state = readCodexInstallState(dataDir);

  const result = uninstallCodex({ hooksJsonPath: globalHooksJsonPath(), backupDir, hookPath: CODEX_HOOK_PATH });
  if (result.removed) {
    delete state.codex;
    writeCodexInstallState(dataDir, state);
    console.log(`Codex: Guardian hooks removed from ${globalHooksJsonPath()}`);
    console.log(`  backup: ${result.backupPath}`);
  } else {
    console.log(`Codex: ${result.reason}`);
  }
}

// `guardian agent <sessions|show|explain|status|doctor|install|uninstall> [claude|codex] [args]`
// No target on status/doctor/install/uninstall defaults to `claude` — preserves V0.6A's existing
// CLI surface unchanged.
export async function agentCommand({ projectRoot, args }) {
  const [sub, target, ...rest] = args;
  const isCodex = target === 'codex';
  switch (sub) {
    case 'sessions':
      return sessionsSubcommand({ projectRoot, args: target ? [target, ...rest] : rest });
    case 'show':
      return showSubcommand({ projectRoot, sessionQuery: target });
    case 'explain':
      return explainSubcommand({ projectRoot, sessionQuery: target });
    case 'status':
      return isCodex ? codexStatusSubcommand({ projectRoot }) : claudeStatusSubcommand({ projectRoot });
    case 'doctor':
      return isCodex ? codexDoctorSubcommand({ projectRoot }) : claudeDoctorSubcommand({ projectRoot });
    case 'install':
      return isCodex ? codexInstallSubcommand({ projectRoot }) : claudeInstallSubcommand({ projectRoot });
    case 'uninstall':
      return isCodex ? codexUninstallSubcommand({ projectRoot }) : claudeUninstallSubcommand({ projectRoot });
    default:
      console.error('Usage: guardian agent <sessions|show|explain|status|doctor|install|uninstall> [claude|codex] [args]');
      process.exitCode = 1;
      return null;
  }
}
