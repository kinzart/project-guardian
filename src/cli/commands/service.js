import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isProcessAlive, readInstanceLock } from '../../service/instanceLock.js';
import { installTask, queryTask, runTask, stopTask, uninstallTask } from '../../service/windowsTask.js';
import { hasStartupLauncher, installStartupLauncher, startupLauncherPath, uninstallStartupLauncher } from '../../service/startupLauncher.js';

function printResult(label, result) {
  console.log(`${label}: ${result.ok ? 'OK' : 'FAILED'}`);
  if (!result.ok) {
    const detail = (result.stderr || result.stdout).trim();
    if (detail) console.error(detail);
    process.exitCode = 1;
  }
}

export async function serviceCommand({ projectRoot, appRoot = projectRoot, args }) {
  const action = args[0] || 'status';
  if (process.platform !== 'win32') { console.error('Guardian background service management is Windows-only.'); process.exitCode = 1; return; }
  if (action === 'status' || action === 'doctor') {
    const task = queryTask();
    const startup = hasStartupLauncher();
    const lock = readInstanceLock(path.join(projectRoot, 'data', 'guardian.lock'));
    const hostLock = readInstanceLock(path.join(projectRoot, 'data', 'guardian-host.lock'));
    console.log(`Auto-start task: ${task.ok ? 'installed' : 'not installed'}`);
    console.log(`Startup launcher: ${startup ? 'installed' : 'not installed'}`);
    console.log(`Runtime lock: ${lock?.pid ? `${isProcessAlive(lock.pid) ? 'active' : 'stale'} (PID ${lock.pid})` : 'absent'}`);
    console.log(`Recovery supervisor: ${hostLock?.pid && isProcessAlive(hostLock.pid) ? `active (PID ${hostLock.pid})` : 'inactive'}`);
    if (action === 'doctor') console.log(`User-context access: ${process.env.USERPROFILE ? 'available' : 'unknown'}`);
    return;
  }
  if (action === 'install') {
    const task = installTask(appRoot);
    if (task.ok) return printResult('Install scheduled task', task);
    const filePath = installStartupLauncher(appRoot);
    console.log(`Install startup launcher: OK (${filePath})`);
    return;
  }
  if (action === 'start') { const task = queryTask(); if (task.ok) return printResult('Start', runTask()); const result = spawnSync('wscript.exe', [startupLauncherPath()], { windowsHide: true, encoding: 'utf8' }); return printResult('Start', { ok: result.status === 0, ...result }); }
  if (action === 'stop') { const host = readInstanceLock(path.join(projectRoot, 'data', 'guardian-host.lock')); if (host?.pid && isProcessAlive(host.pid)) { const result = spawnSync('taskkill.exe', ['/PID', String(host.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true }); return printResult('Stop', { ok: result.status === 0, ...result }); } const task = stopTask(); if (!task.ok) { console.log('Stop: Guardian is not running'); return; } return printResult('Stop', task); }
  if (action === 'restart') { await serviceCommand({ projectRoot, args: ['stop'] }); process.exitCode = 0; return serviceCommand({ projectRoot, args: ['start'] }); }
  if (action === 'uninstall') { const task = uninstallTask(); uninstallStartupLauncher(); if (!task.ok) console.log('Scheduled task: not installed'); console.log('Uninstall auto-start: OK'); return; }
  console.error('Usage: guardian service <status|doctor|install|start|stop|restart|uninstall>'); process.exitCode = 1;
}
