// Global ~/.codex/hooks.json install/uninstall/restore/doctor — see SPEC_V0.6B.md sections 3 and
// 5. Same surgical-merge philosophy as src/agent/claude/manager.js: Guardian's own hook-group
// entries are identified by exact command-string match, every other entry in the same per-event
// array is left untouched. Also reads (never writes) config.toml's [hooks.state] trust-bookkeeping
// table with a narrow, purpose-built extractor — Guardian never needs a general TOML parser since
// it never writes TOML and only ever reads this one specific table shape.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { globalHooksJsonPath, globalConfigTomlPath } from './discovery.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const HOOK_PATH = path.join(__dirname, 'hook.mjs');

// SessionEnd runs synchronously in Codex (see SPEC_V0.6B.md "SessionEnd") — Stop is the
// explicitly optional TURN_ACTIVITY marker. No CwdChanged/StopFailure equivalents exist for
// Codex (confirmed, never assumed — see SPEC_V0.6B.md section 1).
export const GUARDIAN_HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'Stop'];

// PascalCase (hooks.json's own key) -> snake_case (config.toml's [hooks.state] key) — confirmed
// via a real trusted-hook fixture on this machine (see SPEC_V0.6B.md section 1).
const EVENT_SNAKE_CASE = { SessionStart: 'session_start', SessionEnd: 'session_end', Stop: 'stop' };

export function computeHash(content) {
  return crypto.createHash('sha256').update(content ?? '', 'utf8').digest('hex');
}

function commandFor(hookPath) {
  return `node "${hookPath}"`;
}

// commandWindows is a genuine Codex field (confirmed via official docs + the installed binary's
// own string table — see SPEC_V0.6B.md section 1) for a Windows-specific override; set to the
// same invocation as `command` since `node "<path>"` is already valid on both platforms.
//
// SessionEnd gets a shorter declared timeout — found via real E2E: Codex silently clamps a
// SessionEnd hook's timeout to 3s and prints a warning on every session
// ("clamping SessionEnd hook timeout to 3s in ...hooks.json") if a longer one is declared. The
// hook itself is already bounded well inside that (a 400ms connect timeout — see hook.mjs), so
// declaring 3s here removes the warning without changing real behavior.
function buildGuardianEntry(hookPath, event) {
  const command = commandFor(hookPath);
  const timeout = event === 'SessionEnd' ? 3 : 5;
  return { hooks: [{ type: 'command', command, commandWindows: command, timeout }] };
}

function isGuardianEntry(entry, hookPath) {
  const command = commandFor(hookPath);
  return !!entry?.hooks?.some((h) => h?.type === 'command' && h?.command === command);
}

export function readHookVersion() {
  try {
    const text = readFileSync(HOOK_PATH, 'utf8');
    const m = text.match(/Guardian Codex Hook\s+v(\S+)/i);
    return m ? m[1] : 'unknown';
  } catch {
    return null;
  }
}

export function readHooksJson(hooksJsonPath) {
  if (!existsSync(hooksJsonPath)) return {};
  const text = readFileSync(hooksJsonPath, 'utf8');
  return text.trim() ? JSON.parse(text) : {};
}

