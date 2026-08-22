import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { install, uninstall, restore, doctor } from '../src/shell/powershell/profile-manager.js';
import { hasBlock, computeHash, extractBlock } from '../src/shell/installer.js';

// Every test here uses a FAKE profile path under a temp directory — never the real
// $PROFILE.CurrentUserCurrentHost. detectInstallations()/CLI wiring (which do consult the real
// system) are exercised separately in the manual real E2E, not here.

async function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'guardian-shell-profile-'));
  return {
    profilePath: path.join(dir, 'Microsoft.PowerShell_profile.ps1'),
    backupDir: path.join(dir, 'backups'),
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
}

test('profile-manager.install: creates the profile with the Guardian block when none exists', async () => {
  const { profilePath, backupDir, cleanup } = await setup();
  try {
    const result = install({ profilePath, backupDir, hookPath: 'C:\\fake\\hook.ps1' });
    assert.equal(result.alreadyInstalled, false);
    assert.ok(existsSync(result.backupPath));
    assert.equal(readFileSync(result.backupPath, 'utf8'), ''); // backup of the (nonexistent) pre-install content
    const content = readFileSync(profilePath, 'utf8');
    assert.ok(hasBlock(content));
    assert.match(content, /fake\\hook\.ps1/);
  } finally {
    cleanup();
  }
});

test('profile-manager.install: preserves pre-existing profile content untouched', async () => {
  const { profilePath, backupDir, cleanup } = await setup();
  try {
    writeFileSync(profilePath, 'function prompt { "MY-PROMPT> " }\nSet-Alias ll Get-ChildItem\n');
    install({ profilePath, backupDir, hookPath: 'C:\\fake\\hook.ps1' });
    const content = readFileSync(profilePath, 'utf8');
    assert.match(content, /function prompt \{ "MY-PROMPT> " \}/);
    assert.match(content, /Set-Alias ll Get-ChildItem/);
  } finally {
    cleanup();
  }
});

test('profile-manager.install: running twice is idempotent — one block, same final content', async () => {
  const { profilePath, backupDir, cleanup } = await setup();
  try {
    writeFileSync(profilePath, 'Write-Host "existing"\n');
    install({ profilePath, backupDir, hookPath: 'C:\\fake\\hook.ps1' });
    const afterFirst = readFileSync(profilePath, 'utf8');
    const secondResult = install({ profilePath, backupDir, hookPath: 'C:\\fake\\hook.ps1' });
    const afterSecond = readFileSync(profilePath, 'utf8');
    assert.equal(afterFirst, afterSecond);
    assert.equal(secondResult.alreadyInstalled, true);
  } finally {
    cleanup();
  }
});

test('profile-manager.uninstall: removes only the Guardian block, leaves the rest byte-preserved', async () => {
  const { profilePath, backupDir, cleanup } = await setup();
  try {
    const userContent = 'function prompt { "MY-PROMPT> " }\nSet-Alias ll Get-ChildItem\n';
    writeFileSync(profilePath, userContent);
    install({ profilePath, backupDir, hookPath: 'C:\\fake\\hook.ps1' });

    const result = uninstall({ profilePath, backupDir });
    assert.equal(result.removed, true);
    const finalContent = readFileSync(profilePath, 'utf8');
    assert.ok(!hasBlock(finalContent));
    assert.match(finalContent, /function prompt \{ "MY-PROMPT> " \}/);
    assert.match(finalContent, /Set-Alias ll Get-ChildItem/);
  } finally {
    cleanup();
  }
});

test('profile-manager.uninstall: refuses when there is no Guardian block (case: nothing to remove)', async () => {
  const { profilePath, backupDir, cleanup } = await setup();
  try {
    writeFileSync(profilePath, 'Write-Host "no guardian here"\n');
    const result = uninstall({ profilePath, backupDir });
    assert.equal(result.removed, false);
  } finally {
    cleanup();
  }
});

test('profile-manager.restore: refuses when the current block does not match what Guardian last installed (concurrent user edit preserved, case 18)', async () => {
  const { profilePath, backupDir, cleanup } = await setup();
  try {
    const result1 = install({ profilePath, backupDir, hookPath: 'C:\\fake\\hook.ps1' });
    const originalBlock = extractBlock(readFileSync(profilePath, 'utf8'));
    const originalBlockHash = computeHash(originalBlock);

    // Simulate a user hand-editing the block afterward (or anything else changing it).
    const tampered = readFileSync(profilePath, 'utf8').replace('fake\\hook.ps1', 'tampered\\hook.ps1');
    writeFileSync(profilePath, tampered);

    const restoreResult = restore({ profilePath, lastInstalledBlockHash: originalBlockHash });
    assert.equal(restoreResult.restored, false);
    assert.match(restoreResult.reason, /differs/);
    // Nothing was overwritten — the tampered content is still there.
    assert.match(readFileSync(profilePath, 'utf8'), /tampered\\hook\.ps1/);
    void result1;
  } finally {
    cleanup();
  }
});

test('profile-manager.restore: proceeds (no-op) when the block still matches the last install', async () => {
  const { profilePath, backupDir, cleanup } = await setup();
  try {
    install({ profilePath, backupDir, hookPath: 'C:\\fake\\hook.ps1' });
    const blockHash = computeHash(extractBlock(readFileSync(profilePath, 'utf8')));
    const result = restore({ profilePath, lastInstalledBlockHash: blockHash });
    assert.equal(result.restored, true);
  } finally {
    cleanup();
  }
});

test('profile-manager.doctor: reports a clean, intact profile correctly', async () => {
  const { profilePath, backupDir, cleanup } = await setup();
  try {
    install({ profilePath, backupDir, hookPath: 'C:\\fake\\hook.ps1' });
    const checks = doctor({ profilePath });
    assert.equal(checks.profileFound, true);
    assert.equal(checks.parseable, true);
    assert.equal(checks.blockPresent, true);
    assert.equal(checks.blockIntact, true);
    assert.equal(checks.duplicateMarkers, false);
  } finally {
    cleanup();
  }
});

test('profile-manager.doctor: detects a corrupted profile with duplicated Guardian markers (case 19)', async () => {
  const { profilePath, backupDir, cleanup } = await setup();
  try {
    install({ profilePath, backupDir, hookPath: 'C:\\fake\\hook.ps1' });
    const content = readFileSync(profilePath, 'utf8');
    writeFileSync(profilePath, content + '\n' + content); // hand-duplicate the whole block
    const checks = doctor({ profilePath });
    assert.equal(checks.duplicateMarkers, true);
    assert.equal(checks.blockPresent, false); // never trust a corrupted profile as "present and fine"
  } finally {
    cleanup();
  }
});

test('profile-manager.doctor: a profile that was never installed reports not found', async () => {
  const { profilePath, cleanup } = await setup();
  try {
    const checks = doctor({ profilePath });
    assert.equal(checks.profileFound, false);
  } finally {
    cleanup();
  }
});
