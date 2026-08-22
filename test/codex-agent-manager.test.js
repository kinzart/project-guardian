import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  HOOK_PATH,
  GUARDIAN_HOOK_EVENTS,
  readHookVersion,
  readHooksJson,
  install,
  uninstall,
  restore,
  doctor,
  readHookTrustState,
  trustStatusForGuardianHooks,
} from '../src/agent/codex/manager.js';
import { globalConfigTomlPath } from '../src/agent/codex/discovery.js';

function sandbox() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'guardian-codex-agent-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

test('manager: readHookVersion finds the version marker in hook.mjs', () => {
  assert.equal(readHookVersion(), '1.0.0');
});

test('manager: install into a hooks.json that does not exist yet creates it with SessionStart/SessionEnd/Stop, using both command and commandWindows', () => {
  const { dir, cleanup } = sandbox();
  try {
    const hooksJsonPath = path.join(dir, 'hooks.json');
    const backupDir = path.join(dir, 'backups');
    const result = install({ hooksJsonPath, backupDir });
    assert.equal(result.alreadyInstalled, false);
    const hooksJson = readHooksJson(hooksJsonPath);
    for (const event of GUARDIAN_HOOK_EVENTS) {
      assert.equal(hooksJson.hooks[event].length, 1, event);
      const handler = hooksJson.hooks[event][0].hooks[0];
      assert.match(handler.command, /hook\.mjs/);
      assert.match(handler.commandWindows, /hook\.mjs/);
    }
    assert.equal(readFileSync(result.backupPath, 'utf8'), 'null');
  } finally {
    cleanup();
  }
});

// Found via real E2E: Codex silently clamps a SessionEnd hook's declared timeout to 3s and warns
// on every session if a longer one is declared ("clamping SessionEnd hook timeout to 3s in
// ...hooks.json"). Declaring 3s ourselves removes the warning without changing real behavior
// (the hook's actual connect timeout is 400ms regardless — see hook.mjs).
test('manager: install declares a <=3s timeout for SessionEnd specifically, to avoid Codex\'s real clamp-and-warn behavior', () => {
  const { dir, cleanup } = sandbox();
  try {
    const hooksJsonPath = path.join(dir, 'hooks.json');
    install({ hooksJsonPath, backupDir: path.join(dir, 'backups') });
    const hooksJson = readHooksJson(hooksJsonPath);
    assert.ok(hooksJson.hooks.SessionEnd[0].hooks[0].timeout <= 3);
    assert.ok(hooksJson.hooks.SessionStart[0].hooks[0].timeout > 3);
  } finally {
    cleanup();
  }
});

test('manager: install is idempotent — running twice never duplicates entries', () => {
  const { dir, cleanup } = sandbox();
  try {
    const hooksJsonPath = path.join(dir, 'hooks.json');
    const backupDir = path.join(dir, 'backups');
    install({ hooksJsonPath, backupDir });
    const second = install({ hooksJsonPath, backupDir });
    assert.equal(second.alreadyInstalled, true);
    const hooksJson = readHooksJson(hooksJsonPath);
    for (const event of GUARDIAN_HOOK_EVENTS) assert.equal(hooksJson.hooks[event].length, 1, event);
  } finally {
    cleanup();
  }
});

test('manager: install preserves an existing other-tool hook entry in the same event array (real coexistence shape found in D:\\release-e2e\\codex-project\\.codex\\hooks.json)', () => {
  const { dir, cleanup } = sandbox();
  try {
    const hooksJsonPath = path.join(dir, 'hooks.json');
    const backupDir = path.join(dir, 'backups');
    mkdirSync(path.dirname(hooksJsonPath), { recursive: true });
    writeFileSync(
      hooksJsonPath,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'node ".memory/tools/agent-progress-codex-hook.mjs"' }] }],
          PostToolUse: [{ matcher: 'update_plan', hooks: [{ type: 'command', command: 'node ".memory/tools/agent-progress-codex-hook.mjs"' }] }],
        },
      }),
    );
    install({ hooksJsonPath, backupDir });
    const hooksJson = readHooksJson(hooksJsonPath);
    assert.equal(hooksJson.hooks.SessionStart.length, 2); // other tool's entry + Guardian's
    assert.ok(hooksJson.hooks.SessionStart.some((e) => e.hooks[0].command.includes('agent-progress-codex-hook')));
    assert.ok(hooksJson.hooks.SessionStart.some((e) => e.hooks[0].command.includes('hook.mjs') && !e.hooks[0].command.includes('agent-progress')));
    // an event Guardian never touches (PostToolUse) is left completely untouched
    assert.equal(hooksJson.hooks.PostToolUse.length, 1);
    assert.equal(hooksJson.hooks.PostToolUse[0].matcher, 'update_plan');
  } finally {
    cleanup();
  }
});

