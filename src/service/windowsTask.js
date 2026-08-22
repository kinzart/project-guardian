import { spawnSync } from 'node:child_process';
import path from 'node:path';

export const TASK_NAME = 'Project Guardian';

function runSchtasks(args, runner = spawnSync) {
  const result = runner('schtasks.exe', args, { encoding: 'utf8', windowsHide: true });
  return { ok: result.status === 0, status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

export function taskCommandLine(appRoot, nodePath = process.execPath) {
  return `"${nodePath}" "${path.join(appRoot, 'bin', 'guardian.js')}" service-host`;
}

export function queryTask(runner) { return runSchtasks(['/Query', '/TN', TASK_NAME, '/FO', 'LIST', '/V'], runner); }
export function installTask(appRoot, runner) { return runSchtasks(['/Create', '/F', '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TN', TASK_NAME, '/TR', taskCommandLine(appRoot)], runner); }
export function runTask(runner) { return runSchtasks(['/Run', '/TN', TASK_NAME], runner); }
export function stopTask(runner) { return runSchtasks(['/End', '/TN', TASK_NAME], runner); }
export function uninstallTask(runner) { return runSchtasks(['/Delete', '/F', '/TN', TASK_NAME], runner); }
