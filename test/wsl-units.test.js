import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWslListOutput } from '../src/shell/wsl/discovery.js';
import { validateWslShellEvent } from '../src/shell/wsl/schema.js';
import { normalizeWslShellEvent } from '../src/shell/wsl/normalizer.js';
import { encodeProjectIdentity, parseProjectIdentity, resolveWslProject } from '../src/shell/wsl/path-identity.js';

// --- discovery: parseWslListOutput fixtures (absent/no-distro/WSL1/WSL2/multi-distro) ----------
// All fixtures are pre-decoded text (decoding itself is exercised in wsl-manager.test.js's
// decodeWslOutput coverage) — this is the pure parser, testable with zero real WSL install.

test('discovery.parseWslListOutput: empty/absent output -> no distros', () => {
  assert.deepEqual(parseWslListOutput(''), []);
  assert.deepEqual(parseWslListOutput(null), []);
});

test('discovery.parseWslListOutput: WSL core present but zero distros registered (this machine, confirmed real)', () => {
  const text = "There are no installed distributions.\nUse 'wsl.exe --list --online' to list available distributions.\n";
  assert.deepEqual(parseWslListOutput(text), []);
});

test('discovery.parseWslListOutput: single WSL1 distro', () => {
  const text = '  NAME      STATE           VERSION\n* Ubuntu    Running         1\n';
  const distros = parseWslListOutput(text);
  assert.equal(distros.length, 1);
  assert.deepEqual(distros[0], { name: 'Ubuntu', state: 'Running', wslVersion: '1', isDefault: true });
});

test('discovery.parseWslListOutput: single WSL2 distro, not default', () => {
  const text = '  NAME      STATE           VERSION\n  Debian    Stopped         2\n';
  const distros = parseWslListOutput(text);
  assert.equal(distros.length, 1);
  assert.deepEqual(distros[0], { name: 'Debian', state: 'Stopped', wslVersion: '2', isDefault: false });
});

test('discovery.parseWslListOutput: multi-distro, default marker and mixed versions', () => {
  const text = '  NAME               STATE           VERSION\n* Ubuntu-22.04       Running         2\n  Debian             Stopped         1\n  docker-desktop     Running         2\n';
  const distros = parseWslListOutput(text);
  assert.equal(distros.length, 3);
  assert.equal(distros[0].name, 'Ubuntu-22.04');
  assert.equal(distros[0].isDefault, true);
  assert.equal(distros[1].name, 'Debian');
  assert.equal(distros[1].wslVersion, '1');
  assert.equal(distros[2].name, 'docker-desktop');
});

test('discovery.parseWslListOutput: help/usage text (non-distro rows) is never mistaken for a distro', () => {
  const text = 'Copyright (c) Microsoft Corporation. All rights reserved.\nUsage: wsl.exe [Argument] [Options...] [CommandLine]\n';
  assert.deepEqual(parseWslListOutput(text), []);
});

// --- schema: validateWslShellEvent ---------------------------------------------------------------

const validStarted = {
  type: 'SHELL_STARTED',
  shell_session_id: 's1',
  shell_type: 'WSL_BASH',
  distro: 'Ubuntu',
  wsl_version: '2',
  linux_pid: 100,
  linux_parent_pid: 1,
  bash_version: '5.1.16(1)-release',
  cwd_linux: '/home/tester/project',
  cwd_project_identity: 'windows:D:\\PROJECT-GUARDIAN',
  timestamp: '2026-01-01T00:00:00.000Z',
};

test('schema: a well-formed SHELL_STARTED passes and numeric coercion happens', () => {
  const result = validateWslShellEvent(validStarted);
  assert.equal(result.ok, true);
  assert.equal(result.value.linux_pid, 100);
  assert.equal(result.value.linux_parent_pid, 1);
});

