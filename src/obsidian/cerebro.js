// Cérebro: Portuguese "second brain" vault rendered from Guardian's inventory.
// Writes only inside <vault>/Project Guardian and <vault>/_retomar. Every page keeps whatever the
// person writes outside the generated block; frontmatter is regenerated on every render.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { START, END } from './renderer.js';
import { fileUrl, writeLauncher } from '../cerebro/launchers.js';
import { buildUniversalSummary, daysSince, isArchived, kindLabel, lastActivityIso, readInbox, safeName, INBOX_DIR } from '../cerebro/summary.js';
import { findDuplicateGroups } from '../cerebro/duplicates.js';

const ROOT = 'Project Guardian';
const AGENT_LABEL = { codex: 'Codex', claude: 'Claude', hermes: 'Hermes' };
const agentLabel = (a) => AGENT_LABEL[a] || a || '—';
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—');
const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }) : '—');
const yaml = (v) => (v === null || v === undefined ? '""' : JSON.stringify(String(v)));

function splitFrontmatter(text) {
  if (!text.startsWith('---\n')) return text;
  const end = text.indexOf('\n---\n', 4);
  return end >= 0 ? text.slice(end + 5) : text;
}

// True when the person ticked the "excluir" property or wrote #apagar outside the generated block.
export function readDeleteMark(file) {
  if (!existsSync(file)) return false;
  const text = readFileSync(file, 'utf8');
  if (text.startsWith('---\n')) {
    const end = text.indexOf('\n---\n', 4);
    const fm = end >= 0 ? text.slice(4, end) : '';
    if (/^excluir:\s*(true|sim|yes)\s*$/im.test(fm)) return true;
  }
  const rest = splitFrontmatter(text);
  const s = rest.indexOf(START); const e = rest.indexOf(END);
  const manual = s >= 0 && e > s ? rest.slice(0, s) + rest.slice(e + END.length) : rest;
  return /(^|\s)#apagar\b/i.test(manual);
}

function writeNote(file, { frontmatter = null, generated, initialManual = '' }) {
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : null;
  const block = `${START}\n${generated.trim()}\n${END}`;
  let body;
  if (existing === null) body = `${block}\n${initialManual ? `\n${initialManual}\n` : ''}`;
  else {
    const rest = splitFrontmatter(existing);
    const s = rest.indexOf(START); const e = rest.indexOf(END);
    body = s >= 0 && e > s ? `${rest.slice(0, s)}${block}${rest.slice(e + END.length)}` : `${block}\n\n${rest.trimStart()}`;
  }
  const next = `${frontmatter ? `---\n${frontmatter}\n---\n` : ''}${body}`;
  if (next === existing) return false;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, next);
  return true;
}

export function statusOf(project, lastIso, now, archiveDays) {
  if (isArchived(lastIso, now, archiveDays)) return 'arquivo';
  if (project.status?.completion_state === 'DONE') return 'concluido';
  const d = daysSince(lastIso, now);
  if (d <= 7) return 'andamento';
  if (d <= 90) return 'retomar';
  return 'parado';
}

const STATUS_LABEL = { andamento: 'em andamento', retomar: 'dá pra retomar', parado: 'parado', concluido: 'concluído', arquivo: 'arquivo — não mexer' };

function areaOf(project, roots) {
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  const p = norm(project.root_path);
  const root = roots.map(norm).filter((r) => p.toLowerCase() === r.toLowerCase() || p.toLowerCase().startsWith(`${r.toLowerCase()}/`)).sort((a, b) => b.length - a.length)[0];
  if (!root) return { root: 'Outros', area: '—' };
  const rel = p.slice(root.length).replace(/^\/+/, '');
  const first = rel.split('/')[0];
  return { root, area: first || '(raiz)' };
}

