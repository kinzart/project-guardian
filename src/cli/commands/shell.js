import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createStore } from '../../store/createStore.js';
import { loadConfig } from '../../config/loadConfig.js';
import { probePipe } from '../../shell/ipc-server.js';
import { extractBlock, computeHash } from '../../shell/installer.js';
import {
  HOOK_PATH,
  detectInstallations,
  readHookVersion,
  install,
  uninstall,
  restore,
  doctor as profileDoctor,
  readInstallState,
  writeInstallState,
} from '../../shell/powershell/profile-manager.js';
import {
  HOOK_PATH as GITBASH_HOOK_PATH,
  detectInstallations as detectGitBashInstallations,
  readHookVersion as readGitBashHookVersion,
  install as installGitBash,
  uninstall as uninstallGitBash,
  restore as restoreGitBash,
  doctor as gitBashDoctor,
  readInstallState as readGitBashInstallState,
  writeInstallState as writeGitBashInstallState,
} from '../../shell/gitbash/bash-manager.js';
import { fileURLToPath } from 'node:url';
import { detectWsl } from '../../shell/wsl/discovery.js';
import { generateAuthToken } from '../../shell/wsl/ipc-server.js';
import {
  checkLoginShell,
  detectStartupFile,
  toWslPath,
  install as installWsl,
  uninstall as uninstallWsl,
  restore as restoreWsl,
  doctor as wslDoctor,
  readInstallState as readWslInstallState,
  writeInstallState as writeWslInstallState,
  writeAuthToken,
} from '../../shell/wsl/manager.js';
import { probeWslTcp } from '../../shell/wsl/ipc-server.js';

const WSL_HOOK_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'shell', 'wsl', 'wsl-hook.sh');

function targetEditions(target) {
  if (target === 'pwsh') return ['pwsh'];
  if (target === 'windowspowershell' || target === '5.1') return ['windowsPowerShell'];
  return ['windowsPowerShell', 'pwsh']; // 'powershell' (default) — every detected edition
}

async function statusCommand({ projectRoot }) {
  const installations = detectInstallations();
  const hookVersion = readHookVersion();
  const dataDir = path.join(projectRoot, 'data');
  const state = readInstallState(dataDir);
  const pipeRunning = await probePipe();

  for (const [key, edition] of Object.entries(installations)) {
    console.log(`${edition.label}:`);
    console.log(`  detected: ${edition.detected ? 'yes' : 'no'}`);
    if (edition.detected) {
      console.log(`  profile: ${edition.profilePath}`);
      let installed = false;
      let profileHash = null;
      try {
        const content = readFileSync(edition.profilePath, 'utf8');
        profileHash = computeHash(content);
        installed = extractBlock(content) !== null;
      } catch {
        // profile file doesn't exist yet — not installed
      }
      console.log(`  installed: ${installed ? 'yes' : 'no'}`);
      if (profileHash) console.log(`  profile hash: ${profileHash.slice(0, 16)}`);
      console.log(`  hook version: ${installed ? hookVersion : 'n/a'}`);
      if (state[key]) console.log(`  last install: ${state[key].installedAt}`);
    }
    console.log('');
  }

  const gitbash = detectGitBashInstallations();
  const gitbashHookVersion = readGitBashHookVersion();
  const gitbashState = readGitBashInstallState(dataDir);
  console.log('Git Bash:');
  console.log(`  detected: ${gitbash.bashExe ? 'yes' : 'no'}${gitbash.bashExe ? ` (${gitbash.bashExe})` : ''}`);
  if (gitbash.bashExe) {
    for (const [key, file] of Object.entries(gitbash.files)) {
      console.log(`  ${file.label}:`);
      console.log(`    path: ${file.profilePath}`);
      let installed = false;
      let fileHash = null;
      try {
        const content = readFileSync(file.profilePath, 'utf8');
        fileHash = computeHash(content);
        installed = extractBlock(content) !== null;
      } catch {
        // file doesn't exist yet — not installed
      }
      console.log(`    installed: ${installed ? 'yes' : 'no'}`);
      if (fileHash) console.log(`    hash: ${fileHash.slice(0, 16)}`);
      console.log(`    hook version: ${installed ? gitbashHookVersion : 'n/a'}`);
      if (gitbashState[key]) console.log(`    last install: ${gitbashState[key].installedAt}`);
    }
  }
  console.log('');

  const wsl = detectWsl();
  const wslState = readWslInstallState(dataDir);
  console.log(`WSL installed: ${wsl.installed ? 'yes' : 'no'}`);
  if (wsl.installed) {
    for (const distro of wsl.distros) {
      console.log(`Distro ${distro.name}${distro.isDefault ? ' (default)' : ''}:`);
      console.log(`  state: ${distro.state}`);
      console.log(`  WSL version: ${distro.wslVersion}`);
      const key = distro.name;
      if (wslState[key]) {
        console.log(`  hook installed: yes (${wslState[key].startupFile})`);
        console.log(`  last install: ${wslState[key].installedAt}`);
      } else {
        console.log('  hook installed: no');
      }
    }
  }
  const wslPortOpen = await probeWslTcp();
  console.log(`WSL IPC: ${wslPortOpen ? 'running' : 'stopped'}`);
  console.log('');

  console.log(`IPC: ${pipeRunning ? 'running' : 'stopped'}`);

  const { store } = await createStore(path.join(projectRoot, 'data', 'guardian.db'));
  const events = await store.listShellEvents({});
  await store.close();
  const last = events[events.length - 1];
  console.log(`Last shell event: ${last ? `${last.timestamp} ${last.type}` : 'none'}`);
}

