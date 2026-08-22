// WSL shell IPC observer — mirrors the shape of src/shell/observer.js (ShellObserver) but is a
// deliberately separate class with its OWN session registry, never shared with the Windows
// process observer's shellRegistry (see SPEC_V0.5C.md section 2 — linux_pid must never be looked
// up as if it were a Windows pid). Also owns heartbeat-based staleness detection, which
// PowerShell/Git Bash sessions don't need (the Windows process observer already reconciles
// those; it cannot see inside a WSL2 VM at all).

import { createWslIpcServer, generateAuthToken, DEFAULT_WSL_TCP_PORT } from './ipc-server.js';
import { normalizeWslShellEvent } from './normalizer.js';
import { ShellSessionRegistry } from '../session-store.js';
import { resolveWslProject } from './path-identity.js';
import { writeAuthToken } from './manager.js';

const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;

export class WslShellObserver {
  // dataDir: where the fresh auth token is written each start (see manager.js's writeAuthToken)
  // so an already-installed hook can find the CURRENT session's token — never baked into any
  // distro startup file (SPEC_V0.5C.md section 4's "não colocar secrets no shell startup").
  constructor({ store, port = DEFAULT_WSL_TCP_PORT, heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS, wslScanRoots = {}, dataDir = null, ipcServerFactory = createWslIpcServer }) {
    this.store = store;
    this.port = port;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.wslScanRoots = wslScanRoots;
    this.dataDir = dataDir;
    this.ipcServerFactory = ipcServerFactory;
    this.registry = new ShellSessionRegistry(); // separate instance — see module doc above
    this.projects = [];
    this.lastSeenAt = new Map(); // shell_session_id -> ms epoch, updated by any event incl. heartbeat

    this.stats = {
      eventsReceived: 0,
      shellsStarted: 0,
      cwdChanges: 0,
      duplicateCwdSuppressed: 0,
      shellsExited: 0,
      heartbeats: 0,
      staleDetected: 0,
      schemaRejections: 0,
      errors: 0,
    };

    this.listeners = [];
    this.running = false;
    this.degraded = false;
    this.lastEvent = null;
    this.server = null;
    this.authToken = null;
    this.staleTimer = null;
  }

