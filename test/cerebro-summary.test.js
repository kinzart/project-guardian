import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resumeCommand, writeLauncher, fileUrl } from '../src/cerebro/launchers.js';
import { buildUniversalSummary, isArchived, lastActivityIso, readInbox } from '../src/cerebro/summary.js';
import { duplicateKey, findDuplicateGroups } from '../src/cerebro/duplicates.js';

const s = (o) => ({ agent: 'codex', session_id: 'abc-123', cwd: 'D:\\APPS E PROGRAMAS\\Slides', ...o });

test('launchers: commands per agent', () => {
  assert.equal(resumeCommand(s()), 'codex resume abc-123');
  assert.equal(resumeCommand(s({ agent: 'claude' })), 'claude --resume abc-123');
  assert.equal(resumeCommand(s({ agent: 'hermes' })), 'hermes --resume abc-123');
  assert.equal(resumeCommand(s({ agent: 'chatgpt' })), null);
});

test('launchers: unsafe id or cwd refused and no file written', () => {
  const v = mkdtempSync(path.join(os.tmpdir(), 'cerebro-v-'));
  try {
    assert.equal(writeLauncher(v, s({ session_id: 'x & del *' })), null);
    assert.equal(writeLauncher(v, s({ cwd: 'D:\\a" & calc' })), null);
    assert.equal(writeLauncher(v, s({ cwd: 'D:\\%PATH%' })), null);
    assert.equal(existsSync(path.join(v, '_retomar')), false);
  } finally { rmSync(v, { recursive: true, force: true }); }
});

test('launchers: writes CRLF cmd and returns encoded file url', () => {
  const v = mkdtempSync(path.join(os.tmpdir(), 'cerebro v-'));
  try {
    const url = writeLauncher(v, s());
    const body = readFileSync(path.join(v, '_retomar', 'codex-abc-123.cmd'), 'utf8');
    assert.match(body, /cd \/d "D:\\APPS E PROGRAMAS\\Slides"\r\ncodex resume abc-123\r\n/);
    assert.ok(url.startsWith('file:///')); assert.ok(!url.includes(' '));
    assert.equal(fileUrl('D:\\CEREBRO\\_retomar\\a b.cmd'), 'file:///D:/CEREBRO/_retomar/a%20b.cmd');
  } finally { rmSync(v, { recursive: true, force: true }); }
});

test('summary: inbox wins over session message, next step included', () => {
  const v = mkdtempSync(path.join(os.tmpdir(), 'cerebro-v-'));
  try {
    mkdirSync(path.join(v, 'Caixa de entrada'));
    writeFileSync(path.join(v, 'Caixa de entrada', 'Album.md'), '2026-11-01 antigo\n\n2026-11-25 Mix pronto, falta master.\n');
    const lines = buildUniversalSummary({ project: { name: 'Album', kind: 'music' }, intelligence: { next_steps: [{ text: 'Exportar stems' }] }, lastSession: { last_message: 'sessão' }, inbox: readInbox(v, 'Album') });
    assert.match(lines.join('\n'), /música/); assert.match(lines.join('\n'), /Mix pronto, falta master/); assert.match(lines.join('\n'), /Exportar stems/);
    assert.doesNotMatch(lines.join('\n'), /sessão/);
  } finally { rmSync(v, { recursive: true, force: true }); }
});

test('summary: archive threshold and last activity', () => {
  const now = Date.parse('2026-11-27T00:00:00Z');
  assert.equal(isArchived(new Date(now - 366 * 86400000).toISOString(), now, 365), true);
  assert.equal(isArchived(new Date(now - 364 * 86400000).toISOString(), now, 365), false);
  assert.equal(lastActivityIso({ latest_entry: { mtime: '2026-01-01T00:00:00Z' }, last_git_activity: '2026-03-01T00:00:00Z' }, [{ updated_at: '2026-02-01T00:00:00Z' }]), '2026-03-01T00:00:00.000Z');
  assert.equal(lastActivityIso({}, []), null);
});

test('duplicates: copies and versions group together', () => {
  assert.equal(duplicateKey('Mix Master (1)'), duplicateKey('mix master - cópia'));
  assert.equal(duplicateKey('Slides v2'), duplicateKey('slides'));
  const groups = findDuplicateGroups([
    { name: 'Mix Master', root_path: 'F:\\MIX' }, { name: 'mix master - cópia', root_path: 'D:\\MIX copia' }, { name: 'Other', root_path: 'D:\\o' },
  ]);
  assert.equal(groups.length, 1); assert.equal(groups[0].projects.length, 2);
});
