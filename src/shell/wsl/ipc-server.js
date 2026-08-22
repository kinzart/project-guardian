// Local IPC listener for WSL — a deliberately SEPARATE, minimal TCP-loopback-only listener, not
// an extension of src/shell/ipc-server.js (kept 100% untouched — "preserve subsystems already
// working" applies doubly here since this phase cannot validate anything against real WSL). See
// SPEC_V0.5C.md section 4.
//
// Auth: "autenticação/nonce local continua obrigatória... não colocar secrets no shell startup"
// — the hook never has a secret baked into .bashrc/wsl-hook.sh. Instead, Guardian writes a fresh
// random token to data/wsl-auth.token whenever this listener starts; the hook reads that file
// (via the Windows-mounted repo path it already knows from its own install) immediately before
// connecting and sends it as the connection's first line. A connection whose first line doesn't
// match is dropped before any event is ever parsed.

import net from 'node:net';
import crypto from 'node:crypto';
import { validateWslShellEvent } from './schema.js';

export const DEFAULT_WSL_TCP_PORT = 47815;
export const TCP_LOOPBACK_HOST = '127.0.0.1';

export function generateAuthToken() {
  return crypto.randomBytes(24).toString('hex');
}

export function probeWslTcp(port = DEFAULT_WSL_TCP_PORT, timeoutMs = 300) {
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
export function createWslIpcServer({ port = DEFAULT_WSL_TCP_PORT, authToken, onEvent, onRejected, onError } = {}) {
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
    const result = validateWslShellEvent(raw);
    if (!result.ok) {
      onRejected?.({ reason: result.reason, raw });
      return;
    }
    // No pid-liveness check here at all (unlike the Windows/Git-Bash listener) — linux_pid is
    // never checkable against process.kill() on the Windows side; see SPEC_V0.5C.md section 2.
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
