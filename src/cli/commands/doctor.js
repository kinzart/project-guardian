import { existsSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { loadConfig } from '../../config/loadConfig.js';
import { createStore } from '../../store/createStore.js';

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

export async function doctorCommand({ projectRoot }) {
  const checks = [];

  checks.push({ name: 'Node version', ok: true, detail: process.version });

  const gitVersion = await run('git', ['--version']);
  checks.push({ name: 'Git available', ok: !!gitVersion, detail: gitVersion || 'git not found on PATH' });

  const configPath = path.join(projectRoot, 'guardian.config.json');
  let configExists = existsSync(configPath);
  let config = null;
  let configError = null;
  try {
    config = loadConfig(configPath, { autoDetectRoots: false });
    configExists = existsSync(configPath);
  } catch (err) {
    configError = err.message;
  }
  checks.push({ name: 'Config readable', ok: configExists && !configError, detail: configError || configPath });

  if (config) {
    const missingRoots = (config.scanRoots || []).filter((r) => !existsSync(r));
    checks.push({
      name: 'Scan roots exist',
      ok: missingRoots.length === 0,
      detail: missingRoots.length ? `missing: ${missingRoots.join(', ')}` : `${config.scanRoots.length} root(s) configured`,
    });
  }

  let backend = 'unknown';
  let storeOk = false;
  let lastScan = null;
  try {
    const created = await createStore(path.join(projectRoot, 'data', 'guardian.db'));
    backend = created.backend;
    lastScan = await created.store.getLastScan();
    await created.store.close();
    storeOk = true;
  } catch (err) {
    checks.push({ name: 'Store reachable', ok: false, detail: err.message });
  }
  if (storeOk) {
    checks.push({ name: 'Store reachable', ok: true, detail: `backend: ${backend}` });
    checks.push({
      name: 'Last scan',
      ok: true,
      detail: lastScan ? `${lastScan.finished_at} (${lastScan.errors} errors)` : 'no scan has run yet',
    });
  }

  console.log('Project Guardian doctor');
  console.log('------------------------');
  let allOk = true;
  for (const check of checks) {
    if (!check.ok) allOk = false;
    console.log(`[${check.ok ? 'OK' : 'FAIL'}] ${check.name}: ${check.detail}`);
  }

  process.exitCode = allOk ? 0 : 1;
  return checks;
}