async function doctorCommand({ projectRoot }) {
  const installations = detectInstallations();
  const pipeRunning = await probePipe();
  let issues = 0;

  for (const edition of Object.values(installations)) {
    console.log(`${edition.label}:`);
    if (!edition.detected) {
      console.log('  not detected — skipped');
      console.log('');
      continue;
    }
    const checks = profileDoctor({ profilePath: edition.profilePath });
    console.log(`  profile found: ${checks.profileFound}`);
    console.log(`  parseable: ${checks.parseable}`);
    console.log(`  Guardian block present: ${checks.blockPresent}`);
    console.log(`  Guardian block intact: ${checks.blockIntact}`);
    console.log(`  duplicate markers: ${checks.duplicateMarkers}`);
    console.log(`  encoding ok: ${checks.encodingOk}`);
    if (checks.duplicateMarkers || (checks.profileFound && checks.blockPresent && !checks.blockIntact) || !checks.encodingOk) issues += 1;
    console.log('');
  }

  console.log(`hook version (PowerShell): ${readHookVersion() || 'not found'}`);

  const gitbash = detectGitBashInstallations();
  console.log('');
  console.log('Git Bash:');
  if (!gitbash.bashExe) {
    console.log('  not detected — skipped');
  } else {
    for (const file of Object.values(gitbash.files)) {
      console.log(`  ${file.label}:`);
      const checks = gitBashDoctor({ profilePath: file.profilePath });
      console.log(`    file found: ${checks.profileFound}`);
      console.log(`    parseable: ${checks.parseable}`);
      console.log(`    Guardian block present: ${checks.blockPresent}`);
      console.log(`    Guardian block intact: ${checks.blockIntact}`);
      console.log(`    duplicate markers: ${checks.duplicateMarkers}`);
      console.log(`    encoding ok: ${checks.encodingOk}`);
      if (checks.duplicateMarkers || (checks.profileFound && checks.blockPresent && !checks.blockIntact) || !checks.encodingOk) issues += 1;
    }
    console.log(`  hook version: ${readGitBashHookVersion() || 'not found'}`);
  }

  const wsl = detectWsl();
  console.log('');
  console.log(`WSL installed: ${wsl.installed ? 'yes' : 'no'}`);
  if (wsl.installed) {
    for (const distro of wsl.distros) {
      console.log(`Distro ${distro.name}:`);
      console.log(`  state: ${distro.state}`);
      console.log(`  WSL version: ${distro.wslVersion}`);
      const loginShell = checkLoginShell(distro.name);
      console.log(`  bash detected: ${loginShell.supported ? 'yes' : `no (${loginShell.reason})`}`);
      if (loginShell.supported) {
        const checks = wslDoctor({ distro: distro.name, startupFile: detectStartupFile(distro.name, 'login') });
        console.log(`  startup file found: ${checks.fileFound}`);
        console.log(`  Guardian block present: ${checks.blockPresent}`);
        console.log(`  Guardian block intact: ${checks.blockIntact}`);
        console.log(`  duplicate markers: ${checks.duplicateMarkers}`);
        if (checks.duplicateMarkers || (checks.fileFound && checks.blockPresent && !checks.blockIntact)) issues += 1;
      }
    }
  }
  const wslPortOpen = await probeWslTcp();
  console.log(`  WSL transport connectivity: ${wslPortOpen ? 'ok' : 'no server listening'}`);

  console.log('');
  console.log(`IPC connectivity: ${pipeRunning ? 'ok' : 'no server listening (Guardian not running, or not yet started)'}`);
  console.log('');
  console.log(issues === 0 ? 'No issues found. Nothing was changed (run `guardian shell install <target>` explicitly to fix).' : `${issues} issue(s) found. Nothing was auto-fixed — review above.`);
  if (issues > 0) process.exitCode = 1;
}

