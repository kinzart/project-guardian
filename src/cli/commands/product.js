import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../config/loadConfig.js';
import { createStore } from '../../store/createStore.js';
import { shellCommand } from './shell.js';
import { agentCommand } from './agent.js';
import { serviceCommand } from './service.js';
import { scanCommand } from './scan.js';
import { doctorCommand } from './doctor.js';
import { detectClaudeCode } from '../../agent/claude/discovery.js';
import { detectCodex, globalHooksJsonPath } from '../../agent/codex/discovery.js';
import { doctor as codexDoctor } from '../../agent/codex/manager.js';
import { detectWsl } from '../../shell/wsl/discovery.js';

function report(projectRoot, name, lines) { const dir = path.join(projectRoot, 'reports'); mkdirSync(dir, { recursive: true }); const filePath = path.join(dir, name); writeFileSync(filePath, `${lines.join('\n')}\n`); return filePath; }

export async function installCommand({ projectRoot, appRoot = projectRoot }) {
  const lines = ['# Project Guardian install report', '', `Time: ${new Date().toISOString()}`, `Node: ${process.version}`];
  if (Number(process.versions.node.split('.')[0]) < 18) throw new Error('Node.js 18 or newer is required.');
  const config = loadConfig(path.join(projectRoot, 'guardian.config.json'));
  const { store } = await createStore(path.join(projectRoot, 'data', 'guardian.db')); const existing = await store.listProjects(); await store.close();
  if (config.scanRoots.length) { await scanCommand({ projectRoot }); lines.push('Initial scan: PASS'); } else lines.push(`Initial scan: SKIPPED_NO_ROOTS (preserved ${existing.length} existing projects)`);
  await shellCommand({ projectRoot, args: ['install', 'powershell'] });
  await shellCommand({ projectRoot, args: ['install', 'gitbash'] });
  if (detectWsl().installed) await shellCommand({ projectRoot, args: ['install', 'wsl'] }); else console.log('WSL: NOT_INSTALLED / OPTIONAL');
  if (detectClaudeCode().installed) await agentCommand({ projectRoot, args: ['install', 'claude'] }); else console.log('Claude: NOT_INSTALLED / OPTIONAL');
  if (detectCodex().installed) await agentCommand({ projectRoot, args: ['install', 'codex'] }); else console.log('Codex: NOT_INSTALLED / OPTIONAL');
  await serviceCommand({ projectRoot, appRoot, args: ['install'] });
  await serviceCommand({ projectRoot, appRoot, args: ['start'] });
  await doctorCommand({ projectRoot, args: [] });
  const trust = codexDoctor({ hooksJsonPath: globalHooksJsonPath() }).trustStatus || {};
  const pending = Object.values(trust).some((v) => v !== 'trusted');
  lines.push('PowerShell hooks: installed', 'Git Bash hooks: installed', `WSL: ${detectWsl().installed ? 'installed' : 'NOT_INSTALLED / OPTIONAL'}`, `Claude: ${detectClaudeCode().installed ? 'installed' : 'NOT_INSTALLED / OPTIONAL'}`, `Codex: ${detectCodex().installed ? 'installed' : 'NOT_INSTALLED / OPTIONAL'}`, `Codex trust: ${pending ? 'MANUAL ACTION REQUIRED — open Codex and use /hooks' : 'trusted'}`, 'Background runtime: configured');
  const filePath = report(projectRoot, 'INSTALL_REPORT.md', lines); console.log(`Install report: ${filePath}`); if (pending) console.log('MANUAL ACTION REQUIRED: open Codex, run /hooks, and trust the Guardian entries.');
}

export async function uninstallCommand({ projectRoot, appRoot = projectRoot }) {
  await serviceCommand({ projectRoot, appRoot, args: ['stop'] });
  await serviceCommand({ projectRoot, appRoot, args: ['uninstall'] });
  await agentCommand({ projectRoot, args: ['uninstall', 'codex'] });
  await agentCommand({ projectRoot, args: ['uninstall', 'claude'] });
  await shellCommand({ projectRoot, args: ['uninstall', 'gitbash'] });
  await shellCommand({ projectRoot, args: ['uninstall', 'powershell'] });
  if (detectWsl().installed) await shellCommand({ projectRoot, args: ['uninstall', 'wsl'] });
  console.log('Guardian runtime and owned hooks removed. Projects, database, config, reports, and Obsidian notes were preserved.');
}

export async function repairCommand({ projectRoot, appRoot = projectRoot }) {
  console.log('Guardian repair audit (diagnostic only)');
  await doctorCommand({ projectRoot, args: [] });
  await serviceCommand({ projectRoot, appRoot, args: ['doctor'] });
  await shellCommand({ projectRoot, args: ['doctor'] });
  await agentCommand({ projectRoot, args: ['doctor', 'claude'] });
  await agentCommand({ projectRoot, args: ['doctor', 'codex'] });
  console.log('Nothing was changed. Run the relevant explicit install command for any reported issue.');
}
