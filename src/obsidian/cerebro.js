// Cérebro: Portuguese "second brain" vault rendered from Guardian's inventory.
// Writes only inside <vault>/Project Guardian and <vault>/_retomar. Every page keeps whatever the
// person writes outside the generated block; frontmatter is regenerated on every render.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { START, END } from './renderer.js';
import { fileUrl, writeLauncher } from '../cerebro/launchers.js';
import { buildUniversalSummary, daysSince, isArchived, kindLabel, lastActivityIso, readInbox, safeName, INBOX_DIR } from '../cerebro/summary.js';
import { findDuplicateGroups } from '../cerebro/duplicates.js';
import { relativeLabel } from '../cerebro/grouping.js';
import { descriptionFor } from '../cerebro/describe.js';
import { inventoryFolder, formatSize, typesPresent, TYPE_LABEL, PREVIEWABLE } from '../cerebro/inventory.js';

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
// True when the person ticked the "ignorar" property: the project stays out of the main lists.
export function readIgnoreMark(file) {
  if (!existsSync(file)) return false;
  const text = readFileSync(file, 'utf8');
  if (!text.startsWith('---\n')) return false;
  const end = text.indexOf('\n---\n', 4);
  return /^ignorar:\s*(true|sim|yes)\s*$/im.test(end >= 0 ? text.slice(4, end) : '');
}

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

const STATUS_LABEL = { ignorado: 'ignorado', andamento: 'em andamento', retomar: 'dá pra retomar', parado: 'parado', concluido: 'concluído', arquivo: 'arquivo — não mexer' };

function areaOf(project, roots) {
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  const p = norm(project.root_path);
  const root = roots.map(norm).filter((r) => p.toLowerCase() === r.toLowerCase() || p.toLowerCase().startsWith(`${r.toLowerCase()}/`)).sort((a, b) => b.length - a.length)[0];
  if (!root) return { root: 'Outros', area: '—' };
  const rel = p.slice(root.length).replace(/^\/+/, '');
  const first = rel.split('/')[0];
  return { root, area: first || '(raiz)' };
}

const fileLink = (p, f) => `[${f.name.replace(/[[\]]/g, '')}](${fileUrl(path.join(p.root_path, f.rel))})`;

