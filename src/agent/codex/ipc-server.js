// Local IPC listener for the Codex native hook — see SPEC_V0.6B.md section 4. TCP loopback only,
// fresh auth token per `guardian observe` run, never baked into hooks.json. Same shape as
// src/agent/claude/ipc-server.js — a deliberately separate listener/port, not shared.

import net from 'node:net';
import crypto from 'node:crypto';
import { validateCodexAgentEvent } from './schema.js';

export const DEFAULT_CODEX_TCP_PORT = 47817;
export const TCP_LOOPBACK_HOST = '127.0.0.1';

export function generateAuthToken() {
  return crypto.randomBytes(24).toString('hex');
}

export function probeCodexTcp(port = DEFAULT_CODEX_TCP_PORT, timeoutMs = 300) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: TCP_LOOPBACK_HOST, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

// onEvent(validatedEvent), onRejected({ reason, raw }), onError(err).
export function createCodexIpcServer({ port = DEFAULT_CODEX_TCP_PORT, authToken, onEvent, onRejected, onError } = {}) {
  let server = null;
  let running = false;

  function handleLine(line) {
    if (!line) return;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      onRejected?.({ reason: 'invalid JSON', raw: null });
      return;
    }
    const result = validateCodexAgentEvent(raw);
    if (!result.ok) {
      onRejected?.({ reason: result.reason, raw });
      return;
    }
    onEvent?.(result.value);
  }

  return {
    port,
    start() {
      return new Promise((resolve, reject) => {
        server = net.createServer((socket) => {
          let buffer = '';
          let authenticated = false;
          socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            let idx;
            while ((idx = buffer.indexOf('\n')) !== -1) {
              const line = buffer.slice(0, idx).trim();
              buffer = buffer.slice(idx + 1);
              if (!authenticated) {
                if (line === authToken) {
                  authenticated = true;
                } else {
                  onRejected?.({ reason: 'bad or missing auth token', raw: null });
                  socket.destroy();
                  return;
                }
                continue;
              }
              handleLine(line);
            }
          });
          socket.on('error', () => {}); // fail open — a bad client never takes the server down
        });
        server.on('error', (err) => {
          if (!running) reject(err);
          else onError?.(err);
        });
        server.listen(port, TCP_LOOPBACK_HOST, () => {
          running = true;
          resolve();
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        if (!server || !running) {
          running = false;
          resolve();
          return;
        }
        running = false;
        server.close(() => resolve());
      });
    },
    isRunning() {
      return running;
    },
  };
}
