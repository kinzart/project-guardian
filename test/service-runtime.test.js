import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { acquireInstanceLock, readInstanceLock } from '../src/service/instanceLock.js';
import { msUntilNextSchedule, pruneLogs, startMaintenanceScheduler } from '../src/service/maintenance.js';
import { installTask, taskCommandLine } from '../src/service/windowsTask.js';
import { hasStartupLauncher, installStartupLauncher, uninstallStartupLauncher } from '../src/service/startupLauncher.js';

test('single-instance lock rejects a live owner and releases cleanly', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'guardian-lock-')); const lockPath = path.join(root, 'data', 'guardian.lock');
  const lock = acquireInstanceLock(lockPath, { mode: 'test' });
  assert.equal(readInstanceLock(lockPath).pid, process.pid);
  assert.throws(() => acquireInstanceLock(lockPath), { code: 'GUARDIAN_ALREADY_RUNNING' });
  lock.release(); assert.equal(readInstanceLock(lockPath), null); await rm(root, { recursive: true });
});

test('stale instance lock is recovered', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'guardian-lock-')); const lockPath = path.join(root, 'guardian.lock'); writeFileSync(lockPath, '{"pid":99999999}');
  const lock = acquireInstanceLock(lockPath); assert.equal(readInstanceLock(lockPath).pid, process.pid); lock.release(); await rm(root, { recursive: true });
});

test('maintenance scheduler calculates the next configured wall-clock run', () => {
  assert.equal(msUntilNextSchedule(['08:00', '15:00', '22:00'], new Date('2026-08-21T14:00:00')), 3600000);
  let callback; const scheduler = startMaintenanceScheduler({ times: ['15:00'], run: async () => {}, setTimer: (fn) => { callback = fn; return { unref() {} }; } }); assert.equal(typeof callback, 'function'); scheduler.stop();
});

test('log retention removes expired files and enforces aggregate cap', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'guardian-logs-')); mkdirSync(root, { recursive: true });
  const old = path.join(root, 'old.log'); const a = path.join(root, 'a.log'); const b = path.join(root, 'b.log'); writeFileSync(old, 'old'); writeFileSync(a, '12345'); writeFileSync(b, '67890');
  utimesSync(old, new Date('2020-01-01'), new Date('2020-01-01')); utimesSync(a, new Date('2026-08-20'), new Date('2026-08-20')); utimesSync(b, new Date('2026-08-21'), new Date('2026-08-21'));
  const result = pruneLogs(root, { retentionDays: 30, maxTotalBytes: 5, now: new Date('2026-08-21').getTime() }); assert.equal(result.removed, 2); assert.equal(result.bytesRemaining, 5); await rm(root, { recursive: true });
});

test('Windows task uses user-logon trigger and limited privileges', () => {
  let call; const runner = (exe, args) => { call = { exe, args }; return { status: 0, stdout: '', stderr: '' }; };
  assert.match(taskCommandLine('D:\\Guardian', 'C:\\Node\\node.exe'), /service-host$/);
  assert.equal(installTask('D:\\Guardian', runner).ok, true); assert.equal(call.exe, 'schtasks.exe'); assert.ok(call.args.includes('ONLOGON')); assert.ok(call.args.includes('LIMITED'));
});

test('startup launcher is hidden, user-scoped, and reversible', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'guardian-startup-')); const env = { APPDATA: root };
  const filePath = installStartupLauncher('D:\\Guardian', env); assert.equal(hasStartupLauncher(env), true); assert.match(filePath, /Startup/); uninstallStartupLauncher(env); assert.equal(hasStartupLauncher(env), false); await rm(root, { recursive: true });
});
