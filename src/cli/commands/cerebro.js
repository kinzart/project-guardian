import path from 'node:path';
import { loadConfig } from '../../config/loadConfig.js';
import { createStore } from '../../store/createStore.js';
import { scanCommand } from './scan.js';
import { obsidianCommand, agentHomes } from './obsidian.js';
import { indexSessions, mapSessionsToProjects } from '../../sessions/index.js';
import { findDuplicateGroups } from '../../cerebro/duplicates.js';
import { buildInventoryDigest, runSuggestions } from '../../cerebro/suggest.js';
import { installRule, removeRule } from '../../cerebro/rule.js';
import { cleanup, cleanupTriage, readTriageItems } from '../../cerebro/cleanup.js';
import { groupProjects } from '../../cerebro/grouping.js';
import { describeProjects, DEFAULT_DESCRIBE_COMMAND, loadDescriptions, descriptionFor } from '../../cerebro/describe.js';
import { findCandidates, decideLinks } from '../../cerebro/links.js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

export const SECOND_OPINION_COMMAND = 'codex exec --skip-git-repo-check -s read-only -c model_reasoning_effort="low" -';
// Projects the person marked "ignorar" (programs, system folders) are left out of the links.
function ignoredPaths(vault) {
  const out = new Set();
  const dir = vault ? path.join(vault, 'Project Guardian', 'Projetos') : null;
  if (!dir || !existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const text = readFileSync(path.join(dir, f), 'utf8').slice(0, 3000);
    const c = /^caminho:\s*"(.*)"\s*$/m.exec(text);
    if (c && /^ignorar:\s*true\s*$/m.test(text)) out.add(JSON.parse(`"${c[1]}"`).toLowerCase());
  }
  return out;
}
const loadInventory = (projectRoot) => { try { return JSON.parse(readFileSync(path.join(projectRoot, 'data', 'cerebro-inventario.json'), 'utf8')); } catch { return {}; } };
async function groupedProjects({ projectRoot, store, config }) {
  const sessions = await indexSessions({ ...agentHomes(config), cachePath: path.join(projectRoot, 'data', 'agent-sessions.json') });
  return groupProjects(await store.listProjects(), config.scanRoots || [], sessions, { listRoots: config.metadataOnlyRoots || [] }).items;
}

// Finds links between projects (names, identical files, shared days) and lets the AI decide the likely ones.
export async function linkNow({ projectRoot, store, config, maxCalls = 400 }) {
  if (config.cerebro?.links === false) return null;
  const ignored = ignoredPaths(config.obsidian?.vaultPath);
  const projects = (await groupedProjects({ projectRoot, store, config })).filter((p) => !ignored.has(String(p.root_path).toLowerCase()));
  const inv = loadInventory(projectRoot);
  const descs = loadDescriptions(path.join(projectRoot, 'data', 'cerebro-descricoes.json'));
  const candidates = findCandidates(projects, inv, { minFileSize: 100 * 1024 });
  return decideLinks({
    candidates, inv, maxCalls,
    cachePath: path.join(projectRoot, 'data', 'cerebro-ligacoes.json'),
    descOf: (p) => descriptionFor(descs, p),
    command: config.cerebro?.describeCommand || DEFAULT_DESCRIBE_COMMAND,
    secondCommand: config.cerebro?.secondOpinionCommand ?? SECOND_OPINION_COMMAND,
    concurrency: config.cerebro?.describeConcurrency || 3,
    log: (m) => console.log(`Cérebro ligar: ${m}`),
  });
}
import { appendFileSync, mkdirSync } from 'node:fs';

const ACTION_LABEL = { lixeira: 'enviado para a Lixeira', recusado: 'NÃO apagado', erro: 'erro', pendente: 'vai para a Lixeira' };

export async function limpar({ projectRoot, store, config, confirm, recycle }) {
  const rendered = await obsidianCommand({ projectRoot, args: ['render'], store, config });
  const marked = rendered?.marked || [];
  const vault = config.obsidian.vaultPath;
  const items = readTriageItems(path.join(vault, 'Triagem'));
  if (!marked.length && !items.length) { console.log('Nada marcado: nenhuma caixinha "excluir" (ou #apagar) nos projetos e nenhum "- [x] apagar:" na Triagem.'); return []; }
  const projects = await store.listProjects();
  const roots = config.scanRoots || [];
  const results = cleanup(marked, { roots, projects, confirm, recycle });
  const markedIds = new Set(marked.map((p) => p.id));
  const triage = cleanupTriage(items, { roots, vaultPath: vault, projects, markedIds, confirm, recycle });
  const lines = [
    ...results.map((r) => `- projeto ${r.project.name} — ${r.project.root_path}: ${ACTION_LABEL[r.action]}${r.reason ? ` (${r.reason})` : ''}`),
    ...triage.map((r) => `- ${r.item.target}: ${ACTION_LABEL[r.action]}${r.reason ? ` (${r.reason})` : ''}`),
  ];
  for (const l of lines) console.log(l);
  if (!confirm) console.log('\nNada foi apagado. Confira a lista e rode: guardian cerebro limpar --confirmar');
  else {
    const log = path.join(vault, 'Project Guardian', 'Limpeza.md');
    mkdirSync(path.dirname(log), { recursive: true });
    appendFileSync(log, `\n## ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}\n${lines.join('\n')}\n`);
    for (const r of results) if (r.action === 'lixeira') await store.removeProject(r.project.id);
    if ([...results, ...triage].some((r) => r.action === 'lixeira')) await scanCommand({ projectRoot, store, config }).then(() => obsidianCommand({ projectRoot, args: ['render'], store, config }));
  }
  return { projects: results, items: triage };
}

