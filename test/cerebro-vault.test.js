import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { renderCerebroVault } from '../src/obsidian/cerebro.js';

const now = Date.parse('2026-11-27T12:00:00Z');
const day = 86400000;
const iso = (d) => new Date(now - d * day).toISOString();
const P = (id, name, root_path, d, extra = {}) => ({ id, name, root_path, kind: 'music', latest_entry: { name: 'mix.song', mtime: iso(d) }, status: { completion_state: 'IN_PROGRESS' }, ...extra });

function vault() { const v = mkdtempSync(path.join(os.tmpdir(), 'cerebro-vault-')); mkdirSync(path.join(v, '.obsidian')); return v; }
const read = (v, rel) => readFileSync(path.join(v, 'Project Guardian', rel), 'utf8');

test('vault: sections by recency, archive, frontmatter and resume link', () => {
  const v = vault();
  try {
    const projects = [P('a', 'Album Novo', 'F:\\MIX\\Album Novo', 2), P('b', 'Slides', 'D:\\APPS\\Slides', 30, { kind: 'code' }), P('c', 'Velho', 'D:\\APPS\\Velho', 500)];
    const sessions = new Map([['b', [{ agent: 'codex', session_id: 'th-9', cwd: 'D:\\APPS\\Slides', updated_at: iso(30), last_message: 'Falta o export.', title: 'Exportar slides' }]]]);
    renderCerebroVault({ vaultPath: v, projects, sessionsByProject: sessions, roots: ['F:\\', 'D:\\'], now });
    const painel = read(v, 'Painel.md');
    assert.match(painel, /## Em andamento \(1\)[\s\S]*Album Novo/);
    assert.match(painel, /## Dá pra retomar \(1\)[\s\S]*Slides[\s\S]*Codex/);
    assert.match(painel, /## Arquivo — não mexer \(1\)[\s\S]*Velho/);
    const note = read(v, 'Projetos/Slides.md');
    assert.ok(note.startsWith('---\nstatus: "dá pra retomar"'));
    assert.match(note, /ultima_ia: "Codex"/);
    assert.match(note, /> Falta o export\./);
    assert.match(note, /\[▶ Retomar esta sessão\]\(file:\/\/\/.*codex-th-9\.cmd\)/);
    assert.ok(existsSync(path.join(v, '_retomar', 'codex-th-9.cmd')));
    assert.match(read(v, 'Mapa.md'), /## F:[\s\S]*\*\*MIX\*\*[\s\S]*Album Novo/);
  } finally { rmSync(v, { recursive: true, force: true }); }
});

test('vault: manual notes survive re-render; frontmatter refreshed', () => {
  const v = vault();
  try {
    const projects = [P('a', 'Album', 'F:\\Album', 2)];
    renderCerebroVault({ vaultPath: v, projects, roots: ['F:\\'], now });
    const f = path.join(v, 'Project Guardian', 'Projetos', 'Album.md');
    writeFileSync(f, readFileSync(f, 'utf8').replace('## Minhas notas\n', '## Minhas notas\nlembrar do baixo\n'));
    renderCerebroVault({ vaultPath: v, projects: [P('a', 'Album', 'F:\\Album', 40)], roots: ['F:\\'], now });
    const text = readFileSync(f, 'utf8');
    assert.match(text, /lembrar do baixo/); assert.match(text, /status: "dá pra retomar"/);
    assert.equal((text.match(/^---$/gm) || []).length, 2);
  } finally { rmSync(v, { recursive: true, force: true }); }
});

test('vault: odd names and missing data render placeholders', () => {
  const v = vault();
  try {
    const projects = [{ id: 'x', name: 'Ação: "teste" | 2026?', root_path: 'E:\\Ação', status: {} }];
    renderCerebroVault({ vaultPath: v, projects, roots: [], now });
    const files = readFileSync(path.join(v, 'Project Guardian', 'Painel.md'), 'utf8');
    assert.doesNotMatch(files, /undefined|NaN|Invalid Date/);
    const note = read(v, 'Projetos/Ação- -teste- - 2026-.md');
    assert.doesNotMatch(note, /undefined|NaN|Invalid Date/);
    assert.match(note, /## Última IA\n—/);
  } finally { rmSync(v, { recursive: true, force: true }); }
});

test('vault: duplicates page lists groups', () => {
  const v = vault();
  try {
    renderCerebroVault({ vaultPath: v, projects: [P('a', 'Mix Master', 'F:\\Mix Master', 3), P('b', 'Mix Master (1)', 'D:\\Mix Master (1)', 200)], roots: ['F:\\', 'D:\\'], now });
    const d = read(v, 'Duplicados.md');
    assert.match(d, /F:\\Mix Master/); assert.match(d, /D:\\Mix Master \(1\)/);
    assert.match(read(v, 'Projetos/Mix Master.md'), /## Relacionados\n- \[\[/);
  } finally { rmSync(v, { recursive: true, force: true }); }
});

import { obsidianCommand } from '../src/cli/commands/obsidian.js';
import { JsonFileStore } from '../src/store/JsonFileStore.js';

test('cli: guardian obsidian render builds the Cérebro vault with agent sessions', async () => {
  const v = vault(); const home = mkdtempSync(path.join(os.tmpdir(), 'cerebro-home-'));
  const prevCodex = process.env.CODEX_HOME; process.env.CODEX_HOME = path.join(home, '.codex');
  try {
    const dir = path.join(home, '.codex', 'sessions', '2026', '11', '26'); mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'r.jsonl'), `${JSON.stringify({ timestamp: '2026-11-26T10:00:00Z', type: 'session_meta', payload: { id: 'th-1', cwd: 'D:\\Proj\\sub' } })}\n${JSON.stringify({ timestamp: '2026-11-26T10:05:00Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Feito.' } })}\n`);
    mkdirSync(path.join(home, 'data'));
    const store = new JsonFileStore(path.join(home, 'data', 'db.json')); await store.init();
    await store.upsertProject({ id: 'p1', name: 'Proj', root_path: 'D:\\Proj', status: { activity_state: 'WARM', completion_state: 'IN_PROGRESS' }, last_file_activity: '2026-11-20T00:00:00Z' });
    const config = { obsidian: { vaultPath: v }, scanRoots: ['D:\\'], cerebro: { archiveDays: 365, claudeHome: path.join(home, 'none'), hermesHome: path.join(home, 'none') }, activityThresholds: { activeHours: 48, warmDays: 7, staleDays: 30 } };
    const result = await obsidianCommand({ projectRoot: home, args: ['render'], store, config });
    assert.equal(result.projectsRendered, 1);
    assert.match(read(v, 'Projetos/Proj.md'), /ultima_ia: "Codex"[\s\S]*> Feito\./);
  } finally {
    if (prevCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevCodex;
    rmSync(v, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
  }
});

test('vault: notes of projects that disappeared move to Removidos with manual notes intact', () => {
  const v = vault();
  try {
    renderCerebroVault({ vaultPath: v, projects: [P('a', 'Album', 'F:\\Album', 2), P('b', 'Gone', 'F:\\Gone', 2)], roots: ['F:\\'], now });
    const f = path.join(v, 'Project Guardian', 'Projetos', 'Gone.md');
    writeFileSync(f, `${readFileSync(f, 'utf8')}minha nota\n`);
    writeFileSync(path.join(v, 'Project Guardian', 'Projetos', 'Manual.md'), 'nota feita à mão');
    const r = renderCerebroVault({ vaultPath: v, projects: [P('a', 'Album', 'F:\\Album', 2)], roots: ['F:\\'], now });
    assert.equal(r.removed, 1);
    assert.equal(existsSync(f), false);
    assert.match(read(v, 'Removidos/Gone.md'), /minha nota/);
    assert.ok(existsSync(path.join(v, 'Project Guardian', 'Projetos', 'Manual.md')));
  } finally { rmSync(v, { recursive: true, force: true }); }
});
