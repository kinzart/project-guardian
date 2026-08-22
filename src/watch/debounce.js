// Per-project event coalescing. Saving a file can fire several raw fs events (atomic-save
// rename sequences especially); this buffers them and emits exactly one flush per project once
// things go quiet (debounceMs) or a hard cap is hit under continuous activity (settleMs) — see
// SPEC_V0.3.md "Debounce / coalescing".
export class Coalescer {
  constructor({ debounceMs, settleMs, onFlush }) {
    this.debounceMs = debounceMs;
    this.settleMs = settleMs;
    this.onFlush = onFlush;
    this.buffers = new Map();
  }

  push(projectId, event) {
    let buf = this.buffers.get(projectId);
    if (!buf) {
      buf = { paths: new Set(), pathClasses: new Set(), rawCount: 0, firstSeenAt: event.occurredAt, debounceTimer: null, settleTimer: null };
      this.buffers.set(projectId, buf);
      buf.settleTimer = setTimeout(() => this.flush(projectId), this.settleMs);
      if (typeof buf.settleTimer.unref === 'function') buf.settleTimer.unref();
    }
    buf.paths.add(event.absPath);
    buf.pathClasses.add(event.significance);
    buf.rawCount += 1;
    if (buf.debounceTimer) clearTimeout(buf.debounceTimer);
    buf.debounceTimer = setTimeout(() => this.flush(projectId), this.debounceMs);
    if (typeof buf.debounceTimer.unref === 'function') buf.debounceTimer.unref();
  }

  flush(projectId) {
    const buf = this.buffers.get(projectId);
    if (!buf) return;
    this.buffers.delete(projectId);
    clearTimeout(buf.debounceTimer);
    clearTimeout(buf.settleTimer);
    const settledAt = new Date().toISOString();
    this.onFlush(projectId, {
      paths: Array.from(buf.paths),
      pathClasses: Array.from(buf.pathClasses),
      rawEventCount: buf.rawCount,
      firstSeenAt: buf.firstSeenAt,
      settledAt,
    });
  }

  // Forces every pending project to flush immediately — used on graceful shutdown so no
  // in-flight batch is silently lost.
  flushAll() {
    for (const projectId of Array.from(this.buffers.keys())) this.flush(projectId);
  }

  stop() {
    for (const buf of this.buffers.values()) {
      clearTimeout(buf.debounceTimer);
      clearTimeout(buf.settleTimer);
    }
    this.buffers.clear();
  }

  pendingCount() {
    return this.buffers.size;
  }
}
