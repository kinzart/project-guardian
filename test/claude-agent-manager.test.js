import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  HOOK_PATH,
  GUARDIAN_HOOK_EVENTS,
  readHookVersion,
  readSettings,
  install,
  uninstall,
  restore,
  doctor,
} from '../src/agent/claude/manager.js';

function sandbox() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'guardian-claude-agent-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

test('manager: readHookVersion finds the version marker in hook.mjs', () => {
  assert.equal(readHookVersion(), '1.0.0');
});

test('manager: install into a settings.json that does not exist yet creates it with all 5 Guardian hooks', () => {
  const { dir, cleanup } = sandbox();
  try {
    const settingsPath = path.join(dir, 'settings.json');
    const backupDir = path.join(dir, 'backups');
    const result = install({ settingsPath, backupDir });
    assert.equal(result.alreadyInstalled, false);
    const settings = readSettings(settingsPath);
    for (const event of GUARDIAN_HOOK_EVENTS) {
      assert.equal(settings.hooks[event].length, 1, event);
      assert.match(settings.hooks[event][0].hooks[0].command, /hook\.mjs/);
    }
    assert.equal(readFileSync(result.backupPath, 'utf8'), 'null');
  } finally {
    cleanup();
  }
});

test('manager: install is idempotent — running twice never duplicates entries', () => {
  const { dir, cleanup } = sandbox();
  try {
    const settingsPath = path.join(dir, 'settings.json');
    const backupDir = path.join(dir, 'backups');
    install({ settingsPath, backupDir });
    const second = install({ settingsPath, backupDir });
    assert.equal(second.alreadyInstalled, true);
    const settings = readSettings(settingsPath);
    for (const event of GUARDIAN_HOOK_EVENTS) assert.equal(settings.hooks[event].length, 1, event);
  } finally {
    cleanup();
  }
});

test('manager: install preserves an existing other-tool hook entry in the same event array (real coexistence shape found on this machine)', () => {
  const { dir, cleanup } = sandbox();
  try {
    const settingsPath = path.join(dir, 'settings.json');
    const backupDir = path.join(dir, 'backups');
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        model: 'opusplan',
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'node "/some/other/tool/session-start.mjs"' }] }],
        },
      }),
    );
    install({ settingsPath, backupDir });
    const settings = readSettings(settingsPath);
    assert.equal(settings.model, 'opusplan'); // untouched top-level key
    assert.equal(settings.hooks.SessionStart.length, 2); // other tool's entry + Guardian's
    assert.ok(settings.hooks.SessionStart.some((e) => e.hooks[0].command.includes('other/tool')));
    assert.ok(settings.hooks.SessionStart.some((e) => e.hooks[0].command.includes('hook.mjs')));
  } finally {
    cleanup();
  }
});

test('manager: uninstall removes only Guardian entries, leaves other tools\' entries and unrelated keys intact', () => {
  const { dir, cleanup } = sandbox();
  try {
    const settingsPath = path.join(dir, 'settings.json');
    const backupDir = path.join(dir, 'backups');
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({ theme: 'dark', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node "/other/tool.mjs"' }] }] } }),
    );
    install({ settingsPath, backupDir });
    const result = uninstall({ settingsPath, backupDir });
    assert.equal(result.removed, true);
    const settings = readSettings(settingsPath);
    assert.equal(settings.theme, 'dark');
    assert.equal(settings.hooks.SessionStart.length, 1);
    assert.match(settings.hooks.SessionStart[0].hooks[0].command, /other\/tool\.mjs/);
    // every other Guardian-only event array should have been deleted entirely (went to zero)
    assert.equal('CwdChanged' in settings.hooks, false);
  } finally {
    cleanup();
  }
});

test('manager: uninstall on a settings.json with no Guardian hooks refuses cleanly', () => {
  const { dir, cleanup } = sandbox();
  try {
    const settingsPath = path.join(dir, 'settings.json');
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ theme: 'dark' }));
    const result = uninstall({ settingsPath, backupDir: path.join(dir, 'backups') });
    assert.equal(result.removed, false);
    assert.match(result.reason, /no Guardian hooks present/);
  } finally {
    cleanup();
  }
});

test('manager: uninstall on a missing settings.json refuses cleanly', () => {
  const { dir, cleanup } = sandbox();
  try {
    const result = uninstall({ settingsPath: path.join(dir, 'nope.json'), backupDir: path.join(dir, 'backups') });
    assert.equal(result.removed, false);
    assert.match(result.reason, /does not exist/);
  } finally {
    cleanup();
  }
});

test('manager: restore succeeds as a no-op when the current Guardian hooks still match the install hash', () => {
  const { dir, cleanup } = sandbox();
  try {
    const settingsPath = path.join(dir, 'settings.json');
    const backupDir = path.join(dir, 'backups');
    const installResult = install({ settingsPath, backupDir });
    const result = restore({ settingsPath, lastInstalledHooksHash: installResult.guardianHooksHash });
    assert.equal(result.restored, true);
  } finally {
    cleanup();
  }
});

test('manager: restore refuses when the current Guardian hook entry was hand-edited', () => {
  const { dir, cleanup } = sandbox();
  try {
    const settingsPath = path.join(dir, 'settings.json');
    const backupDir = path.join(dir, 'backups');
    const installResult = install({ settingsPath, backupDir });
    const settings = readSettings(settingsPath);
    settings.hooks.SessionStart[0].hooks[0].command += ' --extra-flag';
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    const result = restore({ settingsPath, lastInstalledHooksHash: installResult.guardianHooksHash });
    assert.equal(result.restored, false);
    assert.match(result.reason, /differ from what Guardian last installed/);
  } finally {
    cleanup();
  }
});

test('manager: restore refuses without a known prior install hash — never guesses', () => {
  const { dir, cleanup } = sandbox();
  try {
    const settingsPath = path.join(dir, 'settings.json');
    install({ settingsPath, backupDir: path.join(dir, 'backups') });
    const result = restore({ settingsPath, lastInstalledHooksHash: null });
    assert.equal(result.restored, false);
    assert.match(result.reason, /refusing to guess/);
  } finally {
    cleanup();
  }
});

test('manager: doctor reports guardianHooksPresent per event and counts other-tool entries without touching anything', () => {
  const { dir, cleanup } = sandbox();
  try {
    const settingsPath = path.join(dir, 'settings.json');
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node "/other/tool.mjs"' }] }] } }));
    install({ settingsPath, backupDir: path.join(dir, 'backups') });
    const checks = doctor({ settingsPath });
    assert.equal(checks.settingsFound, true);
    assert.equal(checks.parseable, true);
    for (const event of GUARDIAN_HOOK_EVENTS) assert.equal(checks.guardianHooksPresent[event], true, event);
    assert.equal(checks.otherToolEntries.SessionStart, 1);
    assert.equal(checks.otherToolEntries.CwdChanged, 0);
  } finally {
    cleanup();
  }
});

test('manager: doctor on a nonexistent settings.json reports settingsFound=false without crashing', () => {
  const checks = doctor({ settingsPath: path.join(os.tmpdir(), `nope-${Date.now()}.json`) });
  assert.equal(checks.settingsFound, false);
});

test('manager: HOOK_PATH points at the real, readable hook.mjs', () => {
  assert.match(readFileSync(HOOK_PATH, 'utf8'), /Guardian Claude Hook/);
});
