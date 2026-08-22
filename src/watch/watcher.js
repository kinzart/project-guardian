// Top-level watch orchestrator: start(projects, options) / stop() / onEvent(callback) /
// health(). Owns one adapter watch per project root (failure isolation: one broken root is
// marked DEGRADED/MISSING, the rest keep running), a session record, and root-recovery polling
// for a project root that disappears and later comes back (see SPEC_V0.3.md "Project deleted /
// moved").

import { existsSync } from 'node:fs';
import { createFsWatchAdapter } from './adapter.js';
import { createEventPipeline } from './event-pipeline.js';

function newSessionId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class Watcher {
  constructor({ store, config, reportsDir, guardianSelfPaths, adapter = createFsWatchAdapter(), rootCheckMs = 2000 }) {
    this.store = store;
    this.config = config;
    this.reportsDir = reportsDir;
    this.guardianSelfPaths = guardianSelfPaths;
    this.adapter = adapter;
    this.rootCheckMs = rootCheckMs;

    this.projects = [];
    this.stopFns = new Map();
    this.rootStatus = new Map();
    this.stats = {
      eventsReceived: 0,
      eventsIgnored: 0,
      eventsCoalesced: 0,
      protectedEvents: 0,
      refreshes: 0,
      intelligenceRecomputed: 0,
      intelligenceReused: 0,
      errors: 0,
    };
    this.listeners = [];
    this.sessionId = null;
    this.startedAt = null;
    this.running = false;
    this.lastEvent = null;
    this.recoveryTimer = null;
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
        // a listener throwing must never break the watcher
      }
    }
  }

  #watchRoot(project) {
    const stop = this.adapter.watch(
      project.root_path,
      (eventType, filename) => this.pipeline.ingest(project.root_path, eventType, filename),
      (err) => this.#handleRootError(project, err),
    );
    this.stopFns.set(project.root_path, stop);
    this.rootStatus.set(project.root_path, 'OK');
  }

  #recordRootEvent(project, eventType) {
    this.store
      .addWatchEvent({
        event_id: newSessionId(),
        occurred_at: new Date().toISOString(),
        project_id: project.id,
        project_root: project.root_path,
        event_type: eventType,
        paths: [],
        path_classes: [],
        raw_event_count: 0,
        first_seen_at: new Date().toISOString(),
        settled_at: new Date().toISOString(),
        triggered_refresh: false,
        intelligence_recomputed: false,
      })
      .catch(() => {});
  }

  #handleRootError(project, err) {
    this.stats.errors += 1;
    const stopFn = this.stopFns.get(project.root_path);
    if (stopFn) stopFn();
    this.stopFns.delete(project.root_path);

    const stillExists = existsSync(project.root_path);
    const status = stillExists ? 'DEGRADED' : 'MISSING';
    const wasOk = this.rootStatus.get(project.root_path) === 'OK';
    this.rootStatus.set(project.root_path, status);
    this.emit({ type: 'watch-error', project, error: { message: err?.message || String(err) }, status });

    if (!stillExists && wasOk) this.#recordRootEvent(project, 'PROJECT_ROOT_MISSING');
  }

  #startRecoveryPolling() {
    this.recoveryTimer = setInterval(() => this.#pollRootHealth(), this.rootCheckMs);
    if (typeof this.recoveryTimer.unref === 'function') this.recoveryTimer.unref();
  }

  // Runs on every tick for every watched root, in both directions. Proactive existence checks
  // (rather than relying solely on fs.watch's own 'error' event, whose behavior on a deleted
  // directory is not perfectly consistent across platforms) is what actually detects a root
  // disappearing; #handleRootError catches other failures (e.g. a permission error) even when
  // the root itself still exists.
  #pollRootHealth() {
    for (const project of this.projects) {
      const status = this.rootStatus.get(project.root_path);
      const exists = existsSync(project.root_path);

      if (status === 'MISSING' && exists) {
        // Root reappeared: never assume it's identical to before — just resume watching and let
        // the next targeted/full refresh pick up whatever is actually there now.
        this.#watchRoot(project);
        this.emit({ type: 'root-available', project });
        this.#recordRootEvent(project, 'PROJECT_ROOT_AVAILABLE');
      } else if (status !== 'MISSING' && !exists) {
        const stopFn = this.stopFns.get(project.root_path);
        if (stopFn) stopFn();
        this.stopFns.delete(project.root_path);
        this.rootStatus.set(project.root_path, 'MISSING');
        this.emit({ type: 'watch-error', project, error: { message: 'project root no longer exists' }, status: 'MISSING' });
        this.#recordRootEvent(project, 'PROJECT_ROOT_MISSING');
      }
    }
  }

  async start(projects) {
    this.projects = projects;
    this.startedAt = new Date();
    this.sessionId = newSessionId();
    this.running = true;

    this.pipeline = createEventPipeline({
      store: this.store,
      config: this.config,
      projects: this.projects,
      reportsDir: this.reportsDir,
      guardianSelfPaths: this.guardianSelfPaths,
      stats: this.stats,
      onRefresh: (info) => this.emit({ type: 'refresh', ...info }),
      onIgnored: () => {},
      onProtected: (raw) => this.emit({ type: 'protected', root: raw.root }),
      onError: (err) => {
        this.stats.errors += 1;
        this.emit({ type: 'error', error: { message: err?.message || String(err) } });
      },
    });

    for (const project of this.projects) {
      try {
        this.#watchRoot(project);
      } catch (err) {
        this.#handleRootError(project, err);
      }
    }

    this.#startRecoveryPolling();

    await this.store.startWatchSession({
      session_id: this.sessionId,
      started_at: this.startedAt.toISOString(),
      stopped_at: null,
      status: 'RUNNING',
      pid: process.pid,
      projects_watched: this.projects.length,
      watched_paths: this.projects.map((p) => p.root_path),
    });

    return this.sessionId;
  }

  async stop(status = 'STOPPED') {
    if (!this.running) return;
    this.running = false;
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    for (const stopFn of this.stopFns.values()) stopFn();
    this.stopFns.clear();
    if (this.pipeline) {
      this.pipeline.coalescer.flushAll();
      // Bounded wait for in-flight async flush handlers (store writes) to land before we close.
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (this.sessionId) {
      await this.store.updateWatchSession(this.sessionId, {
        stopped_at: new Date().toISOString(),
        status,
        events_received: this.stats.eventsReceived,
        events_coalesced: this.stats.eventsCoalesced,
        refreshes: this.stats.refreshes,
        errors: this.stats.errors,
      });
    }
  }

  health() {
    const statuses = Array.from(this.rootStatus.values());
    const degraded = statuses.some((s) => s !== 'OK');
    return {
      status: !this.running ? 'STOPPED' : degraded ? 'DEGRADED' : 'RUNNING',
      startedAt: this.startedAt?.toISOString() || null,
      projectsWatched: this.projects.length,
      watchedPaths: this.projects.map((p) => p.root_path),
      rootStatus: Object.fromEntries(this.rootStatus),
      stats: { ...this.stats },
      lastEvent: this.lastEvent,
    };
  }
}
