import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createFixtureRoot, cleanupFixtureRoot } from './helpers/fixtures.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUARDIAN_BIN = path.join(__dirname, '..', 'bin', 'guardian.js');

function runCli(args, sandbox) {
  return execFileSync('node', [GUARDIAN_BIN, ...args], {
    env: { ...process.env, GUARDIAN_HOME: sandbox },
    encoding: 'utf8',
    timeout: 30000,
  });
}

test('CLI: scan, list, show, status, doctor all work end to end in a sandbox', () => {
  const fixtureRoot = createFixtureRoot();
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'guardian-sandbox-'));
  try {
    writeFileSync(
      path.join(sandbox, 'guardian.config.json'),
      JSON.stringify(
        {
          scanRoots: [fixtureRoot],
          exclude: ['node_modules', '.git'],
          maxDepth: 8,
          maxDirectoriesVisited: 50000,
          confidenceThresholds: { high: 55, medium: 30, low: 10 },
          activityThresholds: { activeHours: 48, warmDays: 7, staleDays: 30 },
        },
        null,
        2,
      ),
    );

    const scanOut = runCli(['scan'], sandbox);
    assert.match(scanOut, /Candidates detected: \d+/);

    assert.ok(existsSync(path.join(sandbox, 'reports', 'PROJECT_INVENTORY.md')), 'G9: inventory report created');
    assert.ok(existsSync(path.join(sandbox, 'reports', 'projects.json')));

    const inventory = readFileSync(path.join(sandbox, 'reports', 'PROJECT_INVENTORY.md'), 'utf8');
    assert.match(inventory, /# Project Guardian — Inventory/);
    assert.match(inventory, /## ACTIVE/);
    assert.match(inventory, /## WARM/);
    assert.match(inventory, /## STALE/);
    assert.match(inventory, /## DORMANT/);

    assert.ok(existsSync(path.join(sandbox, 'reports', 'PROJECT_STATUS.md')), 'V0.2 G13: PROJECT_STATUS.md created');
    const statusReport = readFileSync(path.join(sandbox, 'reports', 'PROJECT_STATUS.md'), 'utf8');
    assert.match(statusReport, /# Project Guardian — Status/);

    const listOut = runCli(['list'], sandbox);
    assert.match(listOut, /aum-git-fixture|node-no-aum-fixture/);

    const showOut = runCli(['show', 'aum-git-fixture'], sandbox);
    const shown = JSON.parse(showOut);
    assert.equal(shown.project.name, 'aum-git-fixture');
    assert.ok(shown.sources.length > 0);
    assert.ok(shown.intelligence, 'V0.2 G3: show includes the project_intelligence snapshot');
    assert.equal(shown.intelligence.completion_state, 'IN_PROGRESS');

    const contextOut = runCli(['context', 'aum-git-fixture'], sandbox);
    assert.match(contextOut, /PROJECT: aum-git-fixture/);
    assert.match(contextOut, /Current focus:/);

    const explainOut = runCli(['explain', 'aum-git-fixture'], sandbox);
    assert.match(explainOut, /EXPLAIN: aum-git-fixture/);
    assert.match(explainOut, /current_focus:/);
    assert.match(explainOut, /conflicts:/);

    const statusOut = runCli(['status'], sandbox);
    assert.match(statusOut, /Inventory projects: \d+/);
    assert.match(statusOut, /Projects with intelligence: \d+/);
    assert.match(statusOut, /Last scan: \d{4}/);

    const doctorOut = runCli(['doctor'], sandbox);
    assert.match(doctorOut, /Project Guardian doctor/);
    assert.match(doctorOut, /\[OK\] Node version/);

    // second scan proves incrementality end to end via the CLI too
    const secondScanOut = runCli(['scan'], sandbox);
    const unchangedMatch = secondScanOut.match(/unchanged: (\d+)/);
    const foundMatch = secondScanOut.match(/Candidates detected: (\d+)/);
    assert.ok(unchangedMatch && foundMatch);
    assert.equal(unchangedMatch[1], foundMatch[1]);

    // V0.2: the second scan's intelligence pass must be fully reused too (nothing changed).
    const reusedMatch = secondScanOut.match(/reused: (\d+)/);
    const recomputedMatch = secondScanOut.match(/recomputed: (\d+)/);
    assert.ok(reusedMatch && recomputedMatch);
    assert.equal(recomputedMatch[1], '0', 'second scan should recompute no intelligence when nothing changed on disk');
  } finally {
    cleanupFixtureRoot(fixtureRoot);
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('CLI: unknown command exits non-zero', () => {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'guardian-sandbox-'));
  try {
    assert.throws(() => {
      execFileSync('node', [GUARDIAN_BIN, 'not-a-real-command'], { env: { ...process.env, GUARDIAN_HOME: sandbox }, encoding: 'utf8' });
    });
  } finally {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