async function installCommand({ projectRoot, target }) {
  const installations = detectInstallations();
  const dataDir = path.join(projectRoot, 'data');
  const backupDir = path.join(dataDir, 'shell-backups');
  const state = readInstallState(dataDir);

  for (const key of targetEditions(target)) {
    const edition = installations[key];
    if (!edition.detected) {
      console.log(`${edition.label}: not detected — skipped`);
      continue;
    }
    const result = install({ profilePath: edition.profilePath, backupDir, hookPath: HOOK_PATH });
    const block = extractBlock(readFileSync(edition.profilePath, 'utf8'));
    state[key] = { installedAt: new Date().toISOString(), profilePath: edition.profilePath, blockHash: computeHash(block), backupPath: result.backupPath };
    console.log(`${edition.label}: ${result.alreadyInstalled ? 'reinstalled (updated)' : 'installed'} into ${edition.profilePath}`);
    console.log(`  backup: ${result.backupPath}`);
  }
  writeInstallState(dataDir, state);
  console.log('');
  console.log('New PowerShell sessions will load the Guardian hook. Already-open sessions are not modified.');
}

async function uninstallCommand({ projectRoot, target }) {
  const installations = detectInstallations();
  const dataDir = path.join(projectRoot, 'data');
  const backupDir = path.join(dataDir, 'shell-backups');
  const state = readInstallState(dataDir);

  for (const key of targetEditions(target)) {
    const edition = installations[key];
    if (!edition.detected) {
      console.log(`${edition.label}: not detected — skipped`);
      continue;
    }
    const result = uninstall({ profilePath: edition.profilePath, backupDir });
    if (result.removed) {
      delete state[key];
      console.log(`${edition.label}: Guardian block removed from ${edition.profilePath}`);
      console.log(`  backup: ${result.backupPath}`);
    } else {
      console.log(`${edition.label}: ${result.reason}`);
    }
  }
  writeInstallState(dataDir, state);
}

async function restoreCommand({ projectRoot, target }) {
  const installations = detectInstallations();
  const dataDir = path.join(projectRoot, 'data');
  const state = readInstallState(dataDir);

  for (const key of targetEditions(target)) {
    const edition = installations[key];
    if (!edition.detected) {
      console.log(`${edition.label}: not detected — skipped`);
      continue;
    }
    const result = restore({ profilePath: edition.profilePath, lastInstalledBlockHash: state[key]?.blockHash });
    console.log(`${edition.label}: ${result.restored ? 'ok' : 'refused'} — ${result.reason}`);
  }
}

function hookPathCommand(target) {
  if (target === 'gitbash') {
    console.log(GITBASH_HOOK_PATH);
    console.log('This is for manual `source "<path>"` only — `guardian shell install gitbash` is what wires it into .bashrc/.bash_profile automatically.');
    return;
  }
  if (target === 'wsl') {
    console.log(WSL_HOOK_PATH);
    console.log('This is for manual `source "<path>"` INSIDE a distro only — `guardian shell install wsl` is what wires it into the distro\'s startup file automatically.');
    return;
  }
  console.log(HOOK_PATH);
  console.log('This is for manual dot-sourcing only (`. "<path>"`) — `guardian shell install powershell` is what wires it into your profile automatically.');
}

