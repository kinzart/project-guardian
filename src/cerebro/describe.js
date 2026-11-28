// Project descriptions for the Cérebro: when a project has .md docs (README, CLAUDE.md, AGENTS.md,
// notes, docs/), a cheap AI reads them and writes what the project is, what was done, where it started,
// where it is now and how finished it is. Results are cached by the docs' size+date, so a project is
// only re-read when its docs change. The AI runs read-only and only receives the text of the docs.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_DESCRIBE_COMMAND = 'codex exec --skip-git-repo-check -s read-only -m gpt-6-luna -c model_reasoning_effort="low" -';
export const MATURITY = ['inacabado', 'quase resolvido', 'resolvido e funcional', 'não dá pra saber'];

const DOC_EXT = new Set(['.md', '.markdown', '.mdx']);
const PRIORITY = [/^readme/i, /^(claude|agents|gemini|copilot-instructions|cursorrules)\b/i, /^(status|progress|progresso|todo|roadmap|changelog|handoff|notes|notas)/i];
const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', 'vendor', 'site-packages']);
const DOC_DIRS = new Set(['docs', 'doc', '.claude', '.github', 'notes', 'notas', 'specs', 'plans']);

// Finds the project's docs: .md files at the root and inside doc-like folders (two levels).
export function findDocs(root, { maxFiles = 12 } = {}) {
  const found = [];
  const walk = (dir, rel, depth, inDocs) => {
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) {
        if (SKIP.has(e.name.toLowerCase()) || depth >= 2) continue;
        if (DOC_DIRS.has(e.name.toLowerCase()) || inDocs) walk(path.join(dir, e.name), r, depth + 1, true);
        continue;
      }
      if (!e.isFile() || !DOC_EXT.has(path.extname(e.name).toLowerCase())) continue;
      let st; try { st = statSync(path.join(dir, e.name)); } catch { continue; }
      const rank = PRIORITY.findIndex((re) => re.test(e.name));
      found.push({ rel: r, size: st.size, mtime: st.mtime.toISOString(), rank: (rank < 0 ? PRIORITY.length : rank) + depth });
    }
  };
  walk(root, '', 0, false);
  return found.sort((a, b) => a.rank - b.rank || b.mtime.localeCompare(a.mtime)).slice(0, maxFiles);
}

export const docsKey = (docs) => docs.map((d) => `${d.rel}:${d.size}:${d.mtime}`).join('|');

export function readDocs(root, docs, { maxBytes = 24 * 1024 } = {}) {
  let left = maxBytes; const parts = [];
  for (const d of docs) {
    if (left <= 0) break;
    let text; try { text = readFileSync(path.join(root, d.rel), 'utf8'); } catch { continue; }
    const cut = Buffer.from(text).subarray(0, Math.min(left, 8 * 1024)).toString('utf8');
    parts.push(`=== ${d.rel} (modificado ${d.mtime.slice(0, 10)}) ===\n${cut}${cut.length < text.length ? '\n(… cortado)' : ''}`);
    left -= Buffer.byteLength(cut);
  }
  return parts.join('\n\n');
}

export function buildPrompt(project, docsText) {
  return `Você descreve projetos para o "Cérebro", o painel de projetos do Paixão. Leia os documentos do projeto abaixo e responda SÓ com um JSON, sem nada antes ou depois:
{"o_que_e": "uma frase dizendo o que é o projeto",
 "feito": "o que já foi feito (2 a 4 frases)",
 "comecou": "onde/como começou",
 "agora": "onde está agora e o que falta",
 "maturidade": "inacabado" | "quase resolvido" | "resolvido e funcional" | "não dá pra saber",
 "motivo": "por que essa maturidade, em uma frase"}
Escreva em português simples. Não execute comandos nem abra outros arquivos: use só o texto abaixo.

Projeto: ${project.name}
Pasta: ${project.root_path}

${docsText}`;
}

// For folders without docs: the AI reads the file listing (names, types, dates) instead.
export function buildListingPrompt(project, s) {
  return `Você descreve projetos para o "Cérebro", o painel de projetos do Paixão (músico, produtor, videomaker e desenvolvedor). Esta pasta não tem documentação: deduza pelo que tem dentro. Responda SÓ com um JSON, sem nada antes ou depois:
{"o_que_e": "uma frase dizendo o que parece ser (ex.: show gravado do artista X, clipe, edital, site)",
 "feito": "o que já existe ali (2 a 3 frases: brutos, editados, mixes, artes, documentos)",
 "comecou": "quando/como começou, pelas datas e nomes",
 "agora": "em que ponto parece estar e o que parece faltar",
 "maturidade": "inacabado" | "quase resolvido" | "resolvido e funcional" | "não dá pra saber",
 "motivo": "por que essa maturidade, em uma frase"}
Ex.: só brutos = inacabado; brutos + editado final/exportado = resolvido e funcional; material entregue/publicado = resolvido e funcional. Dê sempre o seu melhor palpite pelos nomes e datas; use "não dá pra saber" só se a pasta não der nenhuma pista. Escreva em português simples. Não execute comandos nem abra arquivos.

Projeto: ${project.name}
Pasta: ${project.root_path}
Arquivos: ${s.total} · tipos ${JSON.stringify(s.types || {})} · de ${String(s.oldest || '').slice(0, 10)} a ${String(s.newest || '').slice(0, 10)}
Pastas: ${(s.folders || []).join('; ') || '—'}
Arquivos mais recentes:
${(s.sample || []).join('\n')}`;
}

