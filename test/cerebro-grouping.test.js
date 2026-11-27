import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { groupProjects, isLooseMedia } from '../src/cerebro/grouping.js';
import { renderCerebroVault } from '../src/obsidian/cerebro.js';

const media = (id, root_path, mtime = '2026-11-18T00:00:00Z') => ({ id, name: path.basename(root_path.replace(/\\/g, '/')), root_path, kind: 'music', evidence: ['secondary:media(+10)'], latest_entry: { name: 'a.wav', mtime }, status: {} });
const real = (id, root_path) => ({ id, name: path.basename(root_path.replace(/\\/g, '/')), root_path, kind: 'music', evidence: ['strong:mix.song(+30)'], latest_entry: { name: 'mix.song', mtime: '2026-11-10T00:00:00Z' }, status: {} });

test('loose media folders are not projects', () => {
  assert.equal(isLooseMedia(media('a', 'F:\\X')), true);
  assert.equal(isLooseMedia(real('b', 'F:\\Y')), false);
  assert.equal(isLooseMedia({ id: 'c' }), false);
});

test('recordings go inside the nearest real project, else the first-level folder', () => {
  const projects = [
    real('castelo', 'F:\\MUSICA\\Saida do Castelo'),
    media('r1', 'F:\\MUSICA\\Saida do Castelo\\gravacoes\\uirec-20261118_040606'),
    media('r2', 'F:\\MUSICA\\Saida do Castelo\\gravacoes\\uirec-20261125_042239'),
    media('f1', 'F:\\PIC 2026\\viagem\\dia1'),
    media('f2', 'F:\\PIC 2026\\viagem\\dia2', '2026-11-20T00:00:00Z'),
    real('sub', 'F:\\MUSICA\\Saida do Castelo\\stems'),
  ];
  const { items, childrenOf, parentOf } = groupProjects(projects, ['F:\\']);
  const names = items.map((i) => i.name).sort();
  assert.deepEqual(names, ['PIC 2026', 'Saida do Castelo', 'stems']);
  assert.deepEqual(childrenOf.get('castelo').map((c) => c.id).sort(), ['r1', 'r2']);
  const pic = items.find((i) => i.name === 'PIC 2026');
  assert.equal(pic.is_folder, true); assert.equal(pic.root_path, 'F:\\PIC 2026');
  assert.equal(childrenOf.get(pic.id).length, 2); assert.equal(pic.latest_entry.mtime, '2026-11-20T00:00:00Z');
  assert.equal(parentOf.get('sub').id, 'castelo');
});

test('vault: parent note lists its content and the child says where it lives', () => {
  const v = mkdtempSync(path.join(os.tmpdir(), 'cerebro-g-')); mkdirSync(path.join(v, '.obsidian'));
  try {
    const { items, childrenOf, parentOf } = groupProjects([
      real('castelo', 'F:\\MUSICA\\Saida do Castelo'), real('sub', 'F:\\MUSICA\\Saida do Castelo\\stems'),
      media('r1', 'F:\\MUSICA\\Saida do Castelo\\gravacoes\\uirec-20261118_040606'),
    ], ['F:\\']);
    renderCerebroVault({ vaultPath: v, projects: items, childrenOf, parentOf, roots: ['F:\\'], now: Date.parse('2026-11-27T00:00:00Z') });
    const read = (f) => readFileSync(path.join(v, 'Project Guardian', f), 'utf8');
    assert.match(read('Projetos/Saida do Castelo.md'), /## Conteúdo \(1 pastas\)\n- \[uirec-20261118_040606\]/);
    assert.match(read('Projetos/stems.md'), /## Está dentro de\n- \[\[Project Guardian\/Projetos\/Saida do Castelo\|/);
    assert.doesNotMatch(read('Painel.md'), /uirec/);
    assert.match(read('Mapa.md'), /- \[\[[^\n]*Saida do Castelo[^\n]*\n    - \[\[[^\n]*stems/);
  } finally { rmSync(v, { recursive: true, force: true }); }
});
