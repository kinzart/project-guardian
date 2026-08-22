import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { JsonFileStore } from '../src/store/JsonFileStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUARDIAN_BIN = path.join(__dirname, '..', 'bin', 'guardian.js');

// GUARDIAN_CODEX_HOME sandboxes every install/uninstall/status/doctor test below away from the
// real ~/.codex/hooks.json on this machine.
function runCli(args, sandbox, codexHome, claudeHome) {
  return execFileSync('node', [GUARDIAN_BIN, ...args], {
    env: { ...process.env, GUARDIAN_HOME: sandbox, GUARDIAN_CODEX_HOME: codexHome, GUARDIAN_CLAUDE_HOME: claudeHome },
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
        shell: { pipeName: `\\\\.\\pipe\\guardian-shell-codexclitest-${Date.now().toString(36)}` },
        wsl: { tcpPort: 47815, heartbeatIntervalMs: 60000, scanRoots: {} },
        claudeAgent: { tcpPort: 47816 },
        codexAgent: { tcpPort: 47817 },
      },
      null,
      2,
    ),
  );
}

function sandboxSet() {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'guardian-codex-cli-'));
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'guardian-codex-cli-home-'));
  const claudeHome = mkdtempSync(path.join(os.tmpdir(), 'guardian-codex-cli-claudehome-'));
  return {
    sandbox,
    codexHome,
    claudeHome,
    cleanup: () => {
      for (const d of [sandbox, codexHome, claudeHome]) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

test('CLI: guardian agent status codex reports not detected when the sandbox CODEX_HOME does not exist', () => {
  const { sandbox, codexHome, claudeHome, cleanup } = sandboxSet();
  try {
    rmSync(codexHome, { recursive: true, force: true }); // simulate "no CODEX_HOME at all"
    writeConfig(sandbox);
    const out = runCli(['agent', 'status', 'codex'], sandbox, codexHome, claudeHome);
    assert.match(out, /Codex detected: no/);
  } finally {
    cleanup();
  }
});

test('CLI: guardian agent install/status/doctor/uninstall codex round-trip against a sandboxed CODEX_HOME', () => {
  const { sandbox, codexHome, claudeHome, cleanup } = sandboxSet();
  try {
    writeConfig(sandbox);

    const installOut = runCli(['agent', 'install', 'codex'], sandbox, codexHome, claudeHome);
    assert.match(installOut, /installed into/);
    assert.match(installOut, /\/hooks/); // tells the user about the trust-review step, never bypasses it
    assert.ok(existsSync(path.join(codexHome, 'hooks.json')));

    const statusOut = runCli(['agent', 'status', 'codex'], sandbox, codexHome, claudeHome);
    assert.match(statusOut, /Codex detected: yes/);
    assert.match(statusOut, /Guardian hooks installed: yes/);
    assert.match(statusOut, /SessionStart trusted: unknown/); // honest — no config.toml trust entry in this sandbox

    const doctorOut = runCli(['agent', 'doctor', 'codex'], sandbox, codexHome, claudeHome);
    assert.match(doctorOut, /SessionStart: guardian hook present=true/);
    assert.match(doctorOut, /trusted=unknown/);
    assert.match(doctorOut, /No issues found/);

    const uninstallOut = runCli(['agent', 'uninstall', 'codex'], sandbox, codexHome, claudeHome);
    assert.match(uninstallOut, /Guardian hooks removed/);

    const statusAfter = runCli(['agent', 'status', 'codex'], sandbox, codexHome, claudeHome);
    assert.match(statusAfter, /Guardian hooks installed: no/);
  } finally {
    cleanup();
  }
});

test('CLI: guardian agent install codex is idempotent when run twice from the CLI', () => {
  const { sandbox, codexHome, claudeHome, cleanup } = sandboxSet();
  try {
    writeConfig(sandbox);
    runCli(['agent', 'install', 'codex'], sandbox, codexHome, claudeHome);
    const second = runCli(['agent', 'install', 'codex'], sandbox, codexHome, claudeHome);
    assert.match(second, /reinstalled \(updated\)/);
  } finally {
    cleanup();
  }
});

test('CLI: guardian agent install codex preserves an existing hooks.json and a competing config.toml [hooks.*] table, warning instead of duplicating', () => {
  const { sandbox, codexHome, claudeHome, cleanup } = sandboxSet();
  try {
    writeConfig(sandbox);
    writeFileSync(path.join(codexHome, 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node "/other/tool.mjs"' }] }] } }));
    writeFileSync(path.join(codexHome, 'config.toml'), '[hooks.SessionStart]\ncommand = "some-other-thing"\n');

    runCli(['agent', 'install', 'codex'], sandbox, codexHome, claudeHome);
    const hooksJson = JSON.parse(readFileSync(path.join(codexHome, 'hooks.json'), 'utf8'));
    assert.equal(hooksJson.hooks.SessionStart.length, 2);
    assert.ok(hooksJson.hooks.SessionStart.some((e) => e.hooks[0].command.includes('/other/tool.mjs')));

    const doctorOut = runCli(['agent', 'doctor', 'codex'], sandbox, codexHome, claudeHome);
    assert.match(doctorOut, /config.toml already defines its own \[hooks\.\*\] table/);
  } finally {
    cleanup();
  }
});

test('CLI: guardian agents / guardian agent sessions --agent codex filter correctly against a seeded unified session', async () => {
  const { sandbox, codexHome, claudeHome, cleanup } = sandboxSet();
  try {
    writeConfig(sandbox);
    const store = new JsonFileStore(path.join(sandbox, 'data', 'guardian.db.json'));
    await store.init();
    await store.upsertProject({ id: 'pg', name: 'PROJECT-GUARDIAN', root_path: 'D:\\PROJECT-GUARDIAN', status: { activity_state: 'ACTIVE', completion_state: 'IN_PROGRESS' } });
    await store.upsertAgentSession({
      session_id: 'codex-sess-1',
      agent_identity: 'CODEX',
      pid: 4242,
      parent_pid: 100,
      started_at: '2026-08-20T09:00:00.000Z',
      status: 'ACTIVE',
      possible_project_id: 'pg',
      project_confidence: 'AUTHORITATIVE',
      project_evidence: ['Codex native SessionStart cwd resolves under project root: PROJECT-GUARDIAN'],
      evidence_sources: ['CODEX_NATIVE', 'PROCESS'],
      shell_session_id: null,
      native_session_id: 'native-codex-xyz',
      native_metadata: { start_source: 'startup', end_reason: null, model: 'gpt-5-codex', hook_version: '1.0.0' },
    });
    await store.upsertAgentSession({
      session_id: 'claude-sess-1',
      agent_identity: 'CLAUDE_CODE',
      pid: 5555,
      parent_pid: 100,
      started_at: '2026-08-20T09:00:00.000Z',
      status: 'ACTIVE',
      possible_project_id: 'pg',
      project_confidence: 'AUTHORITATIVE',
      project_evidence: [],
      evidence_sources: ['CLAUDE_NATIVE'],
      shell_session_id: null,
      native_session_id: 'native-claude-abc',
      native_metadata: null,
    });
    await store.close();

    const codexOnly = runCli(['agent', 'sessions', '--agent', 'codex'], sandbox, codexHome, claudeHome);
    assert.match(codexOnly, /CODEX/);
    assert.ok(!codexOnly.includes('CLAUDE_CODE'));

    const explainOut = runCli(['agent', 'explain', 'codex-sess-1'], sandbox, codexHome, claudeHome);
    assert.match(explainOut, /Agent:\nCODEX/);
    assert.match(explainOut, /Confidence:\nAUTHORITATIVE/);
    assert.match(explainOut, /model.*gpt-5-codex/);
    assert.match(explainOut, /No conversation content\./);
  } finally {
    cleanup();
  }
});

test('CLI regression: guardian agent status claude still works unaffected by the Codex integration', () => {
  const { sandbox, codexHome, claudeHome, cleanup } = sandboxSet();
  try {
    rmSync(claudeHome, { recursive: true, force: true }); // simulate "no ~/.claude at all"
    writeConfig(sandbox);
    const out = runCli(['agent', 'status'], sandbox, codexHome, claudeHome); // default target = claude
    assert.match(out, /Claude Code detected: no/);
  } finally {
    cleanup();
  }
});