test('manager: uninstall removes only Guardian entries, leaves other tools\' entries and events untouched', () => {
  const { dir, cleanup } = sandbox();
  try {
    const hooksJsonPath = path.join(dir, 'hooks.json');
    const backupDir = path.join(dir, 'backups');
    mkdirSync(path.dirname(hooksJsonPath), { recursive: true });
    writeFileSync(hooksJsonPath, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node "/other/tool.mjs"' }] }] } }));
    install({ hooksJsonPath, backupDir });
    const result = uninstall({ hooksJsonPath, backupDir });
    assert.equal(result.removed, true);
    const hooksJson = readHooksJson(hooksJsonPath);
    assert.equal(hooksJson.hooks.SessionStart.length, 1);
    assert.match(hooksJson.hooks.SessionStart[0].hooks[0].command, /other\/tool\.mjs/);
    assert.equal('SessionEnd' in hooksJson.hooks, false); // Guardian-only event array deleted entirely
  } finally {
    cleanup();
  }
});

test('manager: uninstall on a hooks.json with no Guardian hooks refuses cleanly', () => {
  const { dir, cleanup } = sandbox();
  try {
    const hooksJsonPath = path.join(dir, 'hooks.json');
    mkdirSync(path.dirname(hooksJsonPath), { recursive: true });
    writeFileSync(hooksJsonPath, JSON.stringify({ hooks: {} }));
    const result = uninstall({ hooksJsonPath, backupDir: path.join(dir, 'backups') });
    assert.equal(result.removed, false);
    assert.match(result.reason, /no Guardian hooks present/);
  } finally {
    cleanup();
  }
});

test('manager: restore succeeds as a no-op when the current Guardian hooks still match the install hash', () => {
  const { dir, cleanup } = sandbox();
  try {
    const hooksJsonPath = path.join(dir, 'hooks.json');
    const backupDir = path.join(dir, 'backups');
    const installResult = install({ hooksJsonPath, backupDir });
    const result = restore({ hooksJsonPath, lastInstalledHooksHash: installResult.guardianHooksHash });
    assert.equal(result.restored, true);
  } finally {
    cleanup();
  }
});

test('manager: restore refuses when the current Guardian hook entry was hand-edited', () => {
  const { dir, cleanup } = sandbox();
  try {
    const hooksJsonPath = path.join(dir, 'hooks.json');
    const backupDir = path.join(dir, 'backups');
    const installResult = install({ hooksJsonPath, backupDir });
    const hooksJson = readHooksJson(hooksJsonPath);
    hooksJson.hooks.SessionStart[0].hooks[0].command += ' --extra-flag';
    writeFileSync(hooksJsonPath, JSON.stringify(hooksJson, null, 2));
    const result = restore({ hooksJsonPath, lastInstalledHooksHash: installResult.guardianHooksHash });
    assert.equal(result.restored, false);
    assert.match(result.reason, /differ from what Guardian last installed/);
  } finally {
    cleanup();
  }
});

test('manager: doctor reports guardianHooksPresent per event and other-tool entry counts', () => {
  const { dir, cleanup } = sandbox();
  try {
    const hooksJsonPath = path.join(dir, 'hooks.json');
    mkdirSync(path.dirname(hooksJsonPath), { recursive: true });
    writeFileSync(hooksJsonPath, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node "/other/tool.mjs"' }] }] } }));
    install({ hooksJsonPath, backupDir: path.join(dir, 'backups') });
    const checks = doctor({ hooksJsonPath, configTomlPath: path.join(dir, 'nonexistent-config.toml') });
    assert.equal(checks.hooksJsonFound, true);
    assert.equal(checks.parseable, true);
    for (const event of GUARDIAN_HOOK_EVENTS) assert.equal(checks.guardianHooksPresent[event], true, event);
    assert.equal(checks.otherToolEntries.SessionStart, 1);
    assert.equal(checks.otherToolEntries.SessionEnd, 0);
    // no config.toml at all -> trust status is honestly 'unknown', never guessed
    for (const event of GUARDIAN_HOOK_EVENTS) assert.equal(checks.trustStatus[event], 'unknown', event);
  } finally {
    cleanup();
  }
});

test('manager: doctor on a nonexistent hooks.json reports hooksJsonFound=false without crashing', () => {
  const checks = doctor({ hooksJsonPath: path.join(os.tmpdir(), `nope-${Date.now()}.json`), configTomlPath: path.join(os.tmpdir(), 'nope.toml') });
  assert.equal(checks.hooksJsonFound, false);
});

// ---- trust state -------------------------------------------------------------------------------

test('manager: readHookTrustState parses a sandboxed [hooks.state] table correctly', () => {
  const { dir, cleanup } = sandbox();
  try {
    const configTomlPath = path.join(dir, 'config.toml');
    const hooksJsonPath = 'C:\\Users\\testuser\\.codex\\hooks.json';
    writeFileSync(
      configTomlPath,
      [
        '[hooks.state]',
        '',
        `[hooks.state.'${hooksJsonPath}:session_start:0:0']`,
        'trusted_hash = "sha256:deadbeef"',
        '',
        `[hooks.state.'${hooksJsonPath}:session_end:0:0']`,
        'trusted_hash = "sha256:cafef00d"',
      ].join('\n'),
    );
    const state = readHookTrustState(configTomlPath);
    assert.equal(state[`${hooksJsonPath}:session_start:0:0`].trustedHash, 'sha256:deadbeef');
    assert.equal(state[`${hooksJsonPath}:session_end:0:0`].trustedHash, 'sha256:cafef00d');

    const trust = trustStatusForGuardianHooks({ hooksJsonPath, configTomlPath });
    assert.equal(trust.SessionStart, 'trusted');
    assert.equal(trust.SessionEnd, 'trusted');
    assert.equal(trust.Stop, 'unknown'); // no entry for Stop in this sandboxed table
  } finally {
    cleanup();
  }
});

test('manager: readHookTrustState against the REAL config.toml on this machine parses the real trusted AUM/agent-progress fixture entries without crashing', () => {
  const state = readHookTrustState(globalConfigTomlPath());
  const key = 'D:\\release-e2e\\codex-project\\.codex\\hooks.json:session_start:0:0';
  // This exact entry was found via real inspection during SPEC_V0.6B.md's investigation — proves
  // the narrow line-based extractor really parses this machine's real trust bookkeeping.
  assert.equal(typeof state[key]?.trustedHash, 'string');
  assert.match(state[key].trustedHash, /^sha256:/);
});

test('manager: HOOK_PATH points at the real, readable hook.mjs', () => {
  assert.match(readFileSync(HOOK_PATH, 'utf8'), /Guardian Codex Hook/);
});
