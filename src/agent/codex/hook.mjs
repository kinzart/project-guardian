#!/usr/bin/env node
// Guardian Codex Hook v1.0.0 — lifecycle/context telemetry only, never conversation capture.
// See SPEC_V0.6B.md. Codex spawns this as a `type: "command"` hook (SessionStart, SessionEnd,
// Stop — see manager.js's GUARDIAN_HOOK_EVENTS) and pipes its JSON payload in on stdin. Same two
// hard rules as src/agent/claude/hook.mjs:
//   1. FAIL OPEN — every path ends in process.exit(0), a 400ms connect timeout bounds any hang.
//      SessionEnd in particular runs SYNCHRONOUSLY in Codex (see SPEC_V0.6B.md "SessionEnd") —
//      this handler must never wait on anything beyond that timeout.
//   2. WHITELIST, NEVER BLACKLIST — only a hand-picked set of fields is ever read off the
//      incoming payload. Codex's real common payload includes transcript_path and
//      permission_mode on every event; neither is ever read here, let alone forwarded.

import net from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK_VERSION = '1.0.0';
const TCP_PORT = 47817;
const TCP_HOST = '127.0.0.1';
const CONNECT_TIMEOUT_MS = 400;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Same fixed-relative-path convention as src/agent/claude/hook.mjs — only ever installed FROM
// this checkout.
const DATA_DIR = path.join(__dirname, '..', '..', '..', 'data');
const AUTH_TOKEN_PATH = path.join(DATA_DIR, 'codex-auth.token');

// hook_event_name -> fields read off the raw payload. Nothing outside this list is ever
// forwarded, regardless of what else the payload contains.
const ALLOWED_BY_EVENT = {
  SessionStart: ['session_id', 'cwd', 'model', 'source'],
  SessionEnd: ['session_id', 'cwd', 'model', 'reason'],
  Stop: ['session_id', 'model'],
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
    return; // malformed input from Codex itself — nothing Guardian can do, never crash
  }

  const eventName = payload?.hook_event_name;
  const allowed = ALLOWED_BY_EVENT[eventName];
  if (!allowed) return; // defensive only — hooks.json only ever wires up the events above

  const whitelisted = {
    hook_event_name: eventName,
    // process.ppid is Codex's own pid on some hook-execution paths, but may also be an
    // intermediate shell wrapper (see SPEC_V0.6B.md section 2 — Codex command hooks may run
    // through cmd/PowerShell/bash/node, exactly the same real finding V0.6A made for Claude).
    // Guardian's observer walks the real process-ancestry tree to resolve this correctly either
    // way — the hook itself doesn't need to know which case it's in.
    native_process_pid: process.ppid,
    // Codex's own hook payload carries no timestamp field — stamped here, at receipt, same as
    // every other Guardian hook script.
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
