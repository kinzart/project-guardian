import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { taskCommandLine } from './windowsTask.js';

export function startupLauncherPath(env = process.env) {
  const appData = env.APPDATA;
  if (!appData) throw new Error('APPDATA is unavailable.');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Project Guardian.vbs');
}

export function installStartupLauncher(appRoot, env = process.env) {
  const filePath = startupLauncherPath(env); mkdirSync(path.dirname(filePath), { recursive: true });
  const command = taskCommandLine(appRoot).replaceAll('"', '""');
  writeFileSync(filePath, `Set shell = CreateObject("WScript.Shell")\r\nshell.Run "${command}", 0, False\r\n`, 'utf8');
  return filePath;
}
export function uninstallStartupLauncher(env = process.env) { const filePath = startupLauncherPath(env); if (existsSync(filePath)) unlinkSync(filePath); return filePath; }
export function hasStartupLauncher(env = process.env) { return existsSync(startupLauncherPath(env)); }
