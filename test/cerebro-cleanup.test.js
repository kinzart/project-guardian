import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { cleanup, refusalReason, sendToRecycleBin } from '../src/cerebro/cleanup.js';
import { renderCerebroVault, readDeleteMark } from '../src/obsidian/cerebro.js';

const now = Date.parse('2026-11-27T12:00:00Z');
const P = (id, name, root_path) => ({ id, name, root_path, kind: 'music', latest_entry: { name: 'a.wav', mtime: '2026-11-26T00:00:00Z' }, status: {} });

test('excluir property: ticking it survives re-render and shows on the Painel', () => {
  const v = mkdtempSync(path.join(os.tmpdir(), 'cerebro-x-')); mkdirSync(path.join(v, '.obsidian'));
  try {
    const projects = [P('a', 'Album', 'F:\\Album'), P('b', 'Outro', 'F:\\Outro')];
    renderCerebroVault({ vaultPath: v, projects, roots: ['F:\\'], now });
    const f = path.join(v, 'Project Guardian', 'Projetos', 'Album.md');
    assert.match(readFileSync(f, 'utf8'), /^excluir: false$/m);
    writeFileSync(f, readFileSync(f, 'utf8').replace('excluir: false', 'excluir: true'));
    const g = path.join(v, 'Project Guardian', 'Projetos', 'Outro.md');
    writeFileSync(g, `${readFileSync(g, 'utf8')}\nnão serve mais #apagar\n`);
    const r = renderCerebroVault({ vaultPath: v, projects, roots: ['F:\\'], now });
    assert.deepEqual(r.marked.map((p) => p.id).sort(), ['a', 'b']);
    assert.match(readFileSync(f, 'utf8'), /^excluir: true$/m);
    assert.match(readFileSync(path.join(v, 'Project Guardian', 'Painel.md'), 'utf8'), /## Marcados para excluir \(2\)/);
  } finally { rmSync(v, { recursive: true, force: true }); }
});

test('delete mark: #apagar inside the generated block does not count', () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'cerebro-x-'));
  try {
    const f = path.join(d, 'n.md');
    writeFileSync(f, '---\nexcluir: false\n---\n<!-- >>> PROJECT GUARDIAN GENERATED >>> -->\nAI said #apagar\n<!-- <<< PROJECT GUARDIAN GENERATED <<< -->\n');
    assert.equal(readDeleteMark(f), false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('refusals: drive root, scanned root, unmarked projects inside', () => {
  const projects = [P('a', 'Pai', 'D:\\APPS'), P('b', 'Filho', 'D:\\APPS\\Filho'), P('c', 'Solo', 'D:\\Solo')];
  const roots = ['D:\\', 'G:\\Meu Drive'];
  assert.match(refusalReason(P('x', 'x', 'D:\\'), { roots, projects }), /raiz|varridas/);
  assert.match(refusalReason(P('x', 'x', 'G:\\Meu Drive'), { roots, projects }), /varridas/);
  assert.match(refusalReason(projects[0], { roots, projects }), /Filho/);
  assert.equal(refusalReason(projects[0], { roots, projects, markedIds: new Set(['a', 'b']) }), null);
  assert.equal(refusalReason(projects[2], { roots, projects }), null);
});

test('cleanup: without confirm nothing is recycled; with confirm only safe ones', () => {
  const projects = [P('a', 'Pai', 'D:\\APPS'), P('b', 'Filho', 'D:\\APPS\\Filho'), P('c', 'Solo', 'D:\\Solo')];
  const calls = [];
  const recycle = (p) => { calls.push(p); return { ok: true }; };
  const dry = cleanup([projects[0], projects[2]], { roots: ['D:\\'], projects, recycle });
  assert.deepEqual(dry.map((r) => r.action), ['recusado', 'pendente']); assert.equal(calls.length, 0);
  const real = cleanup([projects[0], projects[2]], { roots: ['D:\\'], projects, confirm: true, recycle });
  assert.deepEqual(real.map((r) => r.action), ['recusado', 'lixeira']); assert.deepEqual(calls, ['D:\\Solo']);
});

test('recycle: refuses off Windows and passes the path via env, not the command line', () => {
  assert.equal(sendToRecycleBin('C:\\x', { platform: 'linux' }).ok, false);
  const d = mkdtempSync(path.join(os.tmpdir(), 'cerebro "x & y'));
  try {
    let seen;
    sendToRecycleBin(d, { platform: 'win32', spawnImpl: (cmd, args, opts) => { seen = { cmd, args, opts }; return { status: 0 }; } });
    assert.equal(seen.cmd, 'powershell.exe'); assert.ok(!seen.args.join(' ').includes(d)); assert.equal(seen.opts.env.CEREBRO_TARGET, d);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
