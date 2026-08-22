#!/usr/bin/env node
// Guardian Claude Hook v1.0.0 — lifecycle/context telemetry only, never conversation capture.
// See SPEC_V0.6A.md. Claude Code spawns this as a `type: "command"` hook (SessionStart,
// CwdChanged, SessionEnd, Stop, StopFailure — see manager.js's GUARDIAN_HOOK_EVENTS) and pipes
// its JSON payload in on stdin.
//
// Two hard rules, both non-negotiable:
//   1. FAIL OPEN. Guardian being offline, slow, or broken must never block, slow down, or show a
//      recurring error to Claude Code. Every code path below ends in a plain `process.exit(0)`
//      (or falls off the end of main(), same effect) — there is no path that exits non-zero or
//      throws uncaught. A short connect timeout keeps a hung/unreachable Guardian from stalling
//      the hook.
//   2. WHITELIST, NEVER BLACKLIST. Only a hand-picked set of fields is ever read off the incoming
//      payload and forwarded — everything else (prompt text, transcript_path, tool I/O,
//      assistant text) is never even touched, let alone sent. See SPEC_V0.6A.md "Strict input
//      sanitization" and "Important privacy rule".

import net from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK_VERSION = '1.0.0';
const TCP_PORT = 47816;
const TCP_HOST = '127.0.0.1';
const CONNECT_TIMEOUT_MS = 400;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// This hook is only ever installed FROM this checkout (its command in settings.json is this
// file's own absolute path — see manager.js) — same fixed-relative-path convention as
// src/shell/wsl/wsl-hook.sh sourcing its own repo's data dir.
const DATA_DIR = path.join(__dirname, '..', '..', '..', 'data');
const AUTH_TOKEN_PATH = path.join(DATA_DIR, 'claude-auth.token');

// hook_event_name -> fields read off the raw payload. Nothing outside this list is ever
// forwarded, regardless of what else the payload contains.
const ALLOWED_BY_EVENT = {
  SessionStart: ['session_id', 'cwd', 'source'],
  CwdChanged: ['session_id', 'old_cwd', 'new_cwd'],
  SessionEnd: ['session_id', 'reason'],
  Stop: ['session_id'],
  StopFailure: ['session_id'],
};

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function readAuthToken() {
  try {
    return readFileSync(AUTH_TOKEN_PATH, 'utf8').trim();
  } catch {
    return null; // Guardian has never started an observe session — nothing to authenticate to
  }
}

function sendEvent(payload) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: TCP_HOST, port: TCP_PORT });
    const finish = () => {
      socket.destroy();
      resolve();
    };
    const timer = setTimeout(finish, CONNECT_TIMEOUT_MS);
    socket.once('error', () => {
      clearTimeout(timer);
      finish();
    });
    socket.once('connect', () => {
      clearTimeout(timer);
      const authToken = readAuthToken();
      if (!authToken) {
        finish();
        return;
      }
      socket.write(`${authToken}\n${JSON.stringify(payload)}\n`, () => finish());
    });
  });
}

async function main() {
  const raw = readStdin();
  if (!raw.trim()) return;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return; // malformed input from Claude Code itself — nothing Guardian can do, never crash
  }

  const eventName = payload?.hook_event_name;
  const allowed = ALLOWED_BY_EVENT[eventName];
  if (!allowed) return; // defensive only — settings.json only ever wires up the events above

  const whitelisted = {
    hook_event_name: eventName,
    // process.ppid is Claude Code's own pid (this hook is a direct child of the claude process
    // that spawned it) — the join key that lets Guardian unify this native event with the SAME
    // process-observed agent_session V0.4 may already have created, rather than a duplicate. It
    // is OS process metadata, not conversation content.
    native_process_pid: process.ppid,
    // Claude's own hook payload carries no timestamp field — stamped here, at receipt, same as
    // every other Guardian hook script (PowerShell/Git Bash/WSL all do the same).
    timestamp: new Date().toISOString(),
    hook_version: HOOK_VERSION,
  };
  for (const key of allowed) {
    if (payload[key] !== undefined) whitelisted[key] = payload[key];
  }

  await sendEvent(whitelisted);
}

main()
  .catch(() => {}) // belt and suspenders — see "FAIL OPEN" above
  .finally(() => process.exit(0));