async function installGitBashCommand({ projectRoot }) {
  const gitbash = detectGitBashInstallations();
  const dataDir = path.join(projectRoot, 'data');
  const backupDir = path.join(dataDir, 'shell-backups');
  const state = readGitBashInstallState(dataDir);

  if (!gitbash.bashExe) {
    console.log('Git Bash: not detected — skipped');
    return;
  }
  for (const [key, file] of Object.entries(gitbash.files)) {
    const result = installGitBash({ profilePath: file.profilePath, backupDir, hookPath: GITBASH_HOOK_PATH });
    const block = extractBlock(readFileSync(file.profilePath, 'utf8'));
    state[key] = { installedAt: new Date().toISOString(), profilePath: file.profilePath, blockHash: computeHash(block), backupPath: result.backupPath };
    console.log(`${file.label}: ${result.alreadyInstalled ? 'reinstalled (updated)' : 'installed'} into ${file.profilePath}`);
    console.log(`  backup: ${result.backupPath}`);
  }
  writeGitBashInstallState(dataDir, state);
  console.log('');
  console.log('New Git Bash sessions will load the Guardian hook. Already-open sessions are not modified.');
}

async function uninstallGitBashCommand({ projectRoot }) {
  const gitbash = detectGitBashInstallations();
  const dataDir = path.join(projectRoot, 'data');
  const backupDir = path.join(dataDir, 'shell-backups');
  const state = readGitBashInstallState(dataDir);

  if (!gitbash.bashExe) {
    console.log('Git Bash: not detected — skipped');
    return;
  }
  for (const [key, file] of Object.entries(gitbash.files)) {
    const result = uninstallGitBash({ profilePath: file.profilePath, backupDir });
    if (result.removed) {
      delete state[key];
      console.log(`${file.label}: Guardian block removed from ${file.profilePath}`);
      console.log(`  backup: ${result.backupPath}`);
    } else {
      console.log(`${file.label}: ${result.reason}`);
    }
  }
  writeGitBashInstallState(dataDir, state);
}

async function restoreGitBashCommand({ projectRoot }) {
  const gitbash = detectGitBashInstallations();
  const dataDir = path.join(projectRoot, 'data');
  const state = readGitBashInstallState(dataDir);

  if (!gitbash.bashExe) {
    console.log('Git Bash: not detected — skipped');
    return;
  }
  for (const [key, file] of Object.entries(gitbash.files)) {
    const result = restoreGitBash({ profilePath: file.profilePath, lastInstalledBlockHash: state[key]?.blockHash });
    console.log(`${file.label}: ${result.restored ? 'ok' : 'refused'} — ${result.reason}`);
  }
}

// Selects which detected distros a `--distro X` command applies to. Never silently touches an
// undetected/unknown distro — refuses and explains instead. Exported (pure logic, no real WSL
// needed) so this refusal behavior is provable by a unit test even on a machine with no distros
// registered — see test/wsl-cli.test.js.
export function selectDistros(wsl, distroFilter) {
  if (!distroFilter) return { distros: wsl.distros, error: null };
  const match = wsl.distros.find((d) => d.name.toLowerCase() === distroFilter.toLowerCase());
  if (!match) return { distros: [], error: `No detected WSL distro named "${distroFilter}". Detected: ${wsl.distros.map((d) => d.name).join(', ') || '(none)'}` };
  return { distros: [match], error: null };
}

async function installWslCommand({ projectRoot, distroFilter }) {
  const wsl = detectWsl();
  if (!wsl.installed) {
    console.log('WSL: not detected — skipped');
    return;
  }
  const { distros, error } = selectDistros(wsl, distroFilter);
  if (error) {
    console.error(error);
    process.exitCode = 1;
    return;
  }

  const dataDir = path.join(projectRoot, 'data');
  const backupDir = path.join(dataDir, 'shell-backups');
  const state = readWslInstallState(dataDir);
  writeAuthToken(dataDir, generateAuthToken()); // fresh each install — never baked into a startup file

  console.log(distroFilter ? `Installing into distro "${distroFilter}":` : 'Installing into all detected distros:');
  for (const distro of distros) {
    const loginShell = checkLoginShell(distro.name);
    if (!loginShell.supported) {
      console.log(`${distro.name}: ${loginShell.reason} — startup files not modified`);
      continue;
    }
    const startupFile = detectStartupFile(distro.name, 'login');
    if (!startupFile) {
      console.log(`${distro.name}: could not determine a startup file — startup files not modified`);
      continue;
    }
    const wslHookLinuxPath = toWslPath(distro.name, WSL_HOOK_PATH);
    const repoWslDataPath = toWslPath(distro.name, dataDir);
    if (!wslHookLinuxPath || !repoWslDataPath) {
      console.log(`${distro.name}: could not translate Windows paths via wslpath — startup files not modified`);
      continue;
    }
    const result = installWsl({ distro: distro.name, startupFile, wslHookLinuxPath, repoWslDataPath, backupDir });
    if (!result.installed) {
      console.log(`${distro.name}: install failed — ${result.reason}`);
      continue;
    }
    state[distro.name] = { installedAt: new Date().toISOString(), startupFile, linuxPath: result.linuxPath, blockHash: result.afterHash, backupPath: result.backupPath };
    console.log(`${distro.name}: ${result.alreadyInstalled ? 'reinstalled (updated)' : 'installed'} into ${result.linuxPath}`);
    console.log(`  backup: ${result.backupPath}`);
  }
  writeWslInstallState(dataDir, state);
  console.log('');
  console.log('New WSL shell sessions will load the Guardian hook. Already-open sessions are not modified.');
}