  onEvent(callback) {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== callback);
    };
  }

  emit(evt) {
    this.lastEvent = { ...evt, at: new Date().toISOString() };
    for (const listener of this.listeners) {
      try {
        listener(this.lastEvent);
      } catch {
        // a listener throwing must never break the observer
      }
    }
  }

  updateProjects(projects) {
    this.projects = projects;
  }

  async start(projects = []) {
    this.projects = projects;
    this.authToken = generateAuthToken();
    if (this.dataDir) {
      try {
        writeAuthToken(this.dataDir, this.authToken);
      } catch (err) {
        this.emit({ type: 'error', error: { message: `could not write wsl-auth.token: ${err.message}` } });
      }
    }

    this.server = this.ipcServerFactory({
      port: this.port,
      authToken: this.authToken,
      onEvent: (validated) => this.#handleEvent(validated),
      onRejected: (info) => {
        this.stats.schemaRejections += 1;
        this.emit({ type: 'rejected', reason: info.reason });
      },
      onError: (err) => {
        this.stats.errors += 1;
        this.degraded = true;
        this.emit({ type: 'error', error: { message: err?.message || String(err) } });
      },
    });

    try {
      await this.server.start();
      this.running = true;
      this.degraded = false;
    } catch (err) {
      this.running = false;
      this.degraded = true;
      this.emit({ type: 'error', error: { message: err?.message || String(err) } });
      return false;
    }

    // Staleness sweep — see SPEC_V0.5C.md section 7. Not unref'd deliberately not needed here
    // (guardian observe is a long-lived foreground process either way); interval is bounded and
    // cheap (in-memory Map scan only).
    this.staleTimer = setInterval(() => this.#sweepStale(), this.heartbeatIntervalMs);
    if (typeof this.staleTimer.unref === 'function') this.staleTimer.unref();

    return true;
  }

  #persist(normalized, session) {
    const projectId = normalized.cwd
      ? resolveWslProject({ namespace: 'WINDOWS', windowsPath: normalized.cwd }, this.projects, this.wslScanRoots)?.id || null
      : null;
    const record = { ...normalized, project_id: projectId };
    this.store.addShellEvent(record).catch(() => {
      this.stats.errors += 1;
    });
    if (session) {
      this.store.upsertShellSession(session).catch(() => {
        this.stats.errors += 1;
      });
    }
  }

  #handleEvent(validated) {
    this.stats.eventsReceived += 1;
    this.lastSeenAt.set(validated.shell_session_id, Date.now());

    if (validated.type === 'HEARTBEAT') {
      this.stats.heartbeats += 1;
      // Heartbeats are logged (bounded, cheap) but never mutate the session itself beyond
      // keeping it out of the staleness sweep — see #sweepStale().
      this.store
        .addShellEvent({
          id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          type: 'HEARTBEAT',
          shell_session_id: validated.shell_session_id,
          pid: validated.linux_pid,
          shell_type: 'WSL_BASH',
          timestamp: validated.timestamp,
          received_at: new Date().toISOString(),
          source: 'WSL_HOOK',
        })
        .catch(() => {
          this.stats.errors += 1;
        });
      return;
    }

    const normalized = normalizeWslShellEvent(validated);

    if (normalized.type === 'SHELL_STARTED') {
      const session = this.registry.onShellStarted(normalized);
      this.stats.shellsStarted += 1;
      this.#persist(normalized, session);
      this.emit({ type: 'shell-started', session });
    } else if (normalized.type === 'CWD_CHANGED') {
      const { session, duplicate } = this.registry.onCwdChanged(normalized);
      if (duplicate) {
        this.stats.duplicateCwdSuppressed += 1;
        return;
      }
      this.stats.cwdChanges += 1;
      this.#persist(normalized, session);
      this.emit({ type: 'cwd-changed', session });
    } else if (normalized.type === 'SHELL_EXITING') {
      const session = this.registry.onShellExiting(normalized);
      this.stats.shellsExited += 1;
      this.lastSeenAt.delete(normalized.shell_session_id);
      this.#persist(normalized, session);
      this.emit({ type: 'shell-exiting', session });
    }
  }

  // Marks an ACTIVE WSL session STALE (never ENDED — a clean exit was never actually observed)
  // once its last event/heartbeat is older than 2x the heartbeat interval. The only reliable
  // reconciliation path for a WSL session: the Windows process observer has no visibility into a
  // WSL2 VM's own processes at all, unlike PowerShell/Git Bash sessions.
  #sweepStale() {
    const threshold = this.heartbeatIntervalMs * 2;
    const now = Date.now();
    for (const session of this.registry.list({ active: true })) {
      const lastSeen = this.lastSeenAt.get(session.shell_session_id);
      if (lastSeen == null || now - lastSeen <= threshold) continue;
      session.status = 'STALE';
      session.closure_note = `no event or heartbeat received in over ${Math.round(threshold / 1000)}s`;
      this.stats.staleDetected += 1;
      this.store.upsertShellSession(session).catch(() => {
        this.stats.errors += 1;
      });
      this.emit({ type: 'session-stale', session });
    }
  }

  async stop(status = 'STOPPED') {
    if (this.staleTimer) clearInterval(this.staleTimer);
    if (this.server) await this.server.stop();
    this.running = false;
    void status;
  }

  health() {
    return {
      status: this.running ? (this.degraded ? 'DEGRADED' : 'RUNNING') : this.degraded ? 'DEGRADED' : 'STOPPED',
      port: this.port,
      stats: { ...this.stats },
      activeSessions: this.registry.list({ active: true }).length,
      lastEvent: this.lastEvent,
    };
  }
}