export function renderCerebroVault({ vaultPath, projects, childrenOf = new Map(), parentOf = new Map(), runtimeStates = [], intelligence = [], sessionsByProject = new Map(), roots = [], now = Date.now(), archiveDays = 365 }) {
  const root = path.join(vaultPath, ROOT);
  const runtime = new Map(runtimeStates.map((s) => [s.project_id, s]));
  const intel = new Map(intelligence.map((s) => [s.project_id, s]));
  const nameCounts = new Map(); for (const p of projects) nameCounts.set(p.name, (nameCounts.get(p.name) || 0) + 1);
  const stem = (p) => safeName(nameCounts.get(p.name) > 1 ? `${p.name}--${String(p.id).slice(0, 8)}` : p.name);
  const link = (p) => `[[${ROOT}/Projetos/${stem(p)}|${p.name.replace(/[|\]]/g, '-')}]]`;
  const duplicates = findDuplicateGroups(projects);
  const dupOf = new Map(); for (const g of duplicates) for (const p of g.projects) dupOf.set(p.id, g);

  const rows = projects.map((p) => {
    const sessions = sessionsByProject.get(p.id) || [];
    const kidList = childrenOf.get(p.id) || [];
    const last = [lastActivityIso(p, sessions), ...kidList.map((k) => lastActivityIso(k))].filter(Boolean).sort().pop() || null;
    return { p, sessions, last, status: statusOf(p, last, now, archiveDays), place: areaOf(p, roots) };
  });

  let changed = false;
  for (const row of rows) row.marked = readDeleteMark(path.join(root, 'Projetos', `${stem(row.p)}.md`));
  for (const { p, sessions, last, status, place, marked } of rows) {
    const i = intel.get(p.id); const r = runtime.get(p.id);
    const kids = childrenOf.get(p.id) || [];
    const latest = sessions[0] || null;
    const resumeUrl = latest ? writeLauncher(vaultPath, latest) : null;
    const summary = buildUniversalSummary({ project: p, intelligence: i ? { ...i, current_focus: r?.current_focus || i.current_focus } : null, lastSession: latest, inbox: readInbox(vaultPath, path.basename(p.root_path)) || readInbox(vaultPath, p.name) });
    const related = [
      ...projects.filter((q) => q.id !== p.id && p.project_family && q.project_family === p.project_family),
      ...(dupOf.get(p.id)?.projects || []).filter((q) => q.id !== p.id),
    ].filter((q, idx, a) => a.findIndex((x) => x.id === q.id) === idx);
    const frontmatter = [
      `status: ${yaml(STATUS_LABEL[status])}`,
      `tipo: ${yaml(kindLabel(p.kind))}`,
      `area: ${yaml(`${place.root}/${place.area}`)}`,
      `ultima_mudanca: ${yaml(last ? last.slice(0, 10) : '')}`,
      `ultimo_arquivo: ${yaml(p.latest_entry?.name || '')}`,
      `ultima_ia: ${yaml(latest ? agentLabel(latest.agent) : '')}`,
      `ultima_ia_em: ${yaml(latest?.updated_at ? latest.updated_at.slice(0, 10) : '')}`,
      `arquivo: ${status === 'arquivo'}`,
      `excluir: ${marked}`,
      `caminho: ${yaml(p.root_path)}`,
    ].join('\n');
    const older = sessions.slice(1, 6).map((s) => {
      const u = writeLauncher(vaultPath, s);
      return `- ${agentLabel(s.agent)}, ${fmtDateTime(s.updated_at)}${s.title ? ` — ${s.title}` : ''}${u ? ` · [retomar](${u})` : ''}`;
    });
    const list = (items) => (items?.length ? items.slice(0, 8).map((x) => `- ${x.text}`).join('\n') : '- —');
    const generated = [
      `# ${p.name}`,
      '',
      `**Status:** ${STATUS_LABEL[status]} · **Última mudança:** ${fmtDate(last)}${p.latest_entry?.name ? ` (${p.latest_entry.name})` : ''}`,
      `**Pasta:** [\`${p.root_path}\`](${fileUrl(p.root_path)})${p.metadata_only ? ' · Google Drive (só leitura de nomes)' : ''}`,
      '',
      '## Resumo universal',
      ...summary,
      '',
      '## Última IA',
      latest
        ? `**${agentLabel(latest.agent)}**, ${fmtDateTime(latest.updated_at)}${latest.title ? ` — ${latest.title}` : ''}\n\n> ${latest.last_message || '(sem resposta registrada)'}\n\n${resumeUrl ? `[▶ Retomar esta sessão](${resumeUrl})` : '(não dá pra retomar automaticamente)'}`
        : '—',
      ...(older.length ? ['', '**Sessões anteriores**', ...older] : []),
      '',
      '## Próximos passos',
      list(i?.next_steps || r?.next_actions),
      '',
      '## Bloqueios',
      list(i?.blockers || r?.open_blockers),
      '',
      '## Está dentro de',
      parentOf.get(p.id) ? `- ${link(parentOf.get(p.id))}` : `- ${place.root}${place.area !== '—' && place.area !== '(raiz)' && place.area !== path.basename(p.root_path) ? ` › ${place.area}` : ''}`,
      '',
      `## Conteúdo${kids.length ? ` (${kids.length} pastas)` : ''}`,
      kids.length
        ? kids.sort((a, b) => String(lastActivityIso(b)).localeCompare(String(lastActivityIso(a)))).slice(0, 60)
          .map((k) => `- [${k.name}](${fileUrl(k.root_path)}) — ${kindLabel(k.kind)} · ${fmtDate(lastActivityIso(k))}`).join('\n') + (kids.length > 60 ? `\n- … e mais ${kids.length - 60}` : '')
        : '- —',
      '',
      '## Relacionados',
      related.length ? related.map((q) => `- ${link(q)} (${q.root_path})`).join('\n') : '- —',
    ].join('\n');
    changed = writeNote(path.join(root, 'Projetos', `${stem(p)}.md`), { frontmatter, generated, initialManual: '## Minhas notas\n' }) || changed;
  }

  const byStatus = (s) => rows.filter((x) => x.status === s).sort((a, b) => String(b.last).localeCompare(String(a.last)));
  const line = ({ p, sessions, last }) => {
    const s = sessions[0];
    return `- ${link(p)} — ${kindLabel(p.kind)} · ${fmtDate(last)}${s ? ` · ${agentLabel(s.agent)} ${fmtDate(s.updated_at)}` : ''}`;
  };
  const section = (title, s, hint = '') => {
    const items = byStatus(s);
    return [`## ${title} (${items.length})`, hint, ...(items.length ? items.map(line) : ['- —']), ''].filter((x) => x !== '');
  };
  const painel = [
    '# Painel',
    '',
    `Atualizado em ${fmtDateTime(new Date(now).toISOString())} · ${projects.length} projetos · [[${ROOT}/Mapa|Mapa]] · [[${ROOT}/Duplicados|Duplicados (${duplicates.length})]] · [[${ROOT}/Sugestões|Sugestões]]`,
    '',
    ...(rows.some((x) => x.marked) ? [
      `## Marcados para excluir (${rows.filter((x) => x.marked).length})`,
      '_Nada é apagado sozinho. Para mandar para a Lixeira: `guardian cerebro limpar` (mostra a lista) e depois `guardian cerebro limpar --confirmar`._',
      ...rows.filter((x) => x.marked).map((x) => `- ${link(x.p)} — ${x.p.root_path}`),
      '',
    ] : []),
    ...section('Em andamento', 'andamento', '_Mexidos nos últimos 7 dias._'),
    '',
    ...section('Dá pra retomar', 'retomar', '_Parados entre 7 e 90 dias._'),
    '',
    ...section('Parados há mais tempo', 'parado'),
    '',
    ...section('Concluídos', 'concluido'),
    '',
    `## Arquivo — não mexer (${byStatus('arquivo').length})`,
    `_Sem mudança há mais de ${archiveDays} dias. Ficam onde estão._`,
    ...byStatus('arquivo').map(line),
  ].join('\n');
  changed = writeNote(path.join(root, 'Painel.md'), { generated: painel }) || changed;

  const tree = new Map();
  for (const x of rows) {
    if (!tree.has(x.place.root)) tree.set(x.place.root, new Map());
    const areas = tree.get(x.place.root);
    if (!areas.has(x.place.area)) areas.set(x.place.area, []);
    areas.get(x.place.area).push(x);
  }
  const mapa = ['# Mapa', ''];
  for (const [r, areas] of [...tree.entries()].sort()) {
    mapa.push(`## ${r}`);
    for (const [a, items] of [...areas.entries()].sort()) {
      mapa.push(`- **${a}**`);
      const inArea = new Set(items.map((x) => x.p.id));
      const tops = items.filter((x) => !parentOf.get(x.p.id) || !inArea.has(parentOf.get(x.p.id).id));
      const emit = (x, depth) => {
        const kids = childrenOf.get(x.p.id) || [];
        mapa.push(`${'  '.repeat(depth)}- ${link(x.p)} — ${STATUS_LABEL[x.status]}${kids.length ? ` · ${kids.length} pastas dentro` : ''}`);
        for (const c of items.filter((y) => parentOf.get(y.p.id)?.id === x.p.id).sort((m, n) => m.p.name.localeCompare(n.p.name))) emit(c, depth + 1);
      };
      for (const x of tops.sort((m, n) => m.p.name.localeCompare(n.p.name))) emit(x, 1);
    }
    mapa.push('');
  }
  changed = writeNote(path.join(root, 'Mapa.md'), { generated: mapa.join('\n') }) || changed;

  const dups = ['# Possíveis duplicados', '', '_Só sugestão. Nada é movido ou apagado._', ''];
  for (const g of duplicates) {
    dups.push(`## ${g.projects[0].name}`);
    for (const p of g.projects) dups.push(`- ${link(p)} — ${p.root_path} · ${fmtDate(lastActivityIso(p, sessionsByProject.get(p.id) || []))}`);
    dups.push('');
  }
  if (!duplicates.length) dups.push('- nenhum encontrado');
  changed = writeNote(path.join(root, 'Duplicados.md'), { generated: dups.join('\n') }) || changed;

  // Notes for projects no longer in the inventory (folder deleted or excluded) move to
  // Removidos/, never deleted, so the person's own notes in them are kept.
  const current = new Set(projects.map((p) => `${stem(p)}.md`));
  const projDir = path.join(root, 'Projetos');
  let removed = 0;
  for (const f of existsSync(projDir) ? readdirSync(projDir) : []) {
    if (!f.endsWith('.md') || current.has(f)) continue;
    const from = path.join(projDir, f);
    const text = readFileSync(from, 'utf8');
    if (!text.includes(START)) continue;
    const manual = splitFrontmatter(text).replace(new RegExp(`${START}[\\s\\S]*?${END}`), '').replace('## Minhas notas', '').trim();
    if (!manual) { unlinkSync(from); removed += 1; changed = true; continue; }
    const toDir = path.join(root, 'Removidos'); mkdirSync(toDir, { recursive: true });
    let to = path.join(toDir, f);
    if (existsSync(to)) to = path.join(toDir, `${f.slice(0, -3)}--${new Date(now).toISOString().slice(0, 10)}.md`);
    renameSync(from, to); removed += 1; changed = true;
  }

  mkdirSync(path.join(vaultPath, INBOX_DIR), { recursive: true });
  mkdirSync(path.join(vaultPath, 'Triagem'), { recursive: true });
  const task = path.join(vaultPath, '_hermes', 'TRIAGEM.md');
  if (!existsSync(task)) {
    mkdirSync(path.dirname(task), { recursive: true });
    const tpl = readFileSync(new URL('../cerebro/templates/TRIAGEM-HERMES.md', import.meta.url), 'utf8');
    writeFileSync(task, tpl.replaceAll('{{VAULT}}', vaultPath.replace(/[\\/]+$/, '')));
  }
  return { root, changed, projectsRendered: projects.length, duplicates: duplicates.length, removed, marked: rows.filter((x) => x.marked).map((x) => x.p) };
}
