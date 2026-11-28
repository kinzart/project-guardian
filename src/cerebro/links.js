// Links between projects for the Cérebro, even across drives (PC ↔ Google Drive):
//   1. Signals: similar names, the same files (name + size) in both, and days worked in common.
//   2. Obvious pairs are linked straight away; likely pairs go to a cheap AI (Codex Luna);
//      when it is unsure, a stronger model looks; when that one is unsure too, the pair goes to
//      Acertos.md, where the person ticks which option it relates to (or "nenhum").
// Verdicts and the person's choices are kept in data/cerebro-ligacoes.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runCommand } from './describe.js';

const STOP = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'the', 'and', 'of', 'a', 'o', 'as', 'os', 'em', 'no', 'na', 'para', 'pra', 'com', 'nova', 'novo', 'new', 'pasta', 'folder', 'copy', 'copia', 'final', 'versao', 'version', 'arquivos', 'files', 'backup', 'old', 'teste', 'test', 'geral', 'outros', 'meu', 'minha', 'drive', 'projeto', 'projetos', 'project']);
export const norm = (p) => String(p).toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
const plain = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function nameTokens(name) {
  return [...new Set(plain(name).split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t) && !/^v\d+$/.test(t)))];
}
export const pairKey = (a, b) => [norm(a.root_path), norm(b.root_path)].sort().join(' <> ');
const related = (a, b) => { const x = norm(a.root_path); const y = norm(b.root_path); return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`); };

// Signals for every pair worth looking at. `inv` maps root_path(norm) → inventory summary.
export function findCandidates(projects, inv = {}, { minFileSize = 0 } = {}) {
  const toks = new Map(projects.map((p) => [p.id, nameTokens(p.name)]));
  const byToken = new Map();
  for (const p of projects) for (const t of toks.get(p.id)) { if (!byToken.has(t)) byToken.set(t, []); byToken.get(t).push(p); }
  const pairs = new Map();
  const pair = (a, b) => {
    if (a.id === b.id || related(a, b)) return null;
    const k = pairKey(a, b);
    if (!pairs.has(k)) pairs.set(k, { key: k, a, b, sharedTokens: [], sharedFiles: 0, sharedDays: 0 });
    return pairs.get(k);
  };
  for (const [t, ps] of byToken) {
    if (ps.length > 12) continue; // too common to mean anything
    for (let i = 0; i < ps.length; i += 1) for (let j = i + 1; j < ps.length; j += 1) { const c = pair(ps[i], ps[j]); if (c) c.sharedTokens.push(t); }
  }
  const byFile = new Map();
  for (const p of projects) {
    for (const f of inv[norm(p.root_path)]?.files || []) {
      const size = Number(f.split('|').pop());
      if (size < minFileSize) continue;
      if (!byFile.has(f)) byFile.set(f, []);
      byFile.get(f).push(p);
    }
  }
  for (const ps of byFile.values()) {
    if (ps.length < 2 || ps.length > 6) continue;
    for (let i = 0; i < ps.length; i += 1) for (let j = i + 1; j < ps.length; j += 1) { const c = pair(ps[i], ps[j]); if (c) c.sharedFiles += 1; }
  }
  for (const c of pairs.values()) {
    const da = inv[norm(c.a.root_path)]?.days || {}; const db = inv[norm(c.b.root_path)]?.days || {};
    c.sharedDays = Object.keys(da).filter((d) => db[d]).length;
    const ta = toks.get(c.a.id); const tb = toks.get(c.b.id);
    c.nameScore = ta.length && tb.length ? c.sharedTokens.length / new Set([...ta, ...tb]).size : 0;
    c.contained = (ta.length >= 2 && ta.every((t) => tb.includes(t))) || (tb.length >= 2 && tb.every((t) => ta.includes(t)));
    c.sameName = plain(c.a.name).replace(/[^a-z0-9]/g, '') === plain(c.b.name).replace(/[^a-z0-9]/g, '') && plain(c.a.name).replace(/[^a-z0-9]/g, '').length >= 4;
    c.level = classify(c);
  }
  return [...pairs.values()].filter((c) => c.level !== 'nada');
}

export function classify(c) {
  if (c.sharedFiles >= 3 || c.sameName || c.contained || c.nameScore >= 0.8) return 'obvio';
  if (c.sharedFiles >= 1 || c.nameScore >= 0.34 || (c.sharedTokens.length && c.sharedDays >= 2)) return 'provavel';
  return 'nada';
}

export function reasonText(c) {
  const r = [];
  if (c.sameName) r.push('mesmo nome');
  else if (c.sharedTokens.length) r.push(`nome em comum: ${c.sharedTokens.slice(0, 4).join(', ')}`);
  if (c.sharedFiles) r.push(`${c.sharedFiles} arquivo(s) iguais`);
  if (c.sharedDays) r.push(`${c.sharedDays} dia(s) de trabalho em comum`);
  return r.join(' · ');
}

const brief = (p, inv, desc) => {
  const s = inv[norm(p.root_path)] || {};
  return [
    `Nome: ${p.name}`, `Pasta: ${p.root_path}`,
    desc ? `Descrição: ${desc.o_que_e}${desc.agora ? ` / Agora: ${desc.agora}` : ''}` : null,
    s.total !== undefined ? `Arquivos: ${s.total} · tipos ${JSON.stringify(s.types || {})} · de ${String(s.oldest || '').slice(0, 10)} a ${String(s.newest || '').slice(0, 10)}` : null,
    s.sample?.length ? `Alguns arquivos: ${s.sample.slice(0, 30).join('; ')}` : null,
  ].filter(Boolean).join('\n');
};

export function buildLinkPrompt(c, inv, descOf = () => null) {
  return `Você liga projetos no "Cérebro" do Paixão (músico, produtor e desenvolvedor). Dois itens (pastas no PC ou no Google Drive) podem ser a mesma coisa, partes do mesmo trabalho (ex.: gravação → mix → vídeo → divulgação), do mesmo evento/data, do mesmo artista/cliente, ou não ter nada a ver.
Sinais encontrados: ${reasonText(c)}.
Responda SÓ com JSON: {"relacao": "sim" | "nao" | "talvez", "tipo": "mesmo projeto" | "parte do mesmo trabalho" | "mesmo evento" | "mesmo artista/cliente" | "outro", "motivo": "uma frase"}
Use "sim" só com evidência clara; nomes genéricos parecidos não bastam. Não execute comandos nem abra arquivos.

[A]
${brief(c.a, inv, descOf(c.a))}

[B]
${brief(c.b, inv, descOf(c.b))}`;
}

export function parseVerdict(out) {
  const text = String(out || '');
  for (let s = text.indexOf('{'); s >= 0; s = text.indexOf('{', s + 1)) {
    for (let e = text.lastIndexOf('}'); e > s; e = text.lastIndexOf('}', e - 1)) {
      try {
        const j = JSON.parse(text.slice(s, e + 1));
        const r = plain(j.relacao || '');
        if (['sim', 'nao', 'talvez'].includes(r)) return { relacao: r, tipo: String(j.tipo || '').trim(), motivo: String(j.motivo || '').trim() };
      } catch { /* shorter slice */ }
    }
  }
  return null;
}

export const loadLinks = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return { pairs: {} }; } };
export const saveLinks = (file, data) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(data, null, 1)}\n`); };
const sig = (c) => `${c.sharedTokens.length}:${c.sharedFiles}:${c.sharedDays}`;

