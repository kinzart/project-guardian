import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readCodexSession } from '../src/sessions/codex.js';
import { readClaudeSession } from '../src/sessions/claude.js';
import { indexSessions, mapSessionsToProjects } from '../src/sessions/index.js';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'cerebro-sess-'));
const j = (o) => JSON.stringify(o);

function codexFile(dir, { id = 'th-1', cwd = 'D:\\Proj', last = 'Terminei o mix.', padding = 0 } = {}) {
  mkdirSync(path.join(dir, 'sessions', '2026', '11', '25'), { recursive: true });
  const f = path.join(dir, 'sessions', '2026', '11', '25', `rollout-${id}.jsonl`);
  const lines = [
    j({ timestamp: '2026-11-25T10:00:00Z', type: 'session_meta', payload: { id, session_id: id, cwd } }),
    'not json {',
    j({ timestamp: '2026-11-25T10:01:00Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'primeira' }] } }),
  ];
  if (padding) lines.push(j({ type: 'pad', payload: { x: 'y'.repeat(padding) } }));
  lines.push(j({ timestamp: '2026-11-25T10:05:00Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: last } }));
  writeFileSync(f, `${lines.join('\n')}\n`);
  return f;
}

test('codex: id, cwd, last message, malformed lines skipped', () => {
  const d = tmp();
  try {
    const s = readCodexSession(codexFile(d), new Map([['th-1', 'Mixar álbum']]));
    assert.equal(s.agent, 'codex'); assert.equal(s.session_id, 'th-1'); assert.equal(s.cwd, 'D:\\Proj');
    assert.equal(s.last_message, 'Terminei o mix.'); assert.equal(s.title, 'Mixar álbum');
    assert.equal(s.updated_at, '2026-11-25T10:05:00Z');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('codex: large file reads meta from head and message from tail', () => {
  const d = tmp();
  try {
    const s = readCodexSession(codexFile(d, { padding: 1024 * 1024 }));
    assert.equal(s.cwd, 'D:\\Proj'); assert.equal(s.last_message, 'Terminei o mix.');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('codex: summary trimmed to 600 chars', () => {
  const d = tmp();
  try { assert.equal(readCodexSession(codexFile(d, { last: 'a'.repeat(2000) })).last_message.length, 600); } finally { rmSync(d, { recursive: true, force: true }); }
});

test('claude: session id, cwd, last assistant text', () => {
  const d = tmp();
  try {
    const f = path.join(d, 'abc.jsonl');
    writeFileSync(f, [
      j({ type: 'user', sessionId: 'abc', cwd: 'F:\\FBS', timestamp: '2026-11-20T01:00:00Z', message: { role: 'user', content: 'oi' } }),
      j({ type: 'assistant', sessionId: 'abc', cwd: 'F:\\FBS', timestamp: '2026-11-20T01:02:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Pronto, PR aberto.' }] } }),
    ].join('\n'));
    const s = readClaudeSession(f);
    assert.deepEqual([s.agent, s.session_id, s.cwd, s.last_message], ['claude', 'abc', 'F:\\FBS', 'Pronto, PR aberto.']);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('index: cache reuses unchanged files', async () => {
  const d = tmp();
  try {
    const f = codexFile(d);
    const cachePath = path.join(d, 'cache.json');
    const first = await indexSessions({ codexHome: d, cachePath });
    assert.equal(first.length, 1);
    const st = new Date('2026-11-25T12:00:00Z');
    utimesSync(f, st, st);
    const before = await indexSessions({ codexHome: d, cachePath }); // re-reads (mtime changed), refreshes cache
    writeFileSync(f, sameSizeEdit(f));
    utimesSync(f, st, st);
    const after = await indexSessions({ codexHome: d, cachePath });
    assert.equal(after[0].last_message, before[0].last_message);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

function sameSizeEdit(f) { return readFileSync(f, 'utf8').replace('Terminei o mix.', 'XXXXXXXXXXXXXXX'); }

test('map: longest root wins, case and slash insensitive', () => {
  const projects = [{ id: 'a', root_path: 'D:\\a' }, { id: 'b', root_path: 'D:\\a\\b' }];
  const sessions = [
    { cwd: 'd:/a/b/c', updated_at: '2026-01-01' },
    { cwd: 'D:\\a', updated_at: '2026-01-02' },
    { cwd: 'D:\\ab', updated_at: '2026-01-03' },
  ];
  const m = mapSessionsToProjects(sessions, projects);
  assert.equal(m.get('b').length, 1); assert.equal(m.get('a').length, 1);
});

test('map: session in a parent folder attaches to its few child projects', () => {
  const projects = [{ id: 'app', root_path: 'D:\\APPS\\X\\app' }, ...['1', '2', '3', '4'].map((n) => ({ id: n, root_path: `D:\\BIG\\p${n}` }))];
  const m = mapSessionsToProjects([{ cwd: 'D:\\APPS\\X', updated_at: '2026-01-01' }, { cwd: 'D:\\BIG', updated_at: '2026-01-01' }], projects);
  assert.equal(m.get('app').length, 1);
  assert.equal(m.has('1'), false);
});
