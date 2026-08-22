// In-memory parent/child process tree — see SPEC_V0.4.md "Process tree" / "PID reuse". Runtime
// identity is pid + the timestamp at which THAT instance started, never a bare pid: the
// byPid map only ever holds the currently-alive pid -> runtimeId link, so a later, unrelated
// process reusing the same OS pid gets a brand new runtimeId and is never confused with the
// earlier one.
export class ProcessTree {
  constructor() {
    this.byRuntimeId = new Map();
    this.byPid = new Map();
  }

  static runtimeId(pid, timestamp) {
    return `${pid}:${timestamp}`;
  }

  addStart(record) {
    const runtimeId = ProcessTree.runtimeId(record.pid, record.timestamp);
    const parentRuntimeId = record.parentPid != null ? this.byPid.get(record.parentPid) || null : null;

    this.byRuntimeId.set(runtimeId, {
      ...record,
      runtimeId,
      parentRuntimeId,
      childRuntimeIds: new Set(),
      stoppedAt: null,
    });
    if (parentRuntimeId && this.byRuntimeId.has(parentRuntimeId)) {
      this.byRuntimeId.get(parentRuntimeId).childRuntimeIds.add(runtimeId);
    }
    this.byPid.set(record.pid, runtimeId);
    return runtimeId;
  }

  // Marks the currently-alive instance of this pid as stopped. Returns its runtimeId, or null if
  // this pid was never observed starting (e.g. it predates the observer and was never snapshot).
  markStop(pid, timestamp) {
    const runtimeId = this.byPid.get(pid);
    if (!runtimeId) return null;
    const record = this.byRuntimeId.get(runtimeId);
    if (record) record.stoppedAt = timestamp;
    this.byPid.delete(pid);
    return runtimeId;
  }

  get(runtimeId) {
    return this.byRuntimeId.get(runtimeId) || null;
  }

  getByPid(pid) {
    const runtimeId = this.byPid.get(pid);
    return runtimeId ? this.byRuntimeId.get(runtimeId) : null;
  }

  // Nearest-first list of ancestor records (parent, grandparent, ...).
  ancestors(runtimeId) {
    const chain = [];
    let current = this.byRuntimeId.get(runtimeId);
    while (current && current.parentRuntimeId) {
      current = this.byRuntimeId.get(current.parentRuntimeId);
      if (current) chain.push(current);
    }
    return chain;
  }

  // e.g. "WindowsTerminal.exe > powershell.exe > claude.exe" — root-first, current process last.
  treeSummary(runtimeId) {
    const chain = [...this.ancestors(runtimeId)].reverse().map((r) => r.processName);
    const self = this.byRuntimeId.get(runtimeId);
    if (self) chain.push(self.processName);
    return chain.join(' > ');
  }
}
