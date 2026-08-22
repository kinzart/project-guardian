// Claude Code environment discovery — see SPEC_V0.6A.md section 1. "Detected" means the
// per-user Claude Code config directory exists (~/.claude), which is created by Claude Code
// itself the first time it runs. Deliberately does NOT shell out to `claude --version` — unlike
// wsl.exe (a small, cheap probe), invoking the actual `claude` binary from inside a discovery
// check risks side effects (it is a full agent CLI, not a status tool), so directory evidence is
// used instead. Confirmed on this real machine: ~/.claude exists and contains settings.json,
// sessions/, projects/, etc. — see SPEC_V0.6A.md's real-environment investigation.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// GUARDIAN_CLAUDE_HOME lets tests point install/uninstall/doctor at an isolated sandbox instead
// of the real ~/.claude — same rationale as bin/guardian.js's GUARDIAN_HOME override. Unset in
// normal operation, so production behavior is unchanged.
export function claudeHomeDir() {
  if (process.env.GUARDIAN_CLAUDE_HOME) return path.resolve(process.env.GUARDIAN_CLAUDE_HOME);
  return path.join(os.homedir(), '.claude');
}

export function globalSettingsPath() {
  return path.join(claudeHomeDir(), 'settings.json');
}

export function globalSettingsLocalPath() {
  return path.join(claudeHomeDir(), 'settings.local.json');
}

// projectRoot: the repo Guardian is running FROM (not necessarily the project being observed) —
// used only to report whether that repo itself carries its own .claude/settings.json, since a
// project-level file can also define hooks and V0.6A must never silently assume it's empty.
export function projectSettingsPath(projectRoot) {
  return path.join(projectRoot, '.claude', 'settings.json');
}

function readJsonIfExists(p) {
  if (!existsSync(p)) return { exists: false, parseable: true, value: null };
  try {
    const text = readFileSync(p, 'utf8');
    return { exists: true, parseable: true, value: text.trim() ? JSON.parse(text) : {} };
  } catch {
    return { exists: true, parseable: false, value: null };
  }
}

// detectClaudeCode(): never throws. installed=false means "no ~/.claude directory found" — V0.6A
// still installs nothing and never invents a version. globalSettings carries what's ALREADY
// there today so install/doctor can reason about it without a second read (see manager.js).
export function detectClaudeCode() {
  const homeDir = claudeHomeDir();
  const installed = existsSync(homeDir);
  const settings = readJsonIfExists(globalSettingsPath());
  const settingsLocal = readJsonIfExists(globalSettingsLocalPath());
  return {
    installed,
    homeDir,
    settingsPath: globalSettingsPath(),
    settings,
    settingsLocalPath: globalSettingsLocalPath(),
    settingsLocal,
  };
}
