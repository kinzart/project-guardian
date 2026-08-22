// Global ~/.claude/settings.json install/uninstall/restore/doctor — see SPEC_V0.6A.md
// "Installation" and "Global vs project hook". Surgically merges Guardian's own hook-group
// entries into the `hooks.<Event>` arrays; every other entry already in those arrays (AUM's
// agent-progress hooks, or any other tool's) is left byte-for-byte untouched. Confirmed against
// this real machine before writing this module: ~/.claude/settings.json currently has no `hooks`
// key at all, and the only real-world example of the JSON shape found on disk (AUM/agent-progress
// project-level .claude/settings.json fixtures under D:\release-*) shows exactly this pattern —
// multiple independent hook-group objects coexisting in the same per-event array.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { globalSettingsPath } from './discovery.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const HOOK_PATH = path.join(__dirname, 'hook.mjs');

// Required per SPEC_V0.6A.md; Stop/StopFailure are the explicitly OPTIONAL turn-activity
// markers. All five are installed together — there is no partial-install mode, matching how
// PowerShell/Git Bash/WSL install everything their one hook script covers in one pass.
export const GUARDIAN_HOOK_EVENTS = ['SessionStart', 'CwdChanged', 'SessionEnd', 'Stop', 'StopFailure'];

export function computeHash(content) {
  return crypto.createHash('sha256').update(content ?? '', 'utf8').digest('hex');
}

function commandFor(hookPath) {
  return `node "${hookPath}"`;
}

// The exact hook-group object Guardian installs for one event. No `matcher` — the hook itself is
// cheap, always fails open, and applies uniformly regardless of SessionStart's source/SessionEnd's
// reason (Guardian classifies those AFTER receiving the event, not via Claude's own matcher).
function buildGuardianEntry(hookPath) {
  return { hooks: [{ type: 'command', command: commandFor(hookPath), timeout: 5 }] };
}

function isGuardianEntry(entry, hookPath) {
  const command = commandFor(hookPath);
  return !!entry?.hooks?.some((h) => h?.type === 'command' && h?.command === command);
}

export function readHookVersion() {
  try {
    const text = readFileSync(HOOK_PATH, 'utf8');
    const m = text.match(/Guardian Claude Hook\s+v(\S+)/i);
    return m ? m[1] : 'unknown';
  } catch {
    return null;
  }
}

export function readSettings(settingsPath) {
  if (!existsSync(settingsPath)) return {};
  const text = readFileSync(settingsPath, 'utf8');
  return text.trim() ? JSON.parse(text) : {};
}

