import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { JsonFileStore } from '../src/store/JsonFileStore.js';
import { createFixtureRoot, cleanupFixtureRoot } from './helpers/fixtures.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUARDIAN_BIN = path.join(__dirname, '..', 'bin', 'guardian.js');

function runCli(args, sandbox) {
  return execFileSync('node', [GUARDIAN_BIN, ...args], { env: { ...process.env, GUARDIAN_HOME: sandbox }, encoding: 'utf8', timeout: 30000 });
}

function writeConfig(sandbox, scanRoots) {
  writeFileSync(
    path.join(sandbox, 'guardian.config.json'),
    JSON.stringify(
      {
        scanRoots,
        exclude: ['node_modules', '.git'],
        maxDepth: 8,
        maxDirectoriesVisited: 50000,
        confidenceThresholds: { high: 55, medium: 30, low: 10 },
        activityThresholds: { activeHours: 48, warmDays: 7, staleDays: 30 },
        watch: { debounceMs: 100, settleMs: 1500 },
        process: { captureCommandLine: 'sanitized-minimal', startupSettleMs: 300, correlationWindowMs: 4000 },
      },
      null,
      2,
    ),
  );
}

async function waitForOutput(getOutput, pattern, { timeout = 8000, interval = 50 } = {}) {
  const start = Date.now();
  for (;;) {
    if (pattern.test(getOutput())) return true;
    if (Date.now() - start > timeout) throw new Error(`waitForOutput timed out waiting for ${pattern}. Output so far:\n${getOutput()}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

test('CLI: guardian processes/sessions/process-status report cleanly with no data yet', () => {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'guardian-proc-cli-empty-'));
  try {
    // No `guardian scan` here on purpose: with scanRoots left empty, loadConfig's
    // autoDetectRoots would fall back to scanning this real machine's default roots, which is
    // slow and irrelevant — these three commands only read the store, which createStore()
    // initializes empty on first use regardless.
    writeConfig(sandbox, []);
    assert.match(runCli(['processes'], sandbox), /No process events recorded/);
    assert.match(runCli(['sessions'], sandbox), /No agent sessions recorded/);
    assert.match(runCli(['process-status'], sandbox), /No process observer session has ever run/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('CLI: guardian processes/sessions render seeded data without exposing secrets', async () => {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'guardian-proc-cli-seeded-'));
  try {
    writeConfig(sandbox, []); // see note above — no scan needed for these read-only commands

    const store = new JsonFileStore(path.join(sandbox, 'data', 'guardian.db.json'));
    await store.init();
    await store.addProcessEvent({
      event_id: 'evt-1',
      type: 'PROCESS_STARTED',
      timestamp: new Date().toISOString(),
      pid: 4242,
      parent_pid: 1,
      process_name: 'claude.exe',
      executable_path_sanitized: 'C:\\tools\\claude\\claude.exe',
      command_metadata: { argCount: 3, pathLikeArgs: [], redactedCount: 2 },
      classification: 'AI_AGENT',
      agent_type: 'CLAUDE_CODE',
      possible_project_id: null,
      project_confidence: 'UNKNOWN',
      session_id: 'sess-1',
      evidence: ['binary name matches known agent: claude.exe'],
    });
    await store.upsertAgentSession({
      session_id: 'sess-1',
      agent_identity: 'CLAUDE_CODE',
      pid: 4242,
      parent_pid: 1,
      started_at: new Date().toISOString(),
      detected_at: null,
      start_source: 'OBSERVED_START',
      ended_at: null,
      duration_ms: null,
      status: 'ACTIVE',
      possible_project_id: null,
      project_confidence: 'UNKNOWN',
      project_evidence: [],
      process_tree_summary: 'claude.exe',
      runtime_id: '4242:x',
      closure_note: null,
    });
    await store.close();

    const processesOut = runCli(['processes'], sandbox);
    assert.match(processesOut, /AI_AGENT/);
    assert.match(processesOut, /agent=CLAUDE_CODE/);
    assert.ok(!processesOut.includes('SECRET'));

    const sessionsOut = runCli(['sessions'], sandbox);
    assert.match(sessionsOut, /CLAUDE_CODE/);
    assert.match(sessionsOut, /Project: UNKNOWN/);
    assert.match(sessionsOut, /Confidence: UNKNOWN/);

    const activeOut = runCli(['sessions', '--active'], sandbox);
    assert.match(activeOut, /ACTIVE AGENT SESSIONS/);

    const agentFilterOut = runCli(['sessions', '--agent', 'claude'], sandbox);
    assert.match(agentFilterOut, /CLAUDE_CODE/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('CLI: guardian observe runs watcher + process observer together and shuts down cleanly on SIGINT', async () => {
  const fixtureRoot = createFixtureRoot();
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'guardian-observe-sandbox-'));
  try {
    writeConfig(sandbox, [fixtureRoot]);
    runCli(['scan'], sandbox);

    const child = spawn('node', [GUARDIAN_BIN, 'observe'], { env: { ...process.env, GUARDIAN_HOME: sandbox } });
    let output = '';
    child.stdout.on('data', (d) => {
      output += d.toString();
    });
    child.stderr.on('data', (d) => {
      output += d.toString();
    });
    const exitPromise = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));

    try {
      await waitForOutput(() => output, /PROJECT GUARDIAN LIVE/);
      await waitForOutput(() => output, /Processes: running/); // banner updated in V0.5A to cover all three observers

      writeFileSync(path.join(fixtureRoot, 'fixture-aum-git', 'README.md'), '# Aum Git Fixture\n\nStatus: In Progress\n\nEdited during observe CLI test.\n');
      await waitForOutput(() => output, /aum-git-fixture/, { timeout: 8000 });

      child.kill('SIGINT');
      let result;
      try {
        result = await Promise.race([exitPromise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))]);
      } catch {
        result = null;
      }

      // Same documented Node/Windows SIGINT-delivery limitation as test/watch-cli.test.js: only
      // assert the clean-shutdown transcript when the signal actually reached the handler.
      const gracefulShutdownDelivered = result && result.code === 0 && !result.signal;
      if (gracefulShutdownDelivered) {
        assert.match(output, /Guardian stopped cleanly/);
      } else if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exitPromise;
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }

    const statusOut = runCli(['process-status'], sandbox);
    assert.match(statusOut, /Status: (STOPPED|UNCLEAN_END|RUNNING)/);

    const watchStatusOut = runCli(['watch-status'], sandbox);
    assert.match(watchStatusOut, /Status: (STOPPED|UNCLEAN_END)/);
  } finally {
    cleanupFixtureRoot(fixtureRoot);
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
