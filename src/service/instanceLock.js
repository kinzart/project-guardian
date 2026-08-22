import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export function readInstanceLock(lockPath) {
  if (!existsSync(lockPath)) return null;
  try { return JSON.parse(readFileSync(lockPath, 'utf8')); } catch { return { invalid: true }; }
}

export function acquireInstanceLock(lockPath, metadata = {}) {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), ...metadata }) + '\n');
      closeSync(fd);
      let released = false;
      return { release() { if (released) return; released = true; try { unlinkSync(lockPath); } catch (e) { if (e.code !== 'ENOENT') throw e; } } };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const current = readInstanceLock(lockPath);
      if (current && isProcessAlive(current.pid)) {
        const conflict = new Error(`Guardian is already running (PID ${current.pid}).`);
        conflict.code = 'GUARDIAN_ALREADY_RUNNING';
        throw conflict;
      }
      try { unlinkSync(lockPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
  throw new Error('Could not acquire Guardian instance lock.');
}
