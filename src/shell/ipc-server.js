// Local IPC — a Windows named pipe (PowerShell, .NET NamedPipeClientStream) and a TCP loopback
// listener (Git Bash — see SPEC_V0.5B.md section 5 for why: bash has no native way to talk to a
// Windows named pipe, but its builtin `/dev/tcp/127.0.0.1/<port>` redirection connects/fails
// instantly with zero subprocess). Never a log file, never public HTTP, never non-loopback
// network. Both transports funnel into the exact same schema validation / event handling — see
// SPEC_V0.5A.md section 4. Built entirely on node:net (no dependency).

import net from 'node:net';
import { validateShellEvent } from './schema.js';

export const DEFAULT_PIPE_NAME = '\\\\.\\pipe\\guardian-shell';
export const DEFAULT_TCP_PORT = 47814;
export const TCP_LOOPBACK_HOST = '127.0.0.1';

// Quick "is anything listening on this pipe" probe — used by `guardian shell status`/`doctor`.
// Never writes anything; just attempts a connection and immediately closes it.
export function probePipe(pipeName = DEFAULT_PIPE_NAME, timeoutMs = 300) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ path: pipeName });
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

// Same idea as probePipe(), for the TCP loopback listener.
export function probeTcp(port = DEFAULT_TCP_PORT, timeoutMs = 300) {
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

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// onEvent(validatedEvent) — already schema-checked, only whitelisted fields.
// onRejected({ reason, raw }) — schema failure, malformed JSON, or an unverifiable pid.
// tcpPort: null disables the TCP listener entirely (e.g. an isolated test that only cares about
// the named pipe, or a machine where binding loopback TCP is undesirable for some reason).
export function createShellIpcServer({
  pipeName = DEFAULT_PIPE_NAME,
  tcpPort = DEFAULT_TCP_PORT,
  onEvent,
  onRejected,
  onError,
  verifyPid = true,
} = {}) {
  let pipeServer = null;
  let tcpServer = null;
  let pipeRunning = false;
  let tcpRunning = false;

  function handleLine(line) {
    if (!line) return;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      onRejected?.({ reason: 'invalid JSON', raw: null });
      return;
    }
    const result = validateShellEvent(raw);
    if (!result.ok) {
      onRejected?.({ reason: result.reason, raw });
      return;
    }
    // IPC trust: never treat a claimed pid as truth without checking it actually exists — see
    // SPEC_V0.5A.md's "IPC Trust" principle. Exempts SHELL_EXITING: it is inherently a report
    // about a process that is ending, or may have already ended by the time this is checked —
    // confirmed on real Git Bash (Cygwin/MSYS), where Windows' OpenProcess-based liveness check
    // consistently reports the pid as gone before the exit message is processed, even though the
    // event itself arrives correctly. Requiring "still alive" for an "I'm exiting" message is
    // backwards; the schema/session-id checks above still apply regardless.
    if (verifyPid && result.value.type !== 'SHELL_EXITING' && !isPidAlive(result.value.pid)) {
      onRejected?.({ reason: 'pid not alive', raw });
      return;
    }
    onEvent?.(result.value);
  }

  function attachSocketLineHandling(socket) {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        handleLine(line);
      }
    });
    // A misbehaving/disconnecting client must never take the server down — fail open.
    socket.on('error', () => {});
  }

  return {
    pipeName,
    tcpPort,
    start() {
      const startPipe = new Promise((resolve, reject) => {
        pipeServer = net.createServer(attachSocketLineHandling);
        pipeServer.on('error', (err) => {
          if (!pipeRunning) reject(err);
          else onError?.(err);
        });
        pipeServer.listen(pipeName, () => {
          pipeRunning = true;
          resolve();
        });
      });

      if (tcpPort == null) return startPipe;

      const startTcp = new Promise((resolve, reject) => {
        tcpServer = net.createServer(attachSocketLineHandling);
        tcpServer.on('error', (err) => {
          if (!tcpRunning) reject(err);
          else onError?.(err);
        });
        tcpServer.listen(tcpPort, TCP_LOOPBACK_HOST, () => {
          tcpRunning = true;
          resolve();
        });
      });
      // The executor above runs synchronously (the listen() attempt starts immediately, in
      // parallel with the pipe, not sequentially after it) — so a TCP-only failure can reject
      // startTcp before startPipe has settled. Attaching .catch() here, immediately, rather than
      // later inside startPipe.then() below, closes that window: an unattached rejected promise
      // sitting around while startPipe is still pending is an unhandled rejection that can crash
      // the whole process (confirmed via real E2E: a port already in use elsewhere did exactly
      // this). The pipe is the primary/required transport (PowerShell always needs it); TCP is
      // best-effort (only Git Bash needs it) — a bind failure there degrades to "Git Bash hooks
      // won't connect" rather than failing the whole shell IPC subsystem.
      const tcpResult = startTcp.catch((err) => {
        onError?.(err);
      });

      return startPipe.then(() => tcpResult);
    },
    stop() {
      const stopPipe = new Promise((resolve) => {
        if (!pipeServer || !pipeRunning) {
          pipeRunning = false;
          resolve();
          return;
        }
        pipeRunning = false;
        pipeServer.close(() => resolve());
      });
      const stopTcp = new Promise((resolve) => {
        if (!tcpServer || !tcpRunning) {
          tcpRunning = false;
          resolve();
          return;
        }
        tcpRunning = false;
        tcpServer.close(() => resolve());
      });
      return Promise.all([stopPipe, stopTcp]).then(() => {});
    },
    isRunning() {
      return pipeRunning;
    },
  };
}