// "Arquivos" section of a project note: what types are inside, the main folders, recent files,
// a photo gallery and the videos. The full list goes to Arquivos/<projeto>.md.
export function renderFiles(p, inv, fullListLink) {
  if (!inv) return ['## Arquivos', '- (pasta não encontrada ou sem acesso)'];
  const out = [`## Arquivos (${inv.total} · ${formatSize(inv.bytes)}${inv.truncated ? ' · lista cortada' : ''})`, ''];
  if (!inv.total) return [...out, '- pasta vazia'];
  out.push('| Tipo | Arquivos | Tamanho | Extensões |', '|---|---:|---:|---|');
  for (const [t, v] of [...inv.byType.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
    const exts = [...v.exts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([e, n]) => `${e} (${n})`).join(', ');
    out.push(`| ${TYPE_LABEL[t]} | ${v.count} | ${formatSize(v.bytes)} | ${exts} |`);
  }
  const folders = [...inv.folders.entries()].filter(([k]) => k).sort((a, b) => b[1].bytes - a[1].bytes);
  if (folders.length) {
    out.push('', `**Pastas (${folders.length})**`);
    for (const [k, v] of folders.slice(0, 30)) out.push(`- [${k.replace(/[[\]]/g, '')}](${fileUrl(path.join(p.root_path, k))}) — ${v.count} arquivos · ${formatSize(v.bytes)} · ${[...v.types].map((t) => TYPE_LABEL[t]).join(', ')}`);
    if (folders.length > 30) out.push(`- … e mais ${folders.length - 30}`);
  }
  const images = inv.files.filter((f) => PREVIEWABLE.has(f.ext));
  if (images.length) {
    out.push('', `**Fotos (${images.length})**${p.metadata_only ? ' _— no Google Drive, abrir a nota baixa as miniaturas_' : ''}`, '');
    out.push(images.slice(0, 12).map((f) => `![${f.name.replace(/[[\]|]/g, '')}|160](${fileUrl(path.join(p.root_path, f.rel))})`).join(' '));
  }
  const videos = inv.files.filter((f) => f.type === 'video');
  if (videos.length) {
    out.push('', `**Vídeos (${videos.length})**`);
    for (const f of videos.slice(0, 10)) out.push(`- ▶ ${fileLink(p, f)} · ${formatSize(f.size)} · ${fmtDate(f.mtime)}`);
  }
  out.push('', '**Últimos arquivos mexidos**');
  for (const f of inv.files.slice(0, 15)) out.push(`- ${fileLink(p, f)} — ${TYPE_LABEL[f.type]} · ${formatSize(f.size)} · ${fmtDate(f.mtime)}${f.rel.includes(path.sep) ? ` · em \`${path.dirname(f.rel)}\`` : ''}`);
  out.push('', `[[${fullListLink}|📂 Lista completa de arquivos]]`);
  return out;
}

const MAX_LISTED = 5000;
function writeFileList(file, p, inv) {
  const byFolder = new Map();
  for (const f of [...inv.files].sort((a, b) => a.rel.localeCompare(b.rel)).slice(0, MAX_LISTED)) {
    const d = path.dirname(f.rel) === '.' ? '' : path.dirname(f.rel);
    if (!byFolder.has(d)) byFolder.set(d, []);
    byFolder.get(d).push(f);
  }
  const lines = [`# Arquivos de ${p.name}`, '', `${inv.total} arquivos · ${formatSize(inv.bytes)} · [\`${p.root_path}\`](${fileUrl(p.root_path)})`, ''];
  for (const [d, files] of byFolder) {
    lines.push(`## ${d || '(raiz)'}`);
    for (const f of files) lines.push(`- ${fileLink(p, f)} — ${TYPE_LABEL[f.type]} · ${formatSize(f.size)} · ${fmtDate(f.mtime)}`);
    lines.push('');
  }
  if (inv.files.length > MAX_LISTED || inv.truncated) lines.push(`_Lista cortada: mostrando ${Math.min(inv.files.length, MAX_LISTED)} de ${inv.total} arquivos._`);
  if (inv.skipped.length) lines.push('', `_Pastas automáticas não listadas: ${inv.skipped.slice(0, 20).map((s) => `\`${s}\``).join(', ')}${inv.skipped.length > 20 ? '…' : ''}_`);
  const next = `${lines.join('\n')}\n`;
  if (existsSync(file) && readFileSync(file, 'utf8') === next) return;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, next);
}

export function renderCerebroVault({ vaultPath, projects, childrenOf = new Map(), areaByItem = new Map(), runtimeStates = [], intelligence = [], sessionsByProject = new Map(), roots = [], now = Date.now(), archiveDays = 365, inventoryOf = (p) => inventoryFolder(p.root_path), descriptions = {} }) {
  const root = path.join(vaultPath, ROOT);
  const runtime = new Map(runtimeStates.map((s) => [s.project_id, s]));
  const intel = new Map(intelligence.map((s) => [s.project_id, s]));
  const nameCounts = new Map(); for (const p of projects) nameCounts.set(safeName(p.name).toLowerCase(), (nameCounts.get(safeName(p.name).toLowerCase()) || 0) + 1);
  const stem = (p) => safeName(nameCounts.get(safeName(p.name).toLowerCase()) > 1 ? `${p.name}--${String(p.id).slice(0, 8)}` : p.name);
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
  for (const row of rows) {
    const note = path.join(root, 'Projetos', `${stem(row.p)}.md`);
    row.marked = readDeleteMark(note);
    row.ignored = readIgnoreMark(note);
    if (row.ignored) row.status = 'ignorado';
  }
  for (const { p, sessions, last, status, place, marked, ignored } of rows) {
    const i = intel.get(p.id); const r = runtime.get(p.id);
    const kids = childrenOf.get(p.id) || [];
    const latest = sessions[0] || null;
    const resumeUrl = latest ? writeLauncher(vaultPath, latest) : null;
    const summary = buildUniversalSummary({ project: p, intelligence: i ? { ...i, current_focus: r?.current_focus || i.current_focus } : null, lastSession: latest, inbox: readInbox(vaultPath, path.basename(p.root_path)) || readInbox(vaultPath, p.name) });
    const related = [
      ...projects.filter((q) => q.id !== p.id && p.project_family && q.project_family === p.project_family),
      ...(dupOf.get(p.id)?.projects || []).filter((q) => q.id !== p.id),
    ].filter((q, idx, a) => a.findIndex((x) => x.id === q.id) === idx);
    const inv = inventoryOf ? inventoryOf(p) : null;
    const desc = descriptionFor(descriptions, p);
    const types = typesPresent(inv);
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
      `ignorar: ${ignored}`,
      `caminho: ${yaml(p.root_path)}`,
      ...(desc ? [`maturidade: ${yaml(desc.maturidade)}`, `descricao: ${yaml(desc.o_que_e)}`] : []),
      ...(inv ? [
        `arquivos: ${inv.total}`,
        `tamanho: ${yaml(formatSize(inv.bytes))}`,
        `tem: [${types.map((t) => yaml(TYPE_LABEL[t])).join(', ')}]`,
        `tags: [${types.map((t) => yaml(`tem/${t}`)).join(', ')}]`,
      ] : []),
    ].join('\n');
    if (inv) writeFileList(path.join(root, 'Arquivos', `${stem(p)}.md`), p, inv);
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
      ...(desc ? [
        '## Descrição',
        `**${desc.o_que_e}**`,
        '',
        `**Maturidade:** ${desc.maturidade}${desc.motivo ? ` — ${desc.motivo}` : ''}`,
        '',
        ...(desc.feito ? [`- **Feito:** ${desc.feito}`] : []),
        ...(desc.comecou ? [`- **Começou:** ${desc.comecou}`] : []),
        ...(desc.agora ? [`- **Agora:** ${desc.agora}`] : []),
        '',
        `_Lido de ${(desc.docs || []).map((d) => `\`${d}\``).join(', ')} em ${fmtDate(desc.em)}._`,
        '',
      ] : []),
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
      `- ${areaByItem.get(p.id) ? `[\`${areaByItem.get(p.id)}\`](${fileUrl(areaByItem.get(p.id))})` : place.root}`,
      '',
      `## Conteúdo${kids.length ? ` (${kids.length} pastas)` : ''}`,
      kids.length
        ? kids.sort((a, b) => String(lastActivityIso(b)).localeCompare(String(lastActivityIso(a)))).slice(0, 60)
          .map((k) => `- [${relativeLabel(k, p).replace(/[[\]]/g, '')}](${fileUrl(k.root_path)}) — ${kindLabel(k.kind)} · ${fmtDate(lastActivityIso(k))}`).join('\n') + (kids.length > 60 ? `\n- … e mais ${kids.length - 60}` : '')
        : '- —',
      '',
      ...renderFiles(p, inv, `${ROOT}/Arquivos/${stem(p)}`),
      '',
      '## Relacionados',
      related.length ? related.map((q) => `- ${link(q)} (${q.root_path})`).join('\n') : '- —',
    ].join('\n');
    changed = writeNote(path.join(root, 'Projetos', `${stem(p)}.md`), { frontmatter, generated, initialManual: '## Minhas notas\n' }) || changed;
  }

  const byStatus = (s) => rows.filter((x) => x.status === s).sort((a, b) => String(b.last).localeCompare(String(a.last)));
  const line = ({ p, sessions, last }) => {
    const s = sessions[0]; const d = descriptionFor(descriptions, p);
    return `- ${link(p)} — ${kindLabel(p.kind)} · ${fmtDate(last)}${s ? ` · ${agentLabel(s.agent)} ${fmtDate(s.updated_at)}` : ''}${d ? ` · ${d.maturidade}` : ''}`;
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
    `## Ignorados (${byStatus('ignorado').length})`,
    '_Marcados com "ignorar": não são projetos seus (programas, sistema). Nada é apagado._',
    ...byStatus('ignorado').map(line),
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
      for (const x of items.sort((m, n) => m.p.name.localeCompare(n.p.name))) {
        const kids = childrenOf.get(x.p.id) || [];
        mapa.push(`  - ${link(x.p)} — ${STATUS_LABEL[x.status]}${kids.length ? ` · ${kids.length} pastas dentro` : ''}`);
      }
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

  const filesDir = path.join(root, 'Arquivos');
  for (const f of existsSync(filesDir) ? readdirSync(filesDir) : []) {
    if (f.endsWith('.md') && !current.has(f)) { unlinkSync(path.join(filesDir, f)); changed = true; }
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