// Decides every candidate pair. AI calls only for "provavel" pairs not decided before.
export async function decideLinks({ candidates, cachePath, inv, descOf, command, secondCommand, concurrency = 3, maxCalls = 400, run = runCommand, log = () => {} }) {
  const data = loadLinks(cachePath); data.pairs ||= {};
  const todo = [];
  for (const c of candidates) {
    const prev = data.pairs[c.key];
    const base = { a: c.a.root_path, b: c.b.root_path, motivo_sinais: reasonText(c), sig: sig(c) };
    if (prev?.pessoa) { data.pairs[c.key] = { ...prev, ...base }; continue; } // the person decided: keep
    if (c.level === 'obvio') { data.pairs[c.key] = { ...base, relacao: 'sim', por: 'óbvio', tipo: prev?.tipo || '' }; continue; }
    if (prev && prev.sig === base.sig && prev.relacao) continue;
    todo.push({ c, base });
  }
  const queue = todo.slice(0, maxCalls);
  const stats = { candidatos: candidates.length, ia: queue.length, sim: 0, nao: 0, talvez: 0, falhou: 0 };
  let i = 0;
  const worker = async () => {
    while (i < queue.length) {
      const { c, base } = queue[i++];
      const prompt = buildLinkPrompt(c, inv, descOf);
      let v = null; let por = 'IA';
      const r1 = await run(command, prompt); v = r1.ok ? parseVerdict(r1.out) : null;
      if (v?.relacao === 'talvez' && secondCommand) {
        const r2 = await run(secondCommand, prompt); const v2 = r2.ok ? parseVerdict(r2.out) : null;
        if (v2) { v = v2; por = 'IA (2ª opinião)'; }
      }
      if (!v) { stats.falhou += 1; log(`falhou: ${c.a.name} <> ${c.b.name}`); continue; }
      data.pairs[c.key] = { ...base, ...v, por };
      stats[v.relacao] += 1;
      saveLinks(cachePath, data);
      log(`${v.relacao}: ${c.a.name} <> ${c.b.name}${v.motivo ? ` — ${v.motivo}` : ''}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  saveLinks(cachePath, data);
  return stats;
}

// --- Acertos.md: the person's review list ---------------------------------------------------
const ACERTO = /^\s*-\s*\[([ xX])\]\s*(.*?)\s*·\s*`([^`]+)`\s*$/;
const HEAD = /^## .*?`([^`]+)`\s*$/;

// Reads ticks from Acertos.md and stores them as the person's decisions. Returns how many changed.
export function applyAcertos(file, data) {
  if (!existsSync(file)) return 0;
  let changed = 0; let head = null; let group = [];
  const flush = () => {
    if (!head || !group.length) return;
    const ticked = group.filter((g) => g.ticked);
    if (!ticked.length) return;
    const none = ticked.some((g) => g.target === '-');
    for (const g of group) {
      if (g.target === '-') continue;
      const k = [norm(head), norm(g.target)].sort().join(' <> ');
      const rel = !none && g.ticked ? 'sim' : 'nao';
      if (data.pairs[k]?.pessoa && data.pairs[k].relacao === rel) continue;
      data.pairs[k] = { ...(data.pairs[k] || { a: head, b: g.target }), relacao: rel, pessoa: true, por: 'você' };
      changed += 1;
    }
  };
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const h = HEAD.exec(line);
    if (h) { flush(); head = h[1]; group = []; continue; }
    const m = ACERTO.exec(line);
    if (m && head) group.push({ ticked: m[1].toLowerCase() === 'x', target: m[3] });
  }
  flush();
  return changed;
}

// Writes the review list: for each project with "talvez" pairs, up to 10 options + "nenhum".
export function renderAcertos({ file, data, projects, link }) {
  const byPath = new Map(projects.map((p) => [norm(p.root_path), p]));
  const open = new Map();
  for (const v of Object.values(data.pairs || {})) {
    if (v.relacao !== 'talvez' || v.pessoa) continue;
    const a = byPath.get(norm(v.a)); const b = byPath.get(norm(v.b));
    if (!a || !b) continue;
    if (!open.has(a.id)) open.set(a.id, { p: a, opts: [] });
    open.get(a.id).opts.push({ q: b, v });
  }
  const lines = ['# Acertos', '', '_Pares que nem a IA teve certeza. Marque com que cada um tem a ver (pode marcar mais de um) ou "nenhum". Na próxima atualização viram ligações; os outros somem daqui._', ''];
  const groups = [...open.values()].sort((x, y) => y.opts.length - x.opts.length);
  for (const { p, opts } of groups) {
    lines.push(`## ${link(p)} · \`${p.root_path}\``);
    for (const { q, v } of opts.slice(0, 10)) lines.push(`- [ ] ${link(q)} — ${String(v.motivo || v.motivo_sinais || '').replace(/[`·]/g, '-')} · \`${q.root_path}\``);
    lines.push('- [ ] nenhum · `-`', '');
  }
  if (!groups.length) lines.push('- nada para conferir agora');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${lines.join('\n')}\n`);
  return groups.length;
}

// Confirmed links per project id: [{ q, por, tipo, motivo }].
export function linksByProject(data, projects) {
  const byPath = new Map(projects.map((p) => [norm(p.root_path), p]));
  const out = new Map();
  for (const v of Object.values(data.pairs || {})) {
    if (v.relacao !== 'sim') continue;
    const a = byPath.get(norm(v.a)); const b = byPath.get(norm(v.b));
    if (!a || !b) continue;
    for (const [x, y] of [[a, b], [b, a]]) { if (!out.has(x.id)) out.set(x.id, []); out.get(x.id).push({ q: y, por: v.por, tipo: v.tipo, motivo: v.motivo || v.motivo_sinais }); }
  }
  return out;
}