export async function suggestNow({ projectRoot, store, config }) {
  if (!config.cerebro?.suggestCommand || !config.obsidian?.vaultPath) return null;
  const sessions = await indexSessions({ ...agentHomes(config), cachePath: path.join(projectRoot, 'data', 'agent-sessions.json') });
  const { items: projects } = groupProjects(await store.listProjects(), config.scanRoots || [], sessions, { listRoots: config.metadataOnlyRoots || [] });
  const digest = buildInventoryDigest(projects, mapSessionsToProjects(sessions, projects), findDuplicateGroups(projects));
  return runSuggestions({ command: config.cerebro.suggestCommand, digest, outPath: path.join(config.obsidian.vaultPath, 'Project Guardian', 'Sugestões.md') });
}

// Reads the .md docs of each project with a cheap AI and caches a short description + maturity.
export async function describeNow({ projectRoot, store, config, force = false, maxProjects = 0 }) {
  if (config.cerebro?.describe === false) return null;
  const sessions = await indexSessions({ ...agentHomes(config), cachePath: path.join(projectRoot, 'data', 'agent-sessions.json') });
  let { items: projects } = groupProjects(await store.listProjects(), config.scanRoots || [], sessions, { listRoots: config.metadataOnlyRoots || [] });
  if (config.cerebro?.describeDrive === false) projects = projects.filter((p) => !p.metadata_only);
  return describeProjects({
    projects,
    inventory: loadInventory(projectRoot),
    cachePath: path.join(projectRoot, 'data', 'cerebro-descricoes.json'),
    command: config.cerebro?.describeCommand || DEFAULT_DESCRIBE_COMMAND,
    concurrency: config.cerebro?.describeConcurrency || 3,
    force, maxProjects,
    log: (m) => console.log(`Cérebro descrever: ${m}`),
  });
}

export async function nightly({ projectRoot, store, config }) {
  await scanCommand({ projectRoot, store, config });
  if (!config.obsidian?.vaultPath) return { rendered: false };
  await obsidianCommand({ projectRoot, args: ['render'], store, config });
  const descriptions = await describeNow({ projectRoot, store, config });
  const links = await linkNow({ projectRoot, store, config });
  await obsidianCommand({ projectRoot, args: ['render'], store, config });
  const suggestions = await suggestNow({ projectRoot, store, config });
  return { rendered: true, descriptions, links, suggestions };
}

function ruleFiles(config) {
  const homes = agentHomes(config);
  return [path.join(homes.codexHome, 'AGENTS.md'), path.join(homes.claudeHome, 'CLAUDE.md')];
}

export async function cerebroCommand({ projectRoot, args, store: suppliedStore = null, config: suppliedConfig = null }) {
  const action = args[0];
  const config = suppliedConfig || loadConfig(path.join(projectRoot, 'guardian.config.json'), { autoDetectRoots: false });
  if (action === 'rule') {
    const sub = args[1];
    if (sub === 'install') {
      if (!config.obsidian?.vaultPath) { console.error('Configure o cofre antes: guardian obsidian configure <cofre>'); process.exitCode = 1; return null; }
      for (const f of ruleFiles(config)) console.log(`${installRule(f, config.obsidian.vaultPath) ? 'regra instalada' : 'regra já presente'}: ${f}`);
      return true;
    }
    if (sub === 'remove') { for (const f of ruleFiles(config)) console.log(`${removeRule(f) ? 'regra removida' : 'sem regra'}: ${f}`); return true; }
  }
  if (action === 'nightly' || action === 'suggest' || action === 'limpar' || action === 'descrever' || action === 'ligar') {
    let created = null;
    try {
      created = suppliedStore ? null : await createStore(path.join(projectRoot, 'data', 'guardian.db'));
    } catch (e) {
      if (/locked/i.test(e.message)) { console.error('O serviço do Guardian está usando o banco. A rodada noturna já acontece dentro do serviço; para rodar agora: guardian service stop, guardian cerebro nightly, guardian service start.'); process.exitCode = 1; return null; }
      throw e;
    }
    const store = suppliedStore || created.store;
    try {
      if (action === 'limpar') return await limpar({ projectRoot, store, config, confirm: args.includes('--confirmar') });
      if (action === 'ligar') {
        const n = args.find((a) => /^\d+$/.test(a));
        const stats = await linkNow({ projectRoot, store, config, maxCalls: n ? Number(n) : 400 });
        if (config.obsidian?.vaultPath) await obsidianCommand({ projectRoot, args: ['render'], store, config });
        console.log(`Cérebro ligar: ${JSON.stringify(stats)}`);
        return stats;
      }
      if (action === 'descrever') {
        const n = args.find((a) => /^\d+$/.test(a));
        const stats = await describeNow({ projectRoot, store, config, force: args.includes('--todos'), maxProjects: n ? Number(n) : 0 });
        if (stats?.done && config.obsidian?.vaultPath) await obsidianCommand({ projectRoot, args: ['render'], store, config });
        console.log(`Cérebro descrever: ${JSON.stringify(stats)}`);
        return stats;
      }
      const result = action === 'nightly' ? await nightly({ projectRoot, store, config }) : await suggestNow({ projectRoot, store, config });
      console.log(`Cérebro ${action}: ${JSON.stringify(result)}`);
      return result;
    } finally { if (created) await store.close(); }
  }
  console.error('Usage: guardian cerebro <nightly|suggest|descrever [N] [--todos]|ligar [N]|limpar [--confirmar]|rule install|rule remove>'); process.exitCode = 1; return null;
}
