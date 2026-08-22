import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { JsonFileStore } from '../src/store/JsonFileStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUARDIAN_BIN = path.join(__dirname, '..', 'bin', 'guardian.js');

// GUARDIAN_CLAUDE_HOME sandboxes every install/uninstall/status/doctor test below away from the
// real ~/.claude/settings.json on this machine — install/uninstall genuinely write files, and
// this suite must never touch the developer's actual global Claude Code config.
function runCli(args, sandbox, claudeHome) {
  return execFileSync('node', [GUARDIAN_BIN, ...args], {
    env: { ...process.env, GUARDIAN_HOME: sandbox, GUARDIAN_CLAUDE_HOME: claudeHome },
    encoding: 'utf8',
    timeout: 30000,
  });
}

function writeConfig(sandbox) {
  writeFileSync(
    path.join(sandbox, 'guardian.config.json'),
    JSON.stringify(
      {
        scanRoots: [],
        exclude: ['node_modules', '.git'],
        maxDepth: 8,
        maxDirectoriesVisited: 50000,
        confidenceThresholds: { high: 55, medium: 30, low: 10 },
        activityThresholds: { activeHours: 48, warmDays: 7, staleDays: 30 },
        watch: { debounceMs: 100, settleMs: 1500 },
        process: { captureCommandLine: 'sanitized-minimal', startupSettleMs: 300, correlationWindowMs: 4000 },
        shell: { pipeName: `\\\\.\\pipe\\guardian-shell-claudeclitest-${Date.now().toString(36)}` },
        wsl: { tcpPort: 47815, heartbeatIntervalMs: 60000, scanRoots: {} },
        claudeAgent: { tcpPort: 47816 },
      },
      null,
      2,
    ),
  );
}

function sandboxPair() {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'guardian-claude-cli-'));
  const claudeHome = mkdtempSync(path.join(os.tmpdir(), 'guardian-claude-cli-home-'));
  return {
    sandbox,
    claudeHome,
    cleanup: () => {
      rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      rmSync(claudeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

test('CLI: guardian agent status reports Claude Code not detected when the sandbox ~/.claude does not exist', () => {
  const { sandbox, claudeHome, cleanup } = sandboxPair();
  try {
    rmSync(claudeHome, { recursive: true, force: true }); // simulate "no ~/.claude at all"
    writeConfig(sandbox);
    const out = runCli(['agent', 'status'], sandbox, claudeHome);
    assert.match(out, /Claude Code detected: no/);
  } finally {
    cleanup();
  }
});

test('CLI: guardian agent install/status/doctor/uninstall round-trip against a sandboxed ~/.claude', () => {
  const { sandbox, claudeHome, cleanup } = sandboxPair();
  try {
    writeConfig(sandbox); // claudeHome dir itself already exists (mkdtempSync) — "detected"

    const installOut = runCli(['agent', 'install', 'claude'], sandbox, claudeHome);
    assert.match(installOut, /installed into/);
    assert.ok(existsSync(path.join(claudeHome, 'settings.json')));

    const statusOut = runCli(['agent', 'status'], sandbox, claudeHome);
    assert.match(statusOut, /Claude Code detected: yes/);
    assert.match(statusOut, /Guardian hooks installed: yes/);

    const doctorOut = runCli(['agent', 'doctor'], sandbox, claudeHome);
    assert.match(doctorOut, /SessionStart: guardian hook present=true/);
    assert.match(doctorOut, /No issues found/);

    const uninstallOut = runCli(['agent', 'uninstall', 'claude'], sandbox, claudeHome);
    assert.match(uninstallOut, /Guardian hooks removed/);

    const statusAfter = runCli(['agent', 'status'], sandbox, claudeHome);
    assert.match(statusAfter, /Guardian hooks installed: no/);
  } finally {
    cleanup();
  }
});

test('CLI: guardian agent install is idempotent when run twice from the CLI', () => {
  const { sandbox, claudeHome, cleanup } = sandboxPair();
  try {
    writeConfig(sandbox);
    runCli(['agent', 'install', 'claude'], sandbox, claudeHome);
    const second = runCli(['agent', 'install', 'claude'], sandbox, claudeHome);
    assert.match(second, /reinstalled \(updated\)/);
  } finally {
    cleanup();
  }
});

test('CLI: guardian agents / guardian agent sessions report no sessions cleanly on an empty store', () => {
  const { sandbox, claudeHome, cleanup } = sandboxPair();
  try {
    writeConfig(sandbox);
    const out = runCli(['agents'], sandbox, claudeHome);
    assert.match(out, /No agent sessions recorded/);
    const out2 = runCli(['agent', 'sessions'], sandbox, claudeHome);
    assert.match(out2, /No agent sessions recorded/);
  } finally {
    cleanup();
  }
});

test('CLI: guardian agents / agent show / agent explain reflect a seeded unified agent_session', async () => {
  const { sandbox, claudeHome, cleanup } = sandboxPair();
  try {
    writeConfig(sandbox);
    const store = new JsonFileStore(path.join(sandbox, 'data', 'guardian.db.json'));
    await store.init();
    await store.upsertProject({ id: 'pg', name: 'PROJECT-GUARDIAN', root_path: 'D:\\PROJECT-GUARDIAN', status: { activity_state: 'ACTIVE', completion_state: 'IN_PROGRESS' } });
    await store.upsertAgentSession({
      session_id: 'sess-1',
      agent_identity: 'CLAUDE_CODE',
      pid: 4242,
      parent_pid: 100,
      started_at: '2026-08-20T09:00:00.000Z',
      status: 'ACTIVE',
      possible_project_id: 'pg',
      project_confidence: 'AUTHORITATIVE',
      project_evidence: ['Claude native SessionStart cwd resolves under project root: PROJECT-GUARDIAN', 'parent process is a known shell session (source: shell hook)'],
      evidence_sources: ['CLAUDE_NATIVE', 'PROCESS', 'SHELL'],
      shell_session_id: 'shell-1',
      native_session_id: 'native-xyz',
      native_metadata: { start_source: 'startup', end_reason: null, hook_version: '1.0.0' },
    });
    await store.close();

    const agentsOut = runCli(['agents'], sandbox, claudeHome);
    assert.match(agentsOut, /CLAUDE_CODE/);
    assert.match(agentsOut, /Evidence sources: CLAUDE_NATIVE, PROCESS, SHELL/);
    assert.match(agentsOut, /Claude native session: native-xyz/);

    const showOut = runCli(['agent', 'show', 'sess-1'], sandbox, claudeHome);
    assert.match(showOut, /PROJECT-GUARDIAN/);
    assert.match(showOut, /AUTHORITATIVE/);

    const explainOut = runCli(['agent', 'explain', 'sess-1'], sandbox, claudeHome);
    assert.match(explainOut, /Project:\nPROJECT-GUARDIAN/);
    assert.match(explainOut, /Confidence:\nAUTHORITATIVE/);
    assert.match(explainOut, /1\. Claude native SessionStart/);
    assert.match(explainOut, /2\. parent process is a known shell session/);
    assert.match(explainOut, /No conversation content\./);

    // explain by native_session_id must resolve to the same record
    const explainByNative = runCli(['agent', 'explain', 'native-xyz'], sandbox, claudeHome);
    assert.match(explainByNative, /Confidence:\nAUTHORITATIVE/);
  } finally {
    cleanup();
  }
});