function writeSettingsAtomic(settingsPath, settings) {
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  const tmpPath = `${settingsPath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(tmpPath, settingsPath);
}

// Returns { settings, guardianEntries } where guardianEntries[event] is the entry Guardian would
// have (or already has) in settings.hooks[event] — used by both merge and by doctor/restore to
// reason about "what Guardian owns" without duplicating the walk logic.
function mergeGuardianHooks(settings, hookPath) {
  const next = { ...settings, hooks: { ...(settings.hooks || {}) } };
  const guardianEntries = {};
  for (const event of GUARDIAN_HOOK_EVENTS) {
    const existing = (next.hooks[event] || []).filter((entry) => !isGuardianEntry(entry, hookPath));
    const entry = buildGuardianEntry(hookPath);
    next.hooks[event] = [...existing, entry];
    guardianEntries[event] = entry;
  }
  return { settings: next, guardianEntries };
}

function removeGuardianHooks(settings, hookPath) {
  const next = { ...settings, hooks: { ...(settings.hooks || {}) } };
  let removedAny = false;
  for (const event of GUARDIAN_HOOK_EVENTS) {
    if (!next.hooks[event]) continue;
    const before = next.hooks[event].length;
    next.hooks[event] = next.hooks[event].filter((entry) => !isGuardianEntry(entry, hookPath));
    if (next.hooks[event].length !== before) removedAny = true;
    if (next.hooks[event].length === 0) delete next.hooks[event];
  }
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return { settings: next, removedAny };
}

function backupPathFor(backupDir, settingsPath) {
  const base = path.basename(settingsPath).replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(backupDir, `${base}.${Date.now()}.bak`);
}

// install: idempotent by construction (mergeGuardianHooks always removes-then-reinserts its own
// entries, never appending a second copy). Always backs up the pre-install file first — even
// when the file didn't exist yet (backs up the literal text "null" then, so uninstall/restore
// have a real prior-state artifact to point to, consistent with the other three managers).
export function install({ settingsPath = globalSettingsPath(), backupDir, hookPath = HOOK_PATH }) {
  mkdirSync(backupDir, { recursive: true });
  const existingText = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : 'null';
  const beforeHash = computeHash(existingText);
  const backupPath = backupPathFor(backupDir, settingsPath);
  writeFileSync(backupPath, existingText);

  const before = readSettings(settingsPath);
  const alreadyInstalled = GUARDIAN_HOOK_EVENTS.every((event) => (before.hooks?.[event] || []).some((e) => isGuardianEntry(e, hookPath)));
  const { settings: after, guardianEntries } = mergeGuardianHooks(before, hookPath);
  writeSettingsAtomic(settingsPath, after);

  return {
    settingsPath,
    backupPath,
    beforeHash,
    afterHash: computeHash(JSON.stringify(after, null, 2)),
    guardianHooksHash: computeHash(JSON.stringify(guardianEntries)),
    alreadyInstalled,
  };
}

// uninstall: removes ONLY Guardian-owned hook-group entries. Any other tool's entries in the same
// per-event arrays (e.g. AUM's agent-progress hooks) are left exactly as they were.
export function uninstall({ settingsPath = globalSettingsPath(), backupDir, hookPath = HOOK_PATH }) {
  if (!existsSync(settingsPath)) return { removed: false, reason: 'settings.json does not exist' };
  const existingText = readFileSync(settingsPath, 'utf8');
  const before = existingText.trim() ? JSON.parse(existingText) : {};
  const { settings: after, removedAny } = removeGuardianHooks(before, hookPath);
  if (!removedAny) return { removed: false, reason: 'no Guardian hooks present' };

  mkdirSync(backupDir, { recursive: true });
  const backupPath = backupPathFor(backupDir, settingsPath);
  writeFileSync(backupPath, existingText);
  writeSettingsAtomic(settingsPath, after);

  return { removed: true, backupPath, afterHash: computeHash(JSON.stringify(after, null, 2)) };
}

// restore: only proceeds when the Guardian-owned entries CURRENTLY present hash-match exactly
// what Guardian itself last installed — otherwise refuses rather than risk discarding a manual
// edit (same philosophy as profile-manager.js's restore for PowerShell/Git Bash text blocks).
export function restore({ settingsPath = globalSettingsPath(), lastInstalledHooksHash, hookPath = HOOK_PATH }) {
  if (!existsSync(settingsPath)) return { restored: false, reason: 'settings.json does not exist' };
  const settings = readSettings(settingsPath);
  const present = {};
  for (const event of GUARDIAN_HOOK_EVENTS) {
    const entry = (settings.hooks?.[event] || []).find((e) => isGuardianEntry(e, hookPath));
    if (entry) present[event] = entry;
  }
  if (Object.keys(present).length === 0) return { restored: false, reason: 'no Guardian block present to restore' };
  if (!lastInstalledHooksHash) return { restored: false, reason: 'no known prior install to restore to — refusing to guess' };
  if (computeHash(JSON.stringify(present)) !== lastInstalledHooksHash) {
    return { restored: false, reason: 'current Guardian hooks differ from what Guardian last installed — refusing to overwrite a possible manual edit' };
  }
  return { restored: true, reason: 'current Guardian hooks already match last install; nothing to do' };
}

export function doctor({ settingsPath = globalSettingsPath(), hookPath = HOOK_PATH }) {
  const checks = { settingsFound: false, parseable: false, guardianHooksPresent: {}, duplicateEntries: {}, otherToolEntries: {} };
  if (!existsSync(settingsPath)) return checks;
  checks.settingsFound = true;
  let settings;
  try {
    settings = readSettings(settingsPath);
    checks.parseable = true;
  } catch {
    return checks;
  }
  for (const event of GUARDIAN_HOOK_EVENTS) {
    const entries = settings.hooks?.[event] || [];
    const guardianMatches = entries.filter((e) => isGuardianEntry(e, hookPath));
    checks.guardianHooksPresent[event] = guardianMatches.length > 0;
    checks.duplicateEntries[event] = guardianMatches.length > 1;
    checks.otherToolEntries[event] = entries.length - guardianMatches.length;
  }
  return checks;
}

// Tiny durable record of "what Guardian itself last installed", so `restore` can prove it's safe
// instead of guessing — same shape/rationale as the other three managers' *InstallState helpers.
export function readInstallState(dataDir) {
  const p = path.join(dataDir, 'claude-agent-install-state.json');
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

export function writeInstallState(dataDir, state) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, 'claude-agent-install-state.json'), JSON.stringify(state, null, 2));
}

// Auth: same rationale as src/shell/wsl/manager.js's writeAuthToken — a fresh random token per
// `guardian observe` run, written where hook.mjs's own fixed-relative-path lookup expects it,
// never baked into settings.json.
export function writeAuthToken(dataDir, token) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, 'claude-auth.token'), token);
}