export function parseDescription(out) {
  const text = String(out || '');
  for (let s = text.indexOf('{'); s >= 0; s = text.indexOf('{', s + 1)) {
    for (let e = text.lastIndexOf('}'); e > s; e = text.lastIndexOf('}', e - 1)) {
      try {
        const j = JSON.parse(text.slice(s, e + 1));
        if (j && typeof j === 'object' && (j.o_que_e || j.feito || j.agora)) {
          const m = String(j.maturidade || '').toLowerCase();
          return {
            o_que_e: String(j.o_que_e || '').trim(), feito: String(j.feito || '').trim(), comecou: String(j.comecou || '').trim(),
            agora: String(j.agora || '').trim(), motivo: String(j.motivo || '').trim(),
            maturidade: MATURITY.find((x) => m.includes(x)) || (m.includes('funcional') || m.includes('100') ? 'resolvido e funcional' : m.includes('quase') ? 'quase resolvido' : m.includes('inacab') ? 'inacabado' : 'não dá pra saber'),
          };
        }
      } catch { /* try a shorter slice */ }
    }
  }
  return null;
}

export function runCommand(command, input, { timeoutMs = 5 * 60 * 1000, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let out = ''; let err = ''; let done = false;
    const child = spawnImpl(command, { shell: true, windowsHide: true });
    const finish = (ok, reason) => { if (done) return; done = true; clearTimeout(timer); resolve({ ok, out, err: reason || err }); };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(false, 'tempo esgotado'); }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { err += d; });
    child.on('error', (e) => finish(false, e.message));
    child.on('close', (code) => finish(code === 0, code === 0 ? null : `saída ${code}: ${err.trim().slice(-300)}`));
    child.stdin?.end(input);
  });
}

export function loadDescriptions(cachePath) {
  try { return JSON.parse(readFileSync(cachePath, 'utf8')); } catch { return {}; }
}

export const keyOf = (p) => String(p.root_path).toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
export const descriptionFor = (cache, p) => cache[keyOf(p)]?.desc || null;

// Describes every project whose docs changed since last time, `concurrency` at a time.
export async function describeProjects({ projects, cachePath, command = DEFAULT_DESCRIBE_COMMAND, concurrency = 3, force = false, maxProjects = 0, log = () => {}, run = runCommand, now = () => new Date().toISOString(), inventory = {} }) {
  const cache = loadDescriptions(cachePath);
  const todo = [];
  for (const p of projects) {
    if (!existsSync(p.root_path)) continue;
    const docs = findDocs(p.root_path);
    const s = inventory[keyOf(p)];
    if (!docs.length && !(s && s.total > 0)) continue;
    const key = docs.length ? docsKey(docs) : `lista2:${s.total}:${s.newest}`;
    if (!force && cache[keyOf(p)]?.key === key && cache[keyOf(p)]?.desc) continue;
    todo.push({ p, docs, key, s });
  }
  const queue = maxProjects > 0 ? todo.slice(0, maxProjects) : todo;
  const stats = { pending: todo.length, done: 0, failed: 0 };
  const save = () => { mkdirSync(path.dirname(cachePath), { recursive: true }); writeFileSync(cachePath, `${JSON.stringify(cache, null, 1)}\n`); };
  let i = 0;
  const worker = async () => {
    while (i < queue.length) {
      const { p, docs, key, s } = queue[i++];
      const res = await run(command, docs.length ? buildPrompt(p, readDocs(p.root_path, docs)) : buildListingPrompt(p, s));
      const desc = res.ok ? parseDescription(res.out) : null;
      if (desc) {
        cache[keyOf(p)] = { key, desc: { ...desc, docs: docs.length ? docs.map((d) => d.rel) : ['(lista de arquivos)'], em: now() } };
        stats.done += 1; save(); log(`descrito: ${p.name} — ${desc.maturidade}`);
      } else { stats.failed += 1; log(`falhou: ${p.name} — ${res.ok ? 'resposta sem JSON' : res.err}`); }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return stats;
}
