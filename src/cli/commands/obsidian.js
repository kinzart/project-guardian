import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../config/loadConfig.js';
import { createStore } from '../../store/createStore.js';
import { refreshRuntimeStates } from '../../activity/runtime-rollup.js';
import os from 'node:os';
import { renderCerebroVault } from '../../obsidian/cerebro.js';
import { inventoryFolder } from '../../cerebro/inventory.js';
import { loadDescriptions } from '../../cerebro/describe.js';
import { indexSessions, mapSessionsToProjects } from '../../sessions/index.js';
import { groupProjects } from '../../cerebro/grouping.js';

export function agentHomes(config) {
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  return {
    codexHome: config.cerebro?.codexHome || process.env.CODEX_HOME || path.join(home, '.codex'),
    claudeHome: config.cerebro?.claudeHome || process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'),
    hermesHome: config.cerebro?.hermesHome || process.env.HERMES_HOME || path.join(local, 'hermes'),
  };
}

export async function renderVault({ projectRoot, config, projects: allProjects, runtimeStates, intelligence, homes = agentHomes(config), now = Date.now() }) {
  let projects = allProjects;
  const vaultNorm = String(config.obsidian.vaultPath).toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
  const inVault = (p) => { const n = String(p || '').toLowerCase().replace(/\\/g, '/'); return n === vaultNorm || n.startsWith(`${vaultNorm}/`); };
  const sessions = (await indexSessions({ ...homes, cachePath: path.join(projectRoot, 'data', 'agent-sessions.json') })).filter((s) => !inVault(s.cwd));
  projects = projects.filter((p) => !inVault(p.root_path));
  const { items, childrenOf, areaOf: areaByItem } = groupProjects(projects, config.scanRoots || [], sessions);
  return renderCerebroVault({
    vaultPath: config.obsidian.vaultPath,
    projects: items,
    childrenOf,
    areaByItem,
    runtimeStates,
    intelligence,
    sessionsByProject: mapSessionsToProjects(sessions, items),
    roots: config.scanRoots || [],
    now,
    archiveDays: config.cerebro?.archiveDays ?? 365,
    descriptions: loadDescriptions(path.join(projectRoot, 'data', 'cerebro-descricoes.json')),
    inventoryOf: config.cerebro?.inventory === false ? null : (p) => inventoryFolder(p.root_path, { skip: config.exclude || [], maxFiles: config.cerebro?.inventoryMaxFiles || 20000 }),
  });
}

function configured(config) { return Boolean(config.obsidian?.vaultPath); }

export async function obsidianCommand({ projectRoot, args, store: suppliedStore = null, config: suppliedConfig = null }) {
  const action = args[0] || 'status'; const configPath = path.join(projectRoot, 'guardian.config.json');
  const config = suppliedConfig || loadConfig(configPath, { autoDetectRoots: false });
  if (action === 'status') { console.log(`Obsidian vault: ${configured(config) ? config.obsidian.vaultPath : 'NOT_CONFIGURED'}`); return config.obsidian; }
  if (action === 'configure') {
    const vault = args[1] ? path.resolve(args[1]) : null;
    if (!vault || !existsSync(vault) || !existsSync(path.join(vault, '.obsidian'))) { console.error('Usage: guardian obsidian configure <existing-vault-path>'); process.exitCode = 1; return null; }
    const raw = JSON.parse(readFileSync(configPath, 'utf8')); raw.obsidian = { ...(raw.obsidian || {}), vaultPath: vault, debounceMs: raw.obsidian?.debounceMs || 2000 };
    writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`); console.log(`Obsidian vault configured: ${vault}`); return raw.obsidian;
  }
  if (action === 'render') {
    if (!configured(config)) { console.error('Obsidian vault is not configured. Run `guardian obsidian configure <existing-vault-path>`.'); process.exitCode = 1; return null; }
    const store = suppliedStore || (await createStore(path.join(projectRoot, 'data', 'guardian.db'))).store;
    const runtimeStates = await refreshRuntimeStates(store); const projects = await store.listProjects(); const intelligence = await store.listIntelligence(); if (!suppliedStore) await store.close();
    const result = await renderVault({ projectRoot, config, projects, runtimeStates, intelligence });
    console.log(`Obsidian dashboard ${result.changed ? 'updated' : 'unchanged'}: ${result.projectsRendered} project(s)`); return result;
  }
  console.error('Usage: guardian obsidian <status|configure|render>'); process.exitCode = 1; return null;
}
