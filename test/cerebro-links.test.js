import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { nameTokens, findCandidates, decideLinks, parseVerdict, renderAcertos, applyAcertos, linksByProject, loadLinks } from '../src/cerebro/links.js';
import { writeEmptyFolders } from '../src/cerebro/empty.js';
import { describeProjects } from '../src/cerebro/describe.js';

const P = (id, name, root_path) => ({ id, name, root_path });
const projects = [
  P('a', 'BLUES SESSION', 'H:\\Meu Drive\\NOVA KINZART\\BLUES SESSION'),
  P('b', 'blues-session-mix', 'D:\\MUSICA\\blues-session-mix'),
  P('c', 'Lusco Fusco', 'H:\\Meu Drive\\NOVA KINZART\\Lusco Fusco'),
  P('d', 'SHOW LUSCO', 'E:\\VIDEOS\\SHOW LUSCO'),
  P('e', 'Orçamentos', 'D:\\DOCS\\Orçamentos'),
  P('f', 'clipe', 'D:\\VIDEOS\\clipe'),
  P('g', 'brutos', 'H:\\Meu Drive\\CAPCUT\\brutos'),
];
const inv = {
  'd:/videos/clipe': { files: ['take1.mov|500000', 'take2.mov|600000', 'take3.mov|700000'], days: { '2026-10-01': 3 } },
  'h:/meu drive/capcut/brutos': { files: ['take1.mov|500000', 'take2.mov|600000', 'take3.mov|700000'], days: { '2026-10-01': 1 } },
  'h:/meu drive/nova kinzart/lusco fusco': { files: [], days: { '2026-09-01': 2, '2026-09-02': 1 } },
  'e:/videos/show lusco': { files: [], days: { '2026-09-01': 4, '2026-09-02': 1 } },
};

test('links: tokens skip generic words and accents', () => {
  assert.deepEqual(nameTokens('Nova pasta de Orçamentos final v2'), ['orcamentos']);
});

test('links: identical files and equal names are obvious; shared name + days are likely', () => {
  const c = findCandidates(projects, inv);
  const by = (x, y) => c.find((k) => [k.a.id, k.b.id].sort().join() === [x, y].sort().join());
  assert.equal(by('f', 'g').level, 'provavel'); // identical files but no name in common: AI decides
  assert.equal(by('f', 'g').sharedFiles, 3);
  assert.equal(by('a', 'b').level, 'obvio');
  assert.equal(by('c', 'd').level, 'provavel');
  assert.equal(by('c', 'd').sharedDays, 2);
  assert.equal(by('a', 'e'), undefined);
});

test('links: AI decides likely pairs, second opinion on "talvez", person decides in Acertos', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cerebro-links-'));
  try {
    const cachePath = path.join(dir, 'l.json'); const acertos = path.join(dir, 'Acertos.md');
    const calls = [];
    const run = async (cmd) => { calls.push(cmd); return { ok: true, out: cmd === 'luna' ? 'x {"relacao":"talvez","motivo":"pode ser"} y' : '{"relacao":"talvez","motivo":"incerto"}' }; };
    const c = findCandidates(projects, inv);
    const stats = await decideLinks({ candidates: c, cachePath, inv, command: 'luna', secondCommand: 'forte', run });
    assert.equal(stats.talvez, 2); assert.equal(calls.filter((c) => c === 'forte').length, 2);
    let data = loadLinks(cachePath);
    assert.equal(linksByProject(data, projects).get('a')[0].q.id, 'b');
    const link = (p) => `[[${p.name}]]`;
    assert.equal(renderAcertos({ file: acertos, data, projects, link }), 2);
    const text = readFileSync(acertos, 'utf8');
    assert.match(text, /- \[ \] \[\[SHOW LUSCO\]\]/); assert.match(text, /- \[ \] nenhum · `-`/);
    writeFileSync(acertos, text.replace('- [ ] [[SHOW LUSCO]]', '- [x] [[SHOW LUSCO]]'));
    assert.equal(applyAcertos(acertos, data), 1);
    assert.equal(linksByProject(data, projects).get('c')[0].q.id, 'd');
    // a re-run keeps the person's decision and asks no AI
    const again = await decideLinks({ candidates: c, cachePath: path.join(dir, 'l2.json'), inv, command: 'luna', run });
    assert.equal(again.ia, 2);
    data.pairs[Object.keys(data.pairs).find((k) => data.pairs[k].pessoa)].sig = 'x';
    assert.equal(renderAcertos({ file: acertos, data, projects, link }), 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('links: verdict parsing', () => {
  assert.equal(parseVerdict('{"relacao":"Não","motivo":"x"}').relacao, 'nao');
  assert.equal(parseVerdict('nada'), null);
});

test('empty folders: listed for review, ticks kept across renders', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cerebro-empty-'));
  try {
    const file = path.join(dir, 'Pastas vazias.md');
    const ps = [P('x', 'Vazio', 'D:\\A\\Vazio'), P('y', 'Cheio', 'D:\\A\\Cheio')];
    const summaries = { 'd:/a/vazio': { total: 0 }, 'd:/a/cheio': { total: 3, emptyDirs: ['sub'] } };
    assert.equal(writeEmptyFolders({ file, projects: ps, summaries }), 2);
    writeFileSync(file, readFileSync(file, 'utf8').replace('- [ ] apagar: `D:\\A\\Vazio`', '- [x] apagar: `D:\\A\\Vazio`'));
    writeEmptyFolders({ file, projects: ps, summaries });
    assert.match(readFileSync(file, 'utf8'), /- \[x\] apagar: `D:\\A\\Vazio`/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('describe: folders without docs are described from their file listing', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cerebro-list-'));
  try {
    const p = P('z', 'SHOW', dir);
    let prompt = '';
    const run = async (_c, input) => { prompt = input; return { ok: true, out: '{"o_que_e":"Show gravado","maturidade":"inacabado"}' }; };
    const inventory = { [dir.toLowerCase().replace(/\\/g, '/')]: { total: 3, newest: '2026-01-01', types: { video: 3 }, sample: ['brutos/take1.mov'] } };
    const stats = await describeProjects({ projects: [p], cachePath: path.join(dir, 'c.json'), run, inventory });
    assert.equal(stats.done, 1); assert.match(prompt, /brutos\/take1\.mov/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
