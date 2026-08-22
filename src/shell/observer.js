// Shell IPC observer orchestrator — mirrors the start/stop/onEvent/health shape of
// src/watch/watcher.js and src/process/observer.js so `guardian observe` can run all three
// subsystems side by side (see SPEC_V0.5A.md section 11).

import { createShellIpcServer, DEFAULT_PIPE_NAME, DEFAULT_TCP_PORT } from './ipc-server.js';
import { normalizeShellEvent } from './normalizer.js';
import { ShellSessionRegistry } from './session-store.js';
import { resolveProjectForCwd } from './correlator.js';

export class ShellObserver {
  constructor({ store, pipeName = DEFAULT_PIPE_NAME, tcpPort = DEFAULT_TCP_PORT, ipcServerFactory = createShellIpcServer }) {
    this.store = store;
    this.pipeName = pipeName;
    this.tcpPort = tcpPort;
    this.ipcServerFactory = ipcServerFactory;
    this.registry = new ShellSessionRegistry();
    this.projects = [];

    this.stats = {
      eventsReceived: 0,
      shellsStarted: 0,
      cwdChanges: 0,
      duplicateCwdSuppressed: 0,
      shellsExited: 0,
      schemaRejections: 0,
      errors: 0,
    };

    this.listeners = [];
    this.running = false;
    this.degraded = false;
    this.lastEvent = null;
    this.server = null;
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
        // a listener throwing must never break the shell observer
      }
    }
  }

  updateProjects(projects) {
    this.projects = projects;
  }

  async start(projects = []) {
    this.projects = projects;
    this.server = this.ipcServerFactory({
      pipeName: this.pipeName,
      tcpPort: this.tcpPort,
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
      // Pipe couldn't bind (e.g. already in use by another Guardian instance) — never crashes
      // guardian observe; the other two subsystems keep running (see SPEC_V0.5A.md section 11).
      this.running = false;
      this.degraded = true;
      this.emit({ type: 'error', error: { message: err?.message || String(err) } });
    }
    return this.running;
  }

  #persist(normalized, session) {
    const project = normalized.cwd ? resolveProjectForCwd(normalized.cwd, this.projects) : null;
    const record = { ...normalized, project_id: project?.id || null };
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
    const normalized = normalizeShellEvent(validated);

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
      this.#persist(normalized, session);
      this.emit({ type: 'shell-exiting', session });
    }
  }

  // Called when the V0.4 process observer independently learns a shell's OS process stopped
  // (SHELL_EXITING is not reliable — killed window, crashed host; see SPEC_V0.5A.md section 9).
  // Never invents a graceful exit for a session that never sent SHELL_EXITING.
  reconcileProcessStopped(pid, timestamp) {
    const session = this.registry.reconcileStopped(pid, timestamp);
    if (session) this.store.upsertShellSession(session).catch(() => {});
    return session;
  }

  async stop(status = 'STOPPED') {
    if (this.server) await this.server.stop();
    this.running = false;
  }

  health() {
    return {
      status: this.running ? (this.degraded ? 'DEGRADED' : 'RUNNING') : this.degraded ? 'DEGRADED' : 'STOPPED',
      pipeName: this.pipeName,
      stats: { ...this.stats },
      activeShells: this.registry.list({ active: true }).length,
      lastEvent: this.lastEvent,
    };
  }
}
