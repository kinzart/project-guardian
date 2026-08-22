// Local IPC listener for the Claude Code native hook — see SPEC_V0.6A.md "Transport". Claude
// Code's hooks are command-type only (confirmed against the real installed binary, v2.1.237 —
// there is no HTTP hook type to evaluate first, settling the "evaluate native HTTP hooks first"
// question by there being nothing to evaluate); hook.mjs is that minimal command adapter, and
// this is what it talks to. Same shape as src/shell/wsl/ipc-server.js: TCP loopback only, fresh
// auth token per `guardian observe` run, never baked into settings.json.

import net from 'node:net';
import crypto from 'node:crypto';
import { validateClaudeAgentEvent } from './schema.js';

export const DEFAULT_CLAUDE_TCP_PORT = 47816;
export const TCP_LOOPBACK_HOST = '127.0.0.1';

export function generateAuthToken() {
  return crypto.randomBytes(24).toString('hex');
}

export function probeClaudeTcp(port = DEFAULT_CLAUDE_TCP_PORT, timeoutMs = 300) {
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
export function createClaudeIpcServer({ port = DEFAULT_CLAUDE_TCP_PORT, authToken, onEvent, onRejected, onError } = {}) {
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
    const result = validateClaudeAgentEvent(raw);
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
