import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { inventoryFolder, typeOf, formatSize } from '../src/cerebro/inventory.js';
import { renderCerebroVault } from '../src/obsidian/cerebro.js';

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cerebro-inv-'));
  const proj = path.join(root, 'Clipe');
  mkdirSync(path.join(proj, 'Brutos'), { recursive: true });
  mkdirSync(path.join(proj, 'node_modules', 'x'), { recursive: true });
  writeFileSync(path.join(proj, 'Brutos', 'take1.mp4'), 'v'.repeat(2048));
  writeFileSync(path.join(proj, 'capa.png'), 'p');
  writeFileSync(path.join(proj, 'mix.flp'), 'f');
  writeFileSync(path.join(proj, 'orcamento.xlsx'), 'x');
  writeFileSync(path.join(proj, 'node_modules', 'x', 'index.js'), 'n');
  return { root, proj };
}

test('inventory: types, sizes, folders; machine folders skipped', () => {
  const { root, proj } = fixture();
  try {
    const inv = inventoryFolder(proj);
    assert.equal(inv.total, 4);
    assert.deepEqual([...inv.byType.keys()].sort(), ['imagem', 'musica', 'planilha', 'video']);
    assert.equal(inv.folders.get('Brutos').count, 1);
    assert.ok(inv.skipped.some((s) => s.includes('node_modules')));
    assert.equal(inventoryFolder(path.join(root, 'nao-existe')), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('inventory: helpers', () => {
  assert.equal(typeOf('A.MOV').type, 'video');
  assert.equal(typeOf('x.unknown').type, 'outro');
  assert.equal(formatSize(1536 * 1024 * 1024), '1,5 GB');
});

test('vault: project note lists files, gallery, videos and a full list page', () => {
  const { root, proj } = fixture();
  const vault = path.join(root, 'vault');
  try {
    const p = { id: 'p1', name: 'Clipe', root_path: proj, kind: 'video', metadata_only: false };
    renderCerebroVault({ vaultPath: vault, projects: [p], roots: [root] });
    const note = readFileSync(path.join(vault, 'Project Guardian', 'Projetos', 'Clipe.md'), 'utf8');
    assert.match(note, /## Arquivos \(4 · /);
    assert.match(note, /\| Vídeo \| 1 \|/);
    assert.match(note, /!\[capa\.png\|160\]\(file:\/\/\//);
    assert.match(note, /\*\*Vídeos \(1\)\*\*/);
    assert.match(note, /tags: \[.*"tem\/video".*\]/);
    assert.match(note, /Lista completa de arquivos/);
    const full = readFileSync(path.join(vault, 'Project Guardian', 'Arquivos', 'Clipe.md'), 'utf8');
    assert.match(full, /## Brutos/); assert.match(full, /take1\.mp4/);
    renderCerebroVault({ vaultPath: vault, projects: [], roots: [root] });
    assert.equal(existsSync(path.join(vault, 'Project Guardian', 'Arquivos', 'Clipe.md')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
