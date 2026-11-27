import path from 'node:path';
import { loadConfig } from '../../config/loadConfig.js';
import { createStore } from '../../store/createStore.js';
import { scanCommand } from './scan.js';
import { obsidianCommand, agentHomes } from './obsidian.js';
import { indexSessions, mapSessionsToProjects } from '../../sessions/index.js';
import { findDuplicateGroups } from '../../cerebro/duplicates.js';
import { buildInventoryDigest, runSuggestions } from '../../cerebro/suggest.js';
import { installRule, removeRule } from '../../cerebro/rule.js';
import { cleanup } from '../../cerebro/cleanup.js';
import { groupProjects } from '../../cerebro/grouping.js';
import { appendFileSync, mkdirSync } from 'node:fs';

const ACTION_LABEL = { lixeira: 'enviado para a Lixeira', recusado: 'NÃO apagado', erro: 'erro', pendente: 'vai para a Lixeira' };

export async function limpar({ projectRoot, store, config, confirm, recycle }) {
  const rendered = await obsidianCommand({ projectRoot, args: ['render'], store, config });
  const marked = rendered?.marked || [];
  if (!marked.length) { console.log('Nenhum projeto marcado para excluir (propriedade "excluir" ou #apagar).'); return []; }
  const results = cleanup(marked, { roots: config.scanRoots || [], projects: await store.listProjects(), confirm, recycle });
  for (const r of results) console.log(`- ${r.project.name} (${r.project.root_path}): ${ACTION_LABEL[r.action]}${r.reason ? ` — ${r.reason}` : ''}`);
  if (!confirm) console.log('\nNada foi apagado. Confira a lista e rode: guardian cerebro limpar --confirmar');
  else {
    const log = path.join(config.obsidian.vaultPath, 'Project Guardian', 'Limpeza.md');
    mkdirSync(path.dirname(log), { recursive: true });
    appendFileSync(log, `\n## ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}\n${results.map((r) => `- ${r.project.name} — ${r.project.root_path}: ${ACTION_LABEL[r.action]}${r.reason ? ` (${r.reason})` : ''}`).join('\n')}\n`);
    for (const r of results) if (r.action === 'lixeira') await store.removeProject(r.project.id);
    if (results.some((r) => r.action === 'lixeira')) await scanCommand({ projectRoot, store, config }).then(() => obsidianCommand({ projectRoot, args: ['render'], store, config }));
  }
  return results;
}

export async function suggestNow({ projectRoot, store, config }) {
  if (!config.cerebro?.suggestCommand || !config.obsidian?.vaultPath) return null;
  const { items: projects } = groupProjects(await store.listProjects(), config.scanRoots || []);
  const sessions = await indexSessions({ ...agentHomes(config), cachePath: path.join(projectRoot, 'data', 'agent-sessions.json') });
  const digest = buildInventoryDigest(projects, mapSessionsToProjects(sessions, projects), findDuplicateGroups(projects));
  return runSuggestions({ command: config.cerebro.suggestCommand, digest, outPath: path.join(config.obsidian.vaultPath, 'Project Guardian', 'Sugestões.md') });
}

export async function nightly({ projectRoot, store, config }) {
  await scanCommand({ projectRoot, store, config });
  if (!config.obsidian?.vaultPath) return { rendered: false };
  await obsidianCommand({ projectRoot, args: ['render'], store, config });
  const suggestions = await suggestNow({ projectRoot, store, config });
  return { rendered: true, suggestions };
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
  if (action === 'nightly' || action === 'suggest' || action === 'limpar') {
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
      const result = action === 'nightly' ? await nightly({ projectRoot, store, config }) : await suggestNow({ projectRoot, store, config });
      console.log(`Cérebro ${action}: ${JSON.stringify(result)}`);
      return result;
    } finally { if (created) await store.close(); }
  }
  console.error('Usage: guardian cerebro <nightly|suggest|limpar [--confirmar]|rule install|rule remove>'); process.exitCode = 1; return null;
}
