// Codex environment discovery — see SPEC_V0.6B.md section 1. "Detected" means CODEX_HOME exists
// (created by Codex itself the first time it runs), the same directory-evidence approach as
// src/agent/claude/discovery.js — never shells out to `codex` itself from a discovery check.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// GUARDIAN_CODEX_HOME lets tests sandbox this away from the real ~/.codex — same rationale as
// GUARDIAN_CLAUDE_HOME. Unset in normal operation. Codex itself resolves CODEX_HOME the same way
// (env override, else ~/.codex — confirmed via `codex doctor --json`'s own "CODEX_HOME" field).
export function codexHomeDir() {
  if (process.env.GUARDIAN_CODEX_HOME) return path.resolve(process.env.GUARDIAN_CODEX_HOME);
  if (process.env.CODEX_HOME) return path.resolve(process.env.CODEX_HOME);
  return path.join(os.homedir(), '.codex');
}

export function globalHooksJsonPath() {
  return path.join(codexHomeDir(), 'hooks.json');
}

export function globalConfigTomlPath() {
  return path.join(codexHomeDir(), 'config.toml');
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

// Narrow, deliberately-not-a-general-TOML-parser check for whether config.toml ALREADY defines a
// competing hook-definitions table (as opposed to [hooks.state], which is pure trust bookkeeping
// — see SPEC_V0.6B.md section 5). Guardian never needs to understand TOML beyond this one
// question, so no TOML parsing dependency is introduced.
export function configTomlHasHookDefinitions(configTomlText) {
  if (!configTomlText) return false;
  return /^\[hooks\.(?!state)/m.test(configTomlText);
}

// detectCodex(): never throws. installed=false means "no CODEX_HOME directory found" — V0.6B
// still installs nothing and never invents a version.
export function detectCodex() {
  const homeDir = codexHomeDir();
  const installed = existsSync(homeDir);
  const hooksJson = readJsonIfExists(globalHooksJsonPath());
  let configTomlText = null;
  let configTomlExists = false;
  if (existsSync(globalConfigTomlPath())) {
    configTomlExists = true;
    try {
      configTomlText = readFileSync(globalConfigTomlPath(), 'utf8');
    } catch {
      configTomlText = null;
    }
  }
  return {
    installed,
    homeDir,
    hooksJsonPath: globalHooksJsonPath(),
    hooksJson,
    configTomlPath: globalConfigTomlPath(),
    configTomlExists,
    configTomlHasHookDefinitions: configTomlHasHookDefinitions(configTomlText),
  };
}
