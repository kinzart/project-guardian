import { spawn } from 'node:child_process';
import path from 'node:path';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { acquireInstanceLock } from '../../service/instanceLock.js';

export async function serviceHostCommand({ projectRoot, appRoot = projectRoot }) {
  const hostLock = acquireInstanceLock(path.join(projectRoot, 'data', 'guardian-host.lock'), { mode: 'supervisor' });
  process.once('exit', () => hostLock.release());
  let stopping = false;
  let child = null;
  const stop = () => { stopping = true; child?.kill('SIGTERM'); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (!stopping) {
    const logsDir = path.join(projectRoot, 'logs'); mkdirSync(logsDir, { recursive: true });
    const logFd = openSync(path.join(logsDir, 'runtime.log'), 'a');
    child = spawn(process.execPath, [path.join(appRoot, 'bin', 'guardian.js'), 'observe', '--service'], {
      cwd: projectRoot, windowsHide: true, stdio: ['ignore', logFd, logFd],
    });
    closeSync(logFd);
    const outcome = await new Promise((resolve) => {
      child.once('error', (error) => resolve({ error }));
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    child = null;
    if (stopping) break;
    console.error(`Guardian runtime stopped unexpectedly (${outcome.error?.message || outcome.signal || `code ${outcome.code}`}); restarting in 5 seconds.`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  hostLock.release();
}
