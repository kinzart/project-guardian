import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { groupProjects, isLooseMedia } from '../src/cerebro/grouping.js';
import { renderCerebroVault } from '../src/obsidian/cerebro.js';

const base = (id, root_path, evidence, mtime) => ({ id, name: path.basename(root_path.replace(/\\/g, '/')), root_path, kind: 'music', evidence, latest_entry: { name: 'x', mtime }, status: {} });
const media = (id, p, mtime = '2026-11-18T00:00:00Z') => base(id, p, ['secondary:media(+10)'], mtime);
const real = (id, p, mtime = '2026-11-10T00:00:00Z') => base(id, p, ['strong:.git(+50)'], mtime);
const roots = ['D:\\', 'F:\\'];

test('loose media detection', () => {
  assert.equal(isLooseMedia(media('a', 'F:\\X')), true);
  assert.equal(isLooseMedia(real('b', 'F:\\Y')), false);
});

test('area folders group projects; everything deeper is content', () => {
  const projects = [
    media('r1', 'D:\\APPS E PROGRAMAS\\PLATAFORMA\\SAIDAS\\Sessoes\\RICK CASTELLO\\Faixas cortadas\\uirec-20261118_040606'),
    media('r2', 'D:\\APPS E PROGRAMAS\\PLATAFORMA\\SAIDAS\\Sessoes\\LUIZ\\Faixas cortadas\\uirec-20261125_042239', '2026-11-25T00:00:00Z'),
    real('sep', 'D:\\APPS E PROGRAMAS\\PLATAFORMA\\SEPARADOR'),
    real('cort', 'D:\\APPS E PROGRAMAS\\CORTADOR'),
    real('s1', 'D:\\HOSTINGER SITES\\site1\\public_html\\wp-content\\plugins\\a\\sodium_compat'),
    real('s2', 'D:\\HOSTINGER SITES\\site1\\public_html\\wp-content\\plugins\\b\\sodium_compat'),
    real('mma', 'F:\\MIX MASTER AUTO'),
    media('mmaRec', 'F:\\MIX MASTER AUTO\\renders\\take1'),
  ];
  const { items, childrenOf, areaOf } = groupProjects(projects, roots);
  const names = items.map((i) => i.name).sort();
  assert.deepEqual(names, ['CORTADOR', 'MIX MASTER AUTO', 'PLATAFORMA', 'site1']);
  const plat = items.find((i) => i.name === 'PLATAFORMA');
  assert.deepEqual(childrenOf.get(plat.id).map((c) => c.id).sort(), ['r1', 'r2', 'sep']);
  assert.equal(plat.latest_entry.mtime, '2026-11-25T00:00:00Z');
  assert.equal(areaOf.get(plat.id), 'D:\\APPS E PROGRAMAS');
  assert.equal(childrenOf.get('mma').length, 1);
  assert.equal(items.find((i) => i.name === 'site1').kind, 'music');
});

test('agent sessions inside an area create the project folder; area-level sessions do not', () => {
  const { items } = groupProjects([], roots, [
    { cwd: 'D:\\APPS E PROGRAMAS\\APLICATIVO DE SLIDES\\src', agent: 'codex' },
    { cwd: 'D:\\APPS E PROGRAMAS', agent: 'claude' },
    { cwd: 'C:\\Users\\kinza', agent: 'claude' },
  ]);
  assert.deepEqual(items.map((i) => i.name), ['APLICATIVO DE SLIDES']);
  assert.equal(items[0].kind, 'code');
});

test('vault: project note shows content with relative paths and its area', () => {
  const v = mkdtempSync(path.join(os.tmpdir(), 'cerebro-g-')); mkdirSync(path.join(v, '.obsidian'));
  try {
    const { items, childrenOf, areaOf } = groupProjects([
      media('r1', 'D:\\APPS E PROGRAMAS\\PLATAFORMA\\SAIDAS\\Sessoes\\RICK CASTELLO\\Faixas cortadas\\uirec-20261118_040606'),
    ], roots);
    renderCerebroVault({ vaultPath: v, projects: items, childrenOf, areaByItem: areaOf, roots, now: Date.parse('2026-11-27T00:00:00Z') });
    const note = readFileSync(path.join(v, 'Project Guardian', 'Projetos', 'PLATAFORMA.md'), 'utf8');
    assert.match(note, /## Está dentro de\n- \[`D:\\APPS E PROGRAMAS`\]/);
    assert.match(note, /\[SAIDAS › Sessoes › RICK CASTELLO › Faixas cortadas › uirec-20261118_040606\]/);
    assert.doesNotMatch(readFileSync(path.join(v, 'Project Guardian', 'Painel.md'), 'utf8'), /uirec/);
  } finally { rmSync(v, { recursive: true, force: true }); }
});

test('a container holding several real projects becomes an area itself', () => {
  const projects = [
    real('mm', 'D:\\APPS E PROGRAMAS\\PLATAFORMA\\MIX MASTER'),
    real('co', 'D:\\APPS E PROGRAMAS\\PLATAFORMA\\CORTADOR'),
    media('rec', 'D:\\APPS E PROGRAMAS\\PLATAFORMA\\SAIDAS\\Sessoes\\LUIZ\\Faixas cortadas\\uirec-1'),
    real('sub', 'D:\\APPS E PROGRAMAS\\PLATAFORMA\\MIX MASTER\\engine'),
  ];
  const { items, childrenOf, areaOf } = groupProjects(projects, roots);
  assert.deepEqual(items.map((i) => i.name).sort(), ['CORTADOR', 'MIX MASTER', 'PLATAFORMA']);
  assert.deepEqual(childrenOf.get(items.find((i) => i.name === 'PLATAFORMA').id).map((c) => c.id), ['rec']);
  assert.equal(areaOf.get('mm'), 'D:\\APPS E PROGRAMAS\\PLATAFORMA');
  assert.deepEqual(childrenOf.get('mm').map((c) => c.id), ['sub']);
});

test('vault: ignorar hides a project in its own section', () => {
  const v = mkdtempSync(path.join(os.tmpdir(), 'cerebro-i-')); mkdirSync(path.join(v, '.obsidian'));
  try {
    const items = [real('st', 'D:\\STEAM', '2026-11-26T00:00:00Z')];
    renderCerebroVault({ vaultPath: v, projects: items, roots, now: Date.parse('2026-11-27T00:00:00Z') });
    const f = path.join(v, 'Project Guardian', 'Projetos', 'STEAM.md');
    writeFileSync(f, readFileSync(f, 'utf8').replace('ignorar: false', 'ignorar: true'));
    renderCerebroVault({ vaultPath: v, projects: items, roots, now: Date.parse('2026-11-27T00:00:00Z') });
    const painel = readFileSync(path.join(v, 'Project Guardian', 'Painel.md'), 'utf8');
    assert.match(painel, /## Em andamento \(0\)/); assert.match(painel, /## Ignorados \(1\)[\s\S]*STEAM/);
    assert.match(readFileSync(f, 'utf8'), /^ignorar: true$/m);
  } finally { rmSync(v, { recursive: true, force: true }); }
});

test('agent work folders count as real projects inside a container', () => {
  const { items } = groupProjects([real('mm', 'D:\\APPS\\PLATAFORMA\\MIX MASTER')], roots, [{ cwd: 'D:\\APPS\\PLATAFORMA\\SEPARADOR' }]);
  assert.deepEqual(items.map((i) => i.name).sort(), ['MIX MASTER', 'SEPARADOR']);
});