test('schema: SHELL_STARTED requires shell_type === WSL_BASH', () => {
  const result = validateWslShellEvent({ ...validStarted, shell_type: 'bash' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /WSL_BASH/);
});

test('schema: missing required field is rejected', () => {
  const { distro, ...rest } = validStarted;
  void distro;
  const result = validateWslShellEvent(rest);
  assert.equal(result.ok, false);
  assert.match(result.reason, /missing required field/);
});

test('schema: forbidden fields (bash_command/env/wslenv/ssh_auth_sock and the standard deny-list) are rejected', () => {
  for (const field of ['bash_command', 'env', 'wslenv', 'ssh_auth_sock', 'stdout', 'stderr', 'history', 'command']) {
    const result = validateWslShellEvent({ ...validStarted, [field]: 'x' });
    assert.equal(result.ok, false, `expected ${field} to be rejected`);
    assert.match(result.reason, /forbidden field/);
  }
});

test('schema: unexpected field for the event type is rejected (CWD_CHANGED cannot carry bash_version)', () => {
  const result = validateWslShellEvent({ type: 'CWD_CHANGED', shell_session_id: 's1', distro: 'Ubuntu', linux_pid: 100, cwd_linux: '/x', timestamp: 't', bash_version: '5.1' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /unexpected field/);
});

test('schema: unknown event type is rejected', () => {
  const result = validateWslShellEvent({ type: 'SOMETHING_ELSE', shell_session_id: 's1', linux_pid: 100, timestamp: 't' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /unknown event type/);
});

test('schema: linux_pid must be numeric', () => {
  const result = validateWslShellEvent({ ...validStarted, linux_pid: 'not-a-number' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /linux_pid/);
});

test('schema: HEARTBEAT is minimal and never carries cwd', () => {
  const ok = validateWslShellEvent({ type: 'HEARTBEAT', shell_session_id: 's1', linux_pid: 100, timestamp: 't' });
  assert.equal(ok.ok, true);
  const rejected = validateWslShellEvent({ type: 'HEARTBEAT', shell_session_id: 's1', linux_pid: 100, timestamp: 't', cwd_linux: '/x' });
  assert.equal(rejected.ok, false);
});

test('schema: SHELL_EXITING accepts only its narrow field set', () => {
  const ok = validateWslShellEvent({ type: 'SHELL_EXITING', shell_session_id: 's1', distro: 'Ubuntu', linux_pid: 100, timestamp: 't' });
  assert.equal(ok.ok, true);
});

// --- normalizer: normalizeWslShellEvent -----------------------------------------------------------

test('normalizer: Windows-backed cwd_project_identity resolves to a usable Windows cwd', () => {
  const validated = validateWslShellEvent(validStarted).value;
  const n = normalizeWslShellEvent(validated);
  assert.equal(n.cwd, 'D:\\PROJECT-GUARDIAN');
  assert.equal(n.distro, 'Ubuntu');
  assert.equal(n.cwd_linux, '/home/tester/project');
  assert.equal(n.wsl_version, '2');
  assert.equal(n.shell_type, 'WSL_BASH');
  assert.equal(n.pid, 100);
  assert.equal(n.parent_pid, 1);
  assert.equal(n.source, 'WSL_HOOK');
});

test('normalizer: WSL-native cwd_project_identity yields cwd=null (never fabricates a Windows path)', () => {
  const validated = validateWslShellEvent({ ...validStarted, cwd_project_identity: 'wsl:Ubuntu:/home/tester/native-only' }).value;
  const n = normalizeWslShellEvent(validated);
  assert.equal(n.cwd, null);
  assert.equal(n.cwd_linux, '/home/tester/project');
});

test('normalizer: no cwd_project_identity at all (e.g. SHELL_EXITING) yields cwd=null without error', () => {
  const validated = validateWslShellEvent({ type: 'SHELL_EXITING', shell_session_id: 's1', distro: 'Ubuntu', linux_pid: 100, timestamp: 't' }).value;
  const n = normalizeWslShellEvent(validated);
  assert.equal(n.cwd, null);
  assert.equal(n.type, 'SHELL_EXITING');
});

// --- path-identity: encode/parse/resolve ----------------------------------------------------------

test('path-identity: encode/parse round-trips both namespaces', () => {
  assert.equal(encodeProjectIdentity({ namespace: 'WINDOWS', windowsPath: 'D:\\PROJECT-GUARDIAN' }), 'windows:D:\\PROJECT-GUARDIAN');
  assert.equal(encodeProjectIdentity({ namespace: 'WSL', distro: 'Ubuntu', linuxPath: '/home/x' }), 'wsl:Ubuntu:/home/x');
  assert.equal(encodeProjectIdentity(null), null);

  assert.deepEqual(parseProjectIdentity('windows:D:\\PROJECT-GUARDIAN'), { namespace: 'WINDOWS', windowsPath: 'D:\\PROJECT-GUARDIAN' });
  assert.deepEqual(parseProjectIdentity('wsl:Ubuntu:/home/x'), { namespace: 'WSL', distro: 'Ubuntu', linuxPath: '/home/x' });
});

test('path-identity: malformed/unrecognized strings parse to null, never guessed', () => {
  assert.equal(parseProjectIdentity(''), null);
  assert.equal(parseProjectIdentity('not-a-namespace:foo'), null);
  assert.equal(parseProjectIdentity('wsl:onlydistro'), null);
  assert.equal(parseProjectIdentity(123), null);
});

test('path-identity: resolveWslProject resolves a Windows-backed identity against the real inventory', () => {
  const projects = [{ id: 'pg', name: 'PROJECT-GUARDIAN', root_path: 'D:\\PROJECT-GUARDIAN' }];
  const resolved = resolveWslProject('windows:D:\\PROJECT-GUARDIAN\\src', projects);
  assert.equal(resolved.id, 'pg');
});

test('path-identity: resolveWslProject NEVER resolves a WSL-native identity (deferred to a future phase, never guessed)', () => {
  const projects = [{ id: 'pg', name: 'PROJECT-GUARDIAN', root_path: 'D:\\PROJECT-GUARDIAN' }];
  assert.equal(resolveWslProject('wsl:Ubuntu:/home/tester/some-project', projects), null);
  assert.equal(resolveWslProject('wsl:Ubuntu:/home/tester/some-project', projects, { Ubuntu: '/home/tester' }), null);
});

test('path-identity: resolveWslProject returns null for an unresolvable/absent identity', () => {
  assert.equal(resolveWslProject(null, []), null);
  assert.equal(resolveWslProject('garbage', []), null);
});
