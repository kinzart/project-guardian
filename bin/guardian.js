#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runCli } from '../src/cli/index.js';

// GUARDIAN_HOME lets tests (and, later, alternate install layouts) point the CLI at an
// isolated sandbox instead of this checkout's own guardian.config.json/data/reports/logs.
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installedHome = process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'Project Guardian')
  : path.join(os.homedir(), '.project-guardian');
const projectRoot = process.env.GUARDIAN_HOME
  ? path.resolve(process.env.GUARDIAN_HOME)
  : existsSync(path.join(appRoot, '.git')) ? appRoot : installedHome;
mkdirSync(projectRoot, { recursive: true });

runCli(process.argv.slice(2), { projectRoot, appRoot }).catch((err) => {
  console.error('Guardian command failed:', err.message);
  process.exitCode = 1;
});
