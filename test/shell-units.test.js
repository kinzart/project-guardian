import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateShellEvent } from '../src/shell/schema.js';
import { normalizeShellEvent } from '../src/shell/normalizer.js';
import { ShellSessionRegistry } from '../src/shell/session-store.js';
import { resolveProjectForCwd } from '../src/shell/correlator.js';
import { correlateProject } from '../src/process/project-correlator.js';
import { ProcessTree } from '../src/process/process-tree.js';
import { START_MARKER, END_MARKER, buildBlock, hasBlock, hasDuplicateMarkers, extractBlock, insertOrReplaceBlock, removeBlock, computeHash } from '../src/shell/installer.js';
import { CONFIDENCE } from '../src/intelligence/field.js';

// --- schema (cases 1-6) -----------------------------------------------------

test('schema: valid SHELL_STARTED accepted', () => {
  const r = validateShellEvent({
    type: 'SHELL_STARTED',
    shell_session_id: 'abc-123',
    pid: 100,
    parent_pid: 1,
    shell_type: 'Desktop',
    shell_version: '5.1.19041.1',
    host_name: 'ConsoleHost',
    cwd: 'D:\\PROJECT-GUARDIAN',
    timestamp: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.pid, 100);
});

test('schema: valid CWD_CHANGED accepted', () => {
  const r = validateShellEvent({ type: 'CWD_CHANGED', shell_session_id: 'abc-123', pid: 100, cwd: 'D:\\X', timestamp: '2026-01-01T00:00:00.000Z' });
  assert.equal(r.ok, true);
});

test('schema: valid SHELL_EXITING accepted', () => {
  const r = validateShellEvent({ type: 'SHELL_EXITING', shell_session_id: 'abc-123', pid: 100, timestamp: '2026-01-01T00:00:00.000Z' });
  assert.equal(r.ok, true);
});

test('schema: an extra "command" field rejects the whole event', () => {
  const r = validateShellEvent({ type: 'CWD_CHANGED', shell_session_id: 'abc-123', pid: 100, cwd: 'D:\\X', timestamp: 't', command: 'rm -rf /' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /forbidden field/);
});

test('schema: a "stdout" field rejects the whole event', () => {
  const r = validateShellEvent({ type: 'SHELL_EXITING', shell_session_id: 'a', pid: 1, timestamp: 't', stdout: 'leaked output' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /forbidden field/);
});

test('schema: a "token"/"secret" field rejects the whole event', () => {
  assert.equal(validateShellEvent({ type: 'SHELL_STARTED', shell_session_id: 'a', pid: 1, shell_type: 'Desktop', shell_version: '5.1', host_name: 'x', cwd: 'D:\\X', timestamp: 't', token: 'sk-x' }).ok, false);
  assert.equal(validateShellEvent({ type: 'CWD_CHANGED', shell_session_id: 'a', pid: 1, cwd: 'D:\\X', timestamp: 't', secret: 'x' }).ok, false);
});

test('schema: unknown event type rejected', () => {
  assert.equal(validateShellEvent({ type: 'RUN_COMMAND', pid: 1 }).ok, false);
});

test('schema: only whitelisted fields survive even on a valid event', () => {
  const r = validateShellEvent({ type: 'CWD_CHANGED', shell_session_id: 'a', pid: 1, cwd: 'D:\\X', timestamp: 't' });
  assert.deepEqual(Object.keys(r.value).sort(), ['cwd', 'pid', 'shell_session_id', 'timestamp', 'type']);
});

// --- normalizer --------------------------------------------------------------

test('normalizer: adds provenance, never invents fields the schema stripped', () => {
  const n = normalizeShellEvent({ type: 'SHELL_STARTED', shell_session_id: 'a', pid: 1, shell_type: 'Desktop', shell_version: '5.1', host_name: 'x', cwd: 'D:\\X', timestamp: 't' });
  assert.equal(n.source, 'POWERSHELL_HOOK');
  assert.ok(n.received_at);
  assert.ok(!('command' in n));
});

// --- session-store (cases 8-10, 13, 26, 27) -----------------------------------

test('session-store: shell start once creates exactly one session', () => {
  const reg = new ShellSessionRegistry();
  const s = reg.onShellStarted({ shell_session_id: 's1', pid: 100, parent_pid: 1, shell_type: 'Desktop', shell_version: '5.1', host_name: 'x', cwd: 'D:\\A', timestamp: 't0' });
  assert.equal(s.status, 'ACTIVE');
  assert.equal(reg.list().length, 1);
});

test('session-store: same CWD reported twice is suppressed as a duplicate', () => {
  const reg = new ShellSessionRegistry();
  reg.onShellStarted({ shell_session_id: 's1', pid: 100, parent_pid: 1, shell_type: 'Desktop', shell_version: '5.1', host_name: 'x', cwd: 'D:\\A', timestamp: 't0' });
  const r1 = reg.onCwdChanged({ shell_session_id: 's1', pid: 100, cwd: 'D:\\A', timestamp: 't1' });
  assert.equal(r1.duplicate, true);
  assert.equal(reg.get('s1').cwd_timeline.length, 1);
});

test('session-store: a real CWD change appends to the timeline (case 26)', () => {
  const reg = new ShellSessionRegistry();
  reg.onShellStarted({ shell_session_id: 's1', pid: 100, parent_pid: 1, shell_type: 'Desktop', shell_version: '5.1', host_name: 'x', cwd: 'D:\\A', timestamp: 't0' });
  const r1 = reg.onCwdChanged({ shell_session_id: 's1', pid: 100, cwd: 'D:\\B', timestamp: 't1' });
  assert.equal(r1.duplicate, false);
  const r2 = reg.onCwdChanged({ shell_session_id: 's1', pid: 100, cwd: 'D:\\C', timestamp: 't2' });
  assert.equal(r2.duplicate, false);
  const timeline = reg.get('s1').cwd_timeline;
  assert.deepEqual(timeline.map((t) => t.cwd), ['D:\\A', 'D:\\B', 'D:\\C']);
});

test('session-store: SHELL_EXITING ends the session (case 27)', () => {
  const reg = new ShellSessionRegistry();
  reg.onShellStarted({ shell_session_id: 's1', pid: 100, parent_pid: 1, shell_type: 'Desktop', shell_version: '5.1', host_name: 'x', cwd: 'D:\\A', timestamp: 't0' });
  const ended = reg.onShellExiting({ shell_session_id: 's1', pid: 100, timestamp: 't5' });
  assert.equal(ended.status, 'ENDED');
  assert.equal(ended.ended_at, 't5');
  assert.equal(reg.getByPid(100), null);
});

test('session-store: an abrupt stop reconciled via the process observer never becomes ENDED (case 28)', () => {
  const reg = new ShellSessionRegistry();
  reg.onShellStarted({ shell_session_id: 's1', pid: 100, parent_pid: 1, shell_type: 'Desktop', shell_version: '5.1', host_name: 'x', cwd: 'D:\\A', timestamp: 't0' });
  const closed = reg.reconcileStopped(100, 't9');
  assert.equal(closed.status, 'UNCLEAN');
  assert.notEqual(closed.status, 'ENDED'); // never invent a graceful exit
});

test('session-store: multiple concurrent shells stay isolated (case 14)', () => {
  const reg = new ShellSessionRegistry();
  reg.onShellStarted({ shell_session_id: 's1', pid: 100, parent_pid: 1, shell_type: 'Desktop', shell_version: '5.1', host_name: 'x', cwd: 'D:\\A', timestamp: 't0' });
  reg.onShellStarted({ shell_session_id: 's2', pid: 200, parent_pid: 1, shell_type: 'Core', shell_version: '7.4', host_name: 'x', cwd: 'D:\\B', timestamp: 't0' });
  reg.onCwdChanged({ shell_session_id: 's1', pid: 100, cwd: 'D:\\A2', timestamp: 't1' });
  assert.equal(reg.get('s2').cwd, 'D:\\B'); // s2 untouched by s1's change
  assert.equal(reg.list({ active: true }).length, 2);
});

// --- installer (block idempotency / integrity, cases 16-19) -------------------

test('installer: buildBlock/hasBlock/extractBlock round-trip', () => {
  const block = buildBlock('. "hook.ps1"');
  assert.ok(hasBlock(block));
  assert.equal(extractBlock(block), block);
});

test('installer: insertOrReplaceBlock is idempotent — running it twice never duplicates', () => {
  let content = '# my custom profile stuff\nWrite-Host "hi"\n';
  content = insertOrReplaceBlock(content, '. "hook.ps1"');
  const once = content;
  content = insertOrReplaceBlock(content, '. "hook.ps1"');
  assert.equal(content, once);
  assert.equal((content.match(new RegExp(START_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1);
});

test('installer: content before/after the block is preserved untouched', () => {
  const before = 'Set-Alias ll Get-ChildItem\nfunction prompt { "PS> " }\n';
  const withBlock = insertOrReplaceBlock(before, '. "hook.ps1"');
  assert.ok(withBlock.startsWith(before.trimEnd()) || withBlock.includes(before.trim()));
  assert.match(withBlock, /Set-Alias ll Get-ChildItem/);
  assert.match(withBlock, /function prompt/);
});

test('installer: removeBlock removes only the Guardian block, keeps everything else', () => {
  const userContent = 'Set-Alias ll Get-ChildItem\nfunction prompt { "PS> " }';
  const withBlock = insertOrReplaceBlock(userContent, '. "hook.ps1"');
  const removed = removeBlock(withBlock);
  assert.ok(!hasBlock(removed));
  assert.match(removed, /Set-Alias ll Get-ChildItem/);
  assert.match(removed, /function prompt/);
});

test('installer: hasDuplicateMarkers detects a corrupted/hand-duplicated profile (case 19)', () => {
  const corrupted = `${START_MARKER}\nfoo\n${END_MARKER}\n${START_MARKER}\nbar\n${END_MARKER}`;
  assert.equal(hasDuplicateMarkers(corrupted), true);
  assert.equal(hasDuplicateMarkers(buildBlock('foo')), false);
});

test('installer: computeHash is stable for identical content', () => {
  assert.equal(computeHash('abc'), computeHash('abc'));
  assert.notEqual(computeHash('abc'), computeHash('abd'));
});

// --- shell CWD project resolution (cases 20-25) --------------------------------

const PROJECTS = [
  { id: 'pg', name: 'PROJECT-GUARDIAN', root_path: 'D:\\PROJECT-GUARDIAN' },
  { id: 'aum', name: 'ai-universal-memory', root_path: 'D:\\ai-universal-memory' },
  { id: 'sep-v3', name: 'SEPARADOR-V3', root_path: 'C:\\work\\outputs\\SEPARADOR-V3\\SEPARADOR DE INSTRUMENTOS', project_family: 'separador-de-instrumentos' },
];

test('correlator: CWD exactly at a project root resolves (case 20)', () => {
  assert.equal(resolveProjectForCwd('D:\\PROJECT-GUARDIAN', PROJECTS).id, 'pg');
});

test('correlator: CWD nested under a project root resolves to that project (deepest match, case 24)', () => {
  assert.equal(resolveProjectForCwd('D:\\PROJECT-GUARDIAN\\src\\watch', PROJECTS).id, 'pg');
});

test('correlator: CWD outside any known root stays UNKNOWN (case 23-ish)', () => {
  assert.equal(resolveProjectForCwd('D:\\', PROJECTS), null);
  assert.equal(resolveProjectForCwd('C:\\Users\\testuser', PROJECTS), null);
});

test('correlator: CWD under a family member resolves to that member (case 25)', () => {
  const p = resolveProjectForCwd('C:\\work\\outputs\\SEPARADOR-V3\\SEPARADOR DE INSTRUMENTOS\\src', PROJECTS);
  assert.equal(p.id, 'sep-v3');
});

test('correlateProject: shellCwd resolving under a project root is HIGH, checked before command-line/executable evidence (case 21)', () => {
  const tree = new ProcessTree();
  const runtimeId = tree.addStart({ pid: 2000, parentPid: 1000, processName: 'claude.exe', timestamp: 't0' });
  const result = correlateProject({
    record: { runtimeId, timestamp: 't0', executablePath: 'C:\\somewhere\\unrelated\\claude.exe' },
    commandMetadata: { pathLikeArgs: [] },
    tree,
    projects: PROJECTS,
    shellCwd: 'D:\\PROJECT-GUARDIAN',
  });
  assert.equal(result.projectId, 'pg');
  assert.equal(result.confidence, CONFIDENCE.HIGH);
  assert.ok(result.evidence.some((e) => e.includes('shell')));
});

test('correlateProject: shellCwd outside any project leaves correlation to the other evidence, UNKNOWN if none (case 23)', () => {
  const tree = new ProcessTree();
  const runtimeId = tree.addStart({ pid: 2001, parentPid: 1000, processName: 'notepad.exe', timestamp: 't0' });
  const result = correlateProject({
    record: { runtimeId, timestamp: 't0', executablePath: 'C:\\Windows\\notepad.exe' },
    commandMetadata: { pathLikeArgs: [] },
    tree,
    projects: PROJECTS,
    shellCwd: 'C:\\Users\\testuser',
  });
  assert.equal(result.projectId, null);
  assert.equal(result.confidence, CONFIDENCE.UNKNOWN);
});