function writeHooksJsonAtomic(hooksJsonPath, hooksJson) {
  mkdirSync(path.dirname(hooksJsonPath), { recursive: true });
  const tmpPath = `${hooksJsonPath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, `${JSON.stringify(hooksJson, null, 2)}\n`);
  renameSync(tmpPath, hooksJsonPath);
}

function mergeGuardianHooks(hooksJson, hookPath) {
  const next = { ...hooksJson, hooks: { ...(hooksJson.hooks || {}) } };
  const guardianEntries = {};
  for (const event of GUARDIAN_HOOK_EVENTS) {
    const existing = (next.hooks[event] || []).filter((entry) => !isGuardianEntry(entry, hookPath));
    const entry = buildGuardianEntry(hookPath, event);
    next.hooks[event] = [...existing, entry];
    guardianEntries[event] = entry;
  }
  return { hooksJson: next, guardianEntries };
}

function removeGuardianHooks(hooksJson, hookPath) {
  const next = { ...hooksJson, hooks: { ...(hooksJson.hooks || {}) } };
  let removedAny = false;
  for (const event of GUARDIAN_HOOK_EVENTS) {
    if (!next.hooks[event]) continue;
    const before = next.hooks[event].length;
    next.hooks[event] = next.hooks[event].filter((entry) => !isGuardianEntry(entry, hookPath));
    if (next.hooks[event].length !== before) removedAny = true;
    if (next.hooks[event].length === 0) delete next.hooks[event];
  }
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return { hooksJson: next, removedAny };
}

function backupPathFor(backupDir, filePath) {
  const base = path.basename(filePath).replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(backupDir, `${base}.${Date.now()}.bak`);
}

// install: idempotent by construction. Always backs up the pre-install file first — even when it
// didn't exist yet (backs up the literal text "null" then, same convention as the Claude manager).
export function install({ hooksJsonPath = globalHooksJsonPath(), backupDir, hookPath = HOOK_PATH }) {
  mkdirSync(backupDir, { recursive: true });
  const existingText = existsSync(hooksJsonPath) ? readFileSync(hooksJsonPath, 'utf8') : 'null';
  const beforeHash = computeHash(existingText);
  const backupPath = backupPathFor(backupDir, hooksJsonPath);
  writeFileSync(backupPath, existingText);

  const before = readHooksJson(hooksJsonPath);
  const alreadyInstalled = GUARDIAN_HOOK_EVENTS.every((event) => (before.hooks?.[event] || []).some((e) => isGuardianEntry(e, hookPath)));
  const { hooksJson: after, guardianEntries } = mergeGuardianHooks(before, hookPath);
  writeHooksJsonAtomic(hooksJsonPath, after);

  return {
    hooksJsonPath,
    backupPath,
    beforeHash,
    afterHash: computeHash(JSON.stringify(after, null, 2)),
    guardianHooksHash: computeHash(JSON.stringify(guardianEntries)),
    alreadyInstalled,
  };
}

export function uninstall({ hooksJsonPath = globalHooksJsonPath(), backupDir, hookPath = HOOK_PATH }) {
  if (!existsSync(hooksJsonPath)) return { removed: false, reason: 'hooks.json does not exist' };
  const existingText = readFileSync(hooksJsonPath, 'utf8');
  const before = existingText.trim() ? JSON.parse(existingText) : {};
  const { hooksJson: after, removedAny } = removeGuardianHooks(before, hookPath);
  if (!removedAny) return { removed: false, reason: 'no Guardian hooks present' };

  mkdirSync(backupDir, { recursive: true });
  const backupPath = backupPathFor(backupDir, hooksJsonPath);
  writeFileSync(backupPath, existingText);
  writeHooksJsonAtomic(hooksJsonPath, after);

  return { removed: true, backupPath, afterHash: computeHash(JSON.stringify(after, null, 2)) };
}

export function restore({ hooksJsonPath = globalHooksJsonPath(), lastInstalledHooksHash, hookPath = HOOK_PATH }) {
  if (!existsSync(hooksJsonPath)) return { restored: false, reason: 'hooks.json does not exist' };
  const hooksJson = readHooksJson(hooksJsonPath);
  const present = {};
  for (const event of GUARDIAN_HOOK_EVENTS) {
    const entry = (hooksJson.hooks?.[event] || []).find((e) => isGuardianEntry(e, hookPath));
    if (entry) present[event] = entry;
  }
  if (Object.keys(present).length === 0) return { restored: false, reason: 'no Guardian block present to restore' };
  if (!lastInstalledHooksHash) return { restored: false, reason: 'no known prior install to restore to — refusing to guess' };
  if (computeHash(JSON.stringify(present)) !== lastInstalledHooksHash) {
    return { restored: false, reason: 'current Guardian hooks differ from what Guardian last installed — refusing to overwrite a possible manual edit' };
  }
  return { restored: true, reason: 'current Guardian hooks already match last install; nothing to do' };
}

// Narrow [hooks.state] reader — see this file's module doc. Only ever recognizes the exact shape
// found on this real machine: `[hooks.state.'<path>:<event_snake>:<i>:<j>']` followed by a
// `trusted_hash = "..."` line. Never writes to config.toml, never trusts/spoofs anything.
export function readHookTrustState(configTomlPath = globalConfigTomlPath()) {
  if (!existsSync(configTomlPath)) return {};
  let text;
  try {
    text = readFileSync(configTomlPath, 'utf8');
  } catch {
    return {};
  }
  const lines = text.split(/\r?\n/);
  const state = {}; // "<path>:<event>:<i>:<j>" -> { trustedHash }
  const headerPattern = /^\[hooks\.state\.'(.*):([a-z_]+):(\d+):(\d+)'\]$/;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].trim().match(headerPattern);
    if (!m) continue;
    const [, filePath, event, matcherIdx, handlerIdx] = m;
    let trustedHash = null;
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j].trim();
      if (!line) continue;
      if (line.startsWith('[')) break; // next section — this entry has no trusted_hash line
      const hashMatch = line.match(/^trusted_hash\s*=\s*"(.*)"$/);
      if (hashMatch) trustedHash = hashMatch[1];
      break; // only ever one key expected per entry on this real machine
    }
    state[`${filePath}:${event}:${matcherIdx}:${handlerIdx}`] = { filePath, event, trustedHash };
  }
  return state;
}

// Per Guardian-owned event, reports whether config.toml's [hooks.state] shows it trusted.
// 'unknown' (not 'untrusted') when no entry exists at all — Guardian cannot distinguish "Codex
// has never evaluated this hook" from "explicitly pending review" from this file alone, and must
// never guess (see SPEC_V0.6B.md section 8 / this phase's "Codex trust model" instructions).
export function trustStatusForGuardianHooks({ hooksJsonPath = globalHooksJsonPath(), configTomlPath = globalConfigTomlPath() } = {}) {
  const state = readHookTrustState(configTomlPath);
  const result = {};
  for (const event of GUARDIAN_HOOK_EVENTS) {
    const snake = EVENT_SNAKE_CASE[event];
    // Guardian only ever installs ONE matcher group / ONE handler per event (index 0:0).
    const key = `${hooksJsonPath}:${snake}:0:0`;
    const entry = state[key];
    result[event] = entry?.trustedHash ? 'trusted' : 'unknown';
  }
  return result;
}

export function doctor({ hooksJsonPath = globalHooksJsonPath(), hookPath = HOOK_PATH, configTomlPath = globalConfigTomlPath() }) {
  const checks = { hooksJsonFound: false, parseable: false, guardianHooksPresent: {}, duplicateEntries: {}, otherToolEntries: {}, trustStatus: {} };
  if (!existsSync(hooksJsonPath)) return checks;
  checks.hooksJsonFound = true;
  let hooksJson;
  try {
    hooksJson = readHooksJson(hooksJsonPath);
    checks.parseable = true;
  } catch {
    return checks;
  }
  for (const event of GUARDIAN_HOOK_EVENTS) {
    const entries = hooksJson.hooks?.[event] || [];
    const guardianMatches = entries.filter((e) => isGuardianEntry(e, hookPath));
    checks.guardianHooksPresent[event] = guardianMatches.length > 0;
    checks.duplicateEntries[event] = guardianMatches.length > 1;
    checks.otherToolEntries[event] = entries.length - guardianMatches.length;
  }
  checks.trustStatus = trustStatusForGuardianHooks({ hooksJsonPath, configTomlPath });
  return checks;
}

export function readInstallState(dataDir) {
  const p = path.join(dataDir, 'codex-agent-install-state.json');
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

export function writeInstallState(dataDir, state) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, 'codex-agent-install-state.json'), JSON.stringify(state, null, 2));
}

export function writeAuthToken(dataDir, token) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, 'codex-auth.token'), token);
}
