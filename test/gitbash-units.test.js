import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { normalizeGitBashPath } from '../src/shell/gitbash/path-normalizer.js';
import { normalizeShellEvent } from '../src/shell/normalizer.js';
import { install, uninstall, restore, doctor } from '../src/shell/gitbash/bash-manager.js';
import { hasBlock, extractBlock, computeHash } from '../src/shell/installer.js';

// --- path normalization (the "/d/PROJECT-GUARDIAN -> D:\PROJECT-GUARDIAN" requirement) --------

test('path-normalizer: forward-slash Windows path from `pwd -W` (the real, common case)', () => {
  assert.equal(normalizeGitBashPath('D:/PROJECT-GUARDIAN'), 'D:\\PROJECT-GUARDIAN');
  assert.equal(normalizeGitBashPath('D:/PROJECT-GUARDIAN/src/watch'), 'D:\\PROJECT-GUARDIAN\\src\\watch');
  assert.equal(normalizeGitBashPath('C:/'), 'C:\\');
});

test('path-normalizer: raw POSIX MSYS path (defensive fallback)', () => {
  assert.equal(normalizeGitBashPath('/d/PROJECT-GUARDIAN'), 'D:\\PROJECT-GUARDIAN');
  assert.equal(normalizeGitBashPath('/c/Users/testuser'), 'C:\\Users\\testuser');
  assert.equal(normalizeGitBashPath('/d'), 'D:\\');
});

test('path-normalizer: already-Windows-backslash and unrecognized paths pass through unchanged', () => {
  assert.equal(normalizeGitBashPath('D:\\PROJECT-GUARDIAN'), 'D:\\PROJECT-GUARDIAN');
  assert.equal(normalizeGitBashPath('relative/path'), 'relative/path');
  assert.equal(normalizeGitBashPath(''), '');
  assert.equal(normalizeGitBashPath(null), null);
});

test('normalizer: a Git-Bash-sourced event has its cwd normalized and gets the GITBASH_HOOK source', () => {
  const n = normalizeShellEvent({
    type: 'SHELL_STARTED',
    shell_session_id: 'a',
    pid: 1,
    shell_type: 'bash',
    shell_version: '5.3.15(1)-release',
    host_name: 'MINGW64',
    cwd: 'D:/PROJECT-GUARDIAN',
    timestamp: 't',
  });
  assert.equal(n.cwd, 'D:\\PROJECT-GUARDIAN');
  assert.equal(n.source, 'GITBASH_HOOK');
});

test('normalizer: a PowerShell-sourced event is untouched by Git Bash path handling (regression)', () => {
  const n = normalizeShellEvent({
    type: 'SHELL_STARTED',
    shell_session_id: 'a',
    pid: 1,
    shell_type: 'Desktop',
    shell_version: '5.1',
    host_name: 'ConsoleHost',
    cwd: 'D:\\PROJECT-GUARDIAN',
    timestamp: 't',
  });
  assert.equal(n.cwd, 'D:\\PROJECT-GUARDIAN');
  assert.equal(n.source, 'POWERSHELL_HOOK');
});

// --- bash-manager install/uninstall/restore/doctor (fake files only) --------------------------

async function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'guardian-gitbash-profile-'));
  return {
    profilePath: path.join(dir, '.bashrc'),
    backupDir: path.join(dir, 'backups'),
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
}

test('bash-manager.install: creates the file with the Guardian block when none exists', async () => {
  const { profilePath, backupDir, cleanup } = await setup();
  try {
    const result = install({ profilePath, backupDir, hookPath: 'D:\\fake\\hook.sh' });
    assert.equal(result.alreadyInstalled, false);
    assert.ok(existsSync(result.backupPath));
    const content = readFileSync(profilePath, 'utf8');
    assert.ok(hasBlock(content));
    assert.match(content, /source "\/d\/fake\/hook\.sh"/); // Windows path converted to POSIX for bash
  } finally {
    cleanup();
  }
});

test('bash-manager.install: preserves pre-existing PROMPT_COMMAND / other content untouched', async () => {
  const { profilePath, backupDir, cleanup } = await setup();
  try {
    writeFileSync(profilePath, 'export PROMPT_COMMAND="my_existing_prompt_fn"\nalias ll="ls -la"\n');
    install({ profilePath, backupDir, hookPath: 'D:\\fake\\hook.sh' });
    const content = readFileSync(profilePath, 'utf8');
    assert.match(content, /PROMPT_COMMAND="my_existing_prompt_fn"/);
    assert.match(content, /alias ll="ls -la"/);
  } finally {
    cleanup();
  }
});

test('bash-manager.install: running twice is idempotent', async () => {
  const { profilePath, backupDir, cleanup } = await setup();
  try {
    install({ profilePath, backupDir, hookPath: 'D:\\fake\\hook.sh' });
    const afterFirst = readFileSync(profilePath, 'utf8');
    const secondResult = install({ profilePath, backupDir, hookPath: 'D:\\fake\\hook.sh' });
    assert.equal(readFileSync(profilePath, 'utf8'), afterFirst);
    assert.equal(secondResult.alreadyInstalled, true);
  } finally {
    cleanup();
  }
});

test('bash-manager.uninstall: removes only the Guardian block', async () => {
  const { profilePath, backupDir, cleanup } = await setup();
  try {
    writeFileSync(profilePath, 'export PROMPT_COMMAND="my_existing_prompt_fn"\n');
    install({ profilePath, backupDir, hookPath: 'D:\\fake\\hook.sh' });
    const result = uninstall({ profilePath, backupDir });
    assert.equal(result.removed, true);
    const content = readFileSync(profilePath, 'utf8');
    assert.ok(!hasBlock(content));
    assert.match(content, /PROMPT_COMMAND="my_existing_prompt_fn"/);
  } finally {
    cleanup();
  }
});

test('bash-manager.restore: refuses when the block was hand-edited since Guardian installed it', async () => {
  const { profilePath, backupDir, cleanup } = await setup();
  try {
    install({ profilePath, backupDir, hookPath: 'D:\\fake\\hook.sh' });
    const originalHash = computeHash(extractBlock(readFileSync(profilePath, 'utf8')));
    writeFileSync(profilePath, readFileSync(profilePath, 'utf8').replace('fake', 'tampered'));
    const result = restore({ profilePath, lastInstalledBlockHash: originalHash });
    assert.equal(result.restored, false);
  } finally {
    cleanup();
  }
});

test('bash-manager.doctor: detects a clean install and a hand-duplicated marker', async () => {
  const { profilePath, backupDir, cleanup } = await setup();
  try {
    install({ profilePath, backupDir, hookPath: 'D:\\fake\\hook.sh' });
    assert.equal(doctor({ profilePath }).blockPresent, true);

    const content = readFileSync(profilePath, 'utf8');
    writeFileSync(profilePath, content + '\n' + content);
    const checks = doctor({ profilePath });
    assert.equal(checks.duplicateMarkers, true);
    assert.equal(checks.blockPresent, false);
  } finally {
    cleanup();
  }
});