async function uninstallWslCommand({ projectRoot, distroFilter }) {
  const wsl = detectWsl();
  if (!wsl.installed) {
    console.log('WSL: not detected — skipped');
    return;
  }
  const { distros, error } = selectDistros(wsl, distroFilter);
  if (error) {
    console.error(error);
    process.exitCode = 1;
    return;
  }

  const dataDir = path.join(projectRoot, 'data');
  const backupDir = path.join(dataDir, 'shell-backups');
  const state = readWslInstallState(dataDir);

  for (const distro of distros) {
    const startupFile = state[distro.name]?.startupFile || detectStartupFile(distro.name, 'login');
    if (!startupFile) {
      console.log(`${distro.name}: could not determine a startup file — skipped`);
      continue;
    }
    const result = uninstallWsl({ distro: distro.name, startupFile, backupDir });
    if (result.removed) {
      delete state[distro.name];
      console.log(`${distro.name}: Guardian block removed`);
      console.log(`  backup: ${result.backupPath}`);
    } else {
      console.log(`${distro.name}: ${result.reason}`);
    }
  }
  writeWslInstallState(dataDir, state);
}

async function restoreWslCommand({ projectRoot, distroFilter }) {
  const wsl = detectWsl();
  if (!wsl.installed) {
    console.log('WSL: not detected — skipped');
    return;
  }
  const { distros, error } = selectDistros(wsl, distroFilter);
  if (error) {
    console.error(error);
    process.exitCode = 1;
    return;
  }

  const dataDir = path.join(projectRoot, 'data');
  const state = readWslInstallState(dataDir);
  for (const distro of distros) {
    const startupFile = state[distro.name]?.startupFile;
    if (!startupFile) {
      console.log(`${distro.name}: no known prior install — refusing to guess`);
      continue;
    }
    const result = restoreWsl({ distro: distro.name, startupFile, lastInstalledBlockHash: state[distro.name]?.blockHash });
    console.log(`${distro.name}: ${result.restored ? 'ok' : 'refused'} — ${result.reason}`);
  }
}

// `guardian shell <status|doctor|install|uninstall|restore|hook-path> [powershell|pwsh|gitbash|wsl] [--distro <name>]`
export async function shellCommand({ projectRoot, args }) {
  const [sub, target, ...rest] = args;
  loadConfig(path.join(projectRoot, 'guardian.config.json'), { autoDetectRoots: false });

  const distroIdx = rest.indexOf('--distro');
  const distroFilter = distroIdx !== -1 ? rest[distroIdx + 1] : null;

  switch (sub) {
    case 'status':
      return statusCommand({ projectRoot });
    case 'doctor':
      return doctorCommand({ projectRoot });
    case 'install':
      if (target === 'gitbash') return installGitBashCommand({ projectRoot });
      if (target === 'wsl') return installWslCommand({ projectRoot, distroFilter });
      return installCommand({ projectRoot, target });
    case 'uninstall':
      if (target === 'gitbash') return uninstallGitBashCommand({ projectRoot });
      if (target === 'wsl') return uninstallWslCommand({ projectRoot, distroFilter });
      return uninstallCommand({ projectRoot, target });
    case 'restore':
      if (target === 'gitbash') return restoreGitBashCommand({ projectRoot });
      if (target === 'wsl') return restoreWslCommand({ projectRoot, distroFilter });
      return restoreCommand({ projectRoot, target });
    case 'hook-path':
      return hookPathCommand(target);
    default:
      console.error('Usage: guardian shell <status|doctor|install|uninstall|restore|hook-path> [powershell|pwsh|gitbash|wsl] [--distro <name>]');
      process.exitCode = 1;
      return null;
  }
}
