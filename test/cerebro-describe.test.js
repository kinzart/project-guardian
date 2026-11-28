import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { findDocs, parseDescription, describeProjects, loadDescriptions, descriptionFor } from '../src/cerebro/describe.js';
import { renderCerebroVault } from '../src/obsidian/cerebro.js';

const ANSWER = 'hook: SessionStart ok\n{"o_que_e":"App que separa faixas","feito":"Separação e UI.","comecou":"Script em Python.","agora":"Falta exportar.","maturidade":"quase resolvido","motivo":"falta exportar"}\nhook: Stop';

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cerebro-desc-'));
  const proj = path.join(root, 'SEPARADOR');
  mkdirSync(path.join(proj, 'docs'), { recursive: true });
  mkdirSync(path.join(proj, 'node_modules', 'x'), { recursive: true });
  writeFileSync(path.join(proj, 'notes.md'), 'notas');
  writeFileSync(path.join(proj, 'README.md'), '# Separador');
  writeFileSync(path.join(proj, 'CLAUDE.md'), 'regras');
  writeFileSync(path.join(proj, 'docs', 'plano.md'), 'plano');
  writeFileSync(path.join(proj, 'node_modules', 'x', 'README.md'), 'nope');
  return { root, proj };
}

test('describe: docs found in priority order, node_modules skipped', () => {
  const { root, proj } = fixture();
  try {
    const docs = findDocs(proj).map((d) => d.rel.replace(/\\/g, '/'));
    assert.deepEqual(docs.slice(0, 2), ['README.md', 'CLAUDE.md']);
    assert.ok(docs.includes('docs/plano.md'));
    assert.ok(!docs.some((d) => d.includes('node_modules')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('describe: JSON parsed out of noisy output; maturity normalised', () => {
  assert.equal(parseDescription(ANSWER).maturidade, 'quase resolvido');
  assert.equal(parseDescription('{"o_que_e":"x","maturidade":"100% funcional"}').maturidade, 'resolvido e funcional');
  assert.equal(parseDescription('sem json'), null);
});

test('describe: cached until docs change; note shows the description', async () => {
  const { root, proj } = fixture();
  const cachePath = path.join(root, 'cache.json'); const vault = path.join(root, 'vault');
  try {
    let calls = 0;
    const run = async (_cmd, input) => { calls += 1; assert.match(input, /# Separador/); return { ok: true, out: ANSWER }; };
    const p = { id: 'p1', name: 'SEPARADOR', root_path: proj };
    const empty = { id: 'p2', name: 'Vazio', root_path: path.join(root, 'nada') };
    assert.deepEqual(await describeProjects({ projects: [p, empty], cachePath, run }), { pending: 1, done: 1, failed: 0 });
    await describeProjects({ projects: [p], cachePath, run });
    assert.equal(calls, 1);
    writeFileSync(path.join(proj, 'README.md'), '# Separador v2 mudou');
    await describeProjects({ projects: [p], cachePath, run });
    assert.equal(calls, 2);
    const cache = loadDescriptions(cachePath);
    assert.equal(descriptionFor(cache, p).o_que_e, 'App que separa faixas');
    renderCerebroVault({ vaultPath: vault, projects: [p], roots: [root], descriptions: cache, inventoryOf: null });
    const note = readFileSync(path.join(vault, 'Project Guardian', 'Projetos', 'SEPARADOR.md'), 'utf8');
    assert.match(note, /maturidade: "quase resolvido"/);
    assert.match(note, /## Descrição/); assert.match(note, /\*\*Agora:\*\* Falta exportar\./);
    assert.match(readFileSync(path.join(vault, 'Project Guardian', 'Painel.md'), 'utf8'), /quase resolvido/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
