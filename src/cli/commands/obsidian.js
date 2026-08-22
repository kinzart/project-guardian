import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../config/loadConfig.js';
import { createStore } from '../../store/createStore.js';
import { refreshRuntimeStates } from '../../activity/runtime-rollup.js';
import { renderObsidianDashboard } from '../../obsidian/renderer.js';

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
    const result = renderObsidianDashboard({ vaultPath: config.obsidian.vaultPath, projects, runtimeStates, intelligence });
    console.log(`Obsidian dashboard ${result.changed ? 'updated' : 'unchanged'}: ${result.projectsRendered} project(s)`); return result;
  }
  console.error('Usage: guardian obsidian <status|configure|render>'); process.exitCode = 1; return null;
}
