import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { detectDefaultRoots } from './defaultRoots.js';

const DEFAULTS = {
  scanRoots: [],
  // Roots (e.g. a Google Drive streaming mount) where Guardian only lists and stats entries and
  // never opens a file, so cloud-only files are not downloaded by a scan.
  metadataOnlyRoots: [],
  exclude: [
    'node_modules',
    '.git',
    'dist',
    'build',
    'coverage',
    '.cache',
    '.next',
    '.nuxt',
    'vendor',
    'venv',
    '.venv',
    '__pycache__',
    'AppData',
    'Windows',
    'Program Files',
    'Program Files (x86)',
    'ProgramData',
    'System Volume Information',
    '$Recycle.Bin',
    '$SysReset',
    '$WINDOWS.~BT',
    '$WinREAgent',
    '$Windows.~WS',
    'Recovery',
    'PerfLogs',
    'boot',
    'MSOCache',
    'ESD',
    'OneDriveTemp',
    'GoogleDriveCache',
    // Package-manager caches and SDK/tooling directories: real installs, not personal projects.
    '.npm',
    '.nvm',
    '.yarn',
    '.pnpm-store',
    '.cargo',
    '.rustup',
    '.gradle',
    '.m2',
    '.nuget',
    '.gem',
    '.rvm',
    '.conda',
    '.docker',
    '.eclipse',
    '.android',
    '.vscode-server',
  ],
  // Compound path suffixes (not bare directory names) excluded only in this specific nested
  // location — e.g. a real project may legitimately have its own "extensions" folder, so only
  // ".vscode/extensions" (installed editor extensions) is noise, not "extensions" everywhere.
  excludePaths: ['.vscode/extensions', '.vscode-insiders/extensions'],
  maxDepth: 8,
  maxDirectoriesVisited: 50000,
  confidenceThresholds: { high: 55, medium: 30, low: 10 },
  activityThresholds: { activeHours: 48, warmDays: 7, staleDays: 30 },
  // V0.3 — guardian watch. debounceMs: how long a project must go quiet before its buffered
  // events are coalesced into one refresh. settleMs: hard cap — a project under continuous
  // activity is force-flushed after this long even if events keep arriving, so a busy build
  // never defers its refresh forever.
  watch: { debounceMs: 800, settleMs: 5000 },
  // V0.4 — guardian observe / process observer. captureCommandLine: "sanitized-minimal" never
  // persists a raw command line (see src/process/sanitizer.js); "none" disables extraction.
  // startupSettleMs: how long to buffer the ALREADY_RUNNING startup snapshot before running
  // reconciliation once. correlationWindowMs: how close (ms) filesystem activity must be to a
  // process's start to count as temporal correlation evidence (capped at LOW/MEDIUM, never HIGH
  // alone — see SPEC_V0.4.md section 9).
  process: { captureCommandLine: 'sanitized-minimal', startupSettleMs: 300, correlationWindowMs: 4000 },
  // V0.5A/V0.5B — shell context hooks. pipeName: local Windows named pipe the PowerShell hook
  // connects to (see SPEC_V0.5A.md section 4). tcpPort: local loopback-only TCP port the Git
  // Bash hook connects to via bash's builtin /dev/tcp (see SPEC_V0.5B.md section 5) — bash has
  // no native way to talk to a Windows named pipe. Both are started by guardian observe.
  shell: { pipeName: '\\\\.\\pipe\\guardian-shell', tcpPort: 47814 },
  // V0.5C — WSL shell context hooks. tcpPort: separate loopback-only listener WSL bash connects
  // to (never shared with the Git Bash one — different schema, different trust model, see
  // SPEC_V0.5C.md section 4). heartbeatIntervalMs: how often a WSL session may piggyback a
  // heartbeat on its own prompt render (never a new background process); a session silent for
  // 2x this long is marked STALE — the Windows process observer cannot see into a WSL2 VM to
  // reconcile it any other way. scanRoots: config surface for a future native WSL project
  // discovery pass (guardian scan --wsl) — intentionally unused for resolution in this phase,
  // see SPEC_V0.5C.md section 5.
  wsl: { tcpPort: 47815, heartbeatIntervalMs: 60000, scanRoots: {} },
  // V0.6A — Claude Code native hooks. tcpPort: separate loopback-only listener the Guardian
  // Claude hook script (src/agent/claude/hook.mjs) connects to — a fourth, deliberately distinct
  // port from shell/WSL's (never shared: different schema, different trust model, different
  // observer). See SPEC_V0.6A.md section 4.
  claudeAgent: { tcpPort: 47816 },
  // V0.6B — Codex native hooks. tcpPort: a fifth, separate loopback-only listener (47814 shell,
  // 47815 WSL, 47816 Claude, 47817 Codex) the Guardian Codex hook script
  // (src/agent/codex/hook.mjs) connects to. See SPEC_V0.6B.md section 4.
  codexAgent: { tcpPort: 47817 },
  obsidian: { vaultPath: null, debounceMs: 2000 },
  conversation: { provider: null },
  service: { reconciliationTimes: ['08:00', '15:00', '22:00'], logRetentionDays: 30, maxLogBytes: 52428800 },
  // Cérebro hub: archiveDays = no change for this long marks a project "Arquivo — não mexer";
  // nightlyTime = full scan + render + AI suggestions; suggestCommand = CLI that reads the
  // inventory digest on stdin and prints suggestions (e.g. "codex exec -"), null to skip.
  cerebro: { archiveDays: 365, nightlyTime: '03:00', suggestCommand: null },
};

// Loads guardian.config.json, creating it with sane defaults if missing, and auto-detecting
// scanRoots (persisted back to disk) if the file's scanRoots is empty.
export function loadConfig(configPath, { autoDetectRoots = true } = {}) {
  let raw = {};
  if (existsSync(configPath)) {
    const text = readFileSync(configPath, 'utf8');
    raw = text.trim() ? JSON.parse(text) : {};
  }

  const config = {
    ...DEFAULTS,
    ...raw,
    confidenceThresholds: { ...DEFAULTS.confidenceThresholds, ...(raw.confidenceThresholds || {}) },
    activityThresholds: { ...DEFAULTS.activityThresholds, ...(raw.activityThresholds || {}) },
    watch: { ...DEFAULTS.watch, ...(raw.watch || {}) },
    process: { ...DEFAULTS.process, ...(raw.process || {}) },
    shell: { ...DEFAULTS.shell, ...(raw.shell || {}) },
    wsl: { ...DEFAULTS.wsl, ...(raw.wsl || {}), scanRoots: { ...DEFAULTS.wsl.scanRoots, ...(raw.wsl?.scanRoots || {}) } },
    claudeAgent: { ...DEFAULTS.claudeAgent, ...(raw.claudeAgent || {}) },
    codexAgent: { ...DEFAULTS.codexAgent, ...(raw.codexAgent || {}) },
    obsidian: { ...DEFAULTS.obsidian, ...(raw.obsidian || {}) },
    conversation: { ...DEFAULTS.conversation, ...(raw.conversation || {}) },
    service: { ...DEFAULTS.service, ...(raw.service || {}) },
    cerebro: { ...DEFAULTS.cerebro, ...(raw.cerebro || {}) },
  };

  let changed = !existsSync(configPath);

  if (autoDetectRoots && (!Array.isArray(config.scanRoots) || config.scanRoots.length === 0)) {
    config.scanRoots = detectDefaultRoots();
    changed = true;
  }

  if (changed) {
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  }

  return config;
}
