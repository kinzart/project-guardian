import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildInventoryDigest, runSuggestions, PROMPT } from '../src/cerebro/suggest.js';
import { installRule, removeRule, RULE_START } from '../src/cerebro/rule.js';

test('digest: one line per project, newest first, duplicates listed', () => {
  const projects = [
    { id: 'a', name: 'Old', kind: 'music', root_path: 'F:\\Old', latest_entry: { mtime: '2024-01-01T00:00:00Z' } },
    { id: 'b', name: 'New', kind: 'code', root_path: 'D:\\New', latest_entry: { mtime: '2026-11-01T00:00:00Z' } },
  ];
  const d = buildInventoryDigest(projects, new Map([['b', [{ agent: 'codex', updated_at: '2026-11-02T00:00:00Z' }]]]), [{ projects }]);
  const lines = d.split('\n');
  assert.equal(lines[1], 'New | código | 2026-11-02 | codex 2026-11-02 | D:\\New');
  assert.match(lines[2], /^Old \| música \| 2024-01-01/);
  assert.match(d, /F:\\Old  ==  D:\\New/);
});

function fakeSpawn({ stdout = '', code = 0 }) {
  return (cmd, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = { end: (input) => { child.input = input; setImmediate(() => { child.stdout.emit('data', stdout); child.emit('close', code); }); } };
    fakeSpawn.last = { cmd, opts, child };
    return child;
  };
}

test('suggest: writes AI answer into Sugestões.md, prompt + digest on stdin', async () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'cerebro-s-'));
  try {
    const out = path.join(d, 'Sugestões.md');
    writeFileSync(out, 'notas minhas\n');
    const r = await runSuggestions({ command: 'codex exec -', digest: 'DIGEST', outPath: out, spawnImpl: fakeSpawn({ stdout: '## Retomar primeiro\n- Slides' }) });
    assert.equal(r.ok, true);
    const text = readFileSync(out, 'utf8');
    assert.match(text, /## Retomar primeiro/); assert.match(text, /notas minhas/);
    assert.ok(fakeSpawn.last.child.input.startsWith(PROMPT)); assert.match(fakeSpawn.last.child.input, /DIGEST$/);
    assert.equal(fakeSpawn.last.opts.shell, true);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('suggest: failure is recorded, not thrown', async () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'cerebro-s-'));
  try {
    const out = path.join(d, 'S.md');
    const r = await runSuggestions({ command: 'x', digest: '', outPath: out, spawnImpl: fakeSpawn({ code: 2 }) });
    assert.equal(r.ok, false); assert.match(readFileSync(out, 'utf8'), /Falhou/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('rule: install is idempotent and remove restores original', () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'cerebro-r-'));
  try {
    const f = path.join(d, 'AGENTS.md');
    writeFileSync(f, '# Minhas regras\n- uma\n');
    assert.equal(installRule(f, 'D:\\CEREBRO'), true);
    assert.equal(installRule(f, 'D:\\CEREBRO'), false);
    const text = readFileSync(f, 'utf8');
    assert.equal(text.split(RULE_START).length - 1, 1); assert.match(text, /D:\\CEREBRO\\Caixa de entrada/);
    assert.equal(removeRule(f), true);
    assert.equal(readFileSync(f, 'utf8'), '# Minhas regras\n- uma\n');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
