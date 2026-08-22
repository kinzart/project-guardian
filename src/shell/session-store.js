// In-memory shell session registry — see SPEC_V0.5A.md section 9. Tracks structural context
// only: pid/parent pid/shell type/version/host name and a CWD timeline. Never stores commands.

export class ShellSessionRegistry {
  constructor() {
    this.sessions = new Map(); // shell_session_id -> session
    this.byPid = new Map(); // pid -> shell_session_id, currently-alive shells only
  }

  onShellStarted(evt) {
    const session = {
      shell_session_id: evt.shell_session_id,
      pid: evt.pid,
      parent_pid: evt.parent_pid,
      shell_type: evt.shell_type,
      shell_version: evt.shell_version,
      host_name: evt.host_name,
      started_at: evt.timestamp,
      ended_at: null,
      status: 'ACTIVE',
      cwd: evt.cwd,
      cwd_timeline: [{ cwd: evt.cwd, at: evt.timestamp }],
    };
    this.sessions.set(session.shell_session_id, session);
    this.byPid.set(session.pid, session.shell_session_id);
    return session;
  }

  // Returns { session, duplicate: boolean } — duplicate=true when the CWD didn't actually
  // change (the prompt-wrapper fires on every render, only a real change should be an event, but
  // the registry itself is the authoritative de-dup point so a client-side bug can't matter).
  onCwdChanged(evt) {
    const session = this.sessions.get(evt.shell_session_id) || this.#findByPidFallback(evt.pid);
    if (!session) return { session: null, duplicate: false };
    if (session.cwd === evt.cwd) return { session, duplicate: true };
    session.cwd = evt.cwd;
    session.cwd_timeline.push({ cwd: evt.cwd, at: evt.timestamp });
    return { session, duplicate: false };
  }

  onShellExiting(evt) {
    const session = this.sessions.get(evt.shell_session_id) || this.#findByPidFallback(evt.pid);
    if (!session) return null;
    session.status = 'ENDED';
    session.ended_at = evt.timestamp;
    this.byPid.delete(session.pid);
    return session;
  }

  // Called by the process observer when it independently learns a shell's process has stopped
  // (SHELL_EXITING is not reliable — killed window, crashed host). Never invents a graceful exit.
  reconcileStopped(pid, timestamp) {
    const sessionId = this.byPid.get(pid);
    if (!sessionId) return null;
    const session = this.sessions.get(sessionId);
    if (session.status !== 'ACTIVE') return session;
    session.status = 'UNCLEAN';
    session.ended_at = timestamp;
    this.byPid.delete(pid);
    return session;
  }

  #findByPidFallback(pid) {
    const sessionId = this.byPid.get(pid);
    return sessionId ? this.sessions.get(sessionId) : null;
  }

  getByPid(pid) {
    const sessionId = this.byPid.get(pid);
    return sessionId ? this.sessions.get(sessionId) : null;
  }

  get(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  list({ active } = {}) {
    const all = Array.from(this.sessions.values());
    if (active === undefined) return all;
    return all.filter((s) => (active ? s.status === 'ACTIVE' : s.status !== 'ACTIVE'));
  }
}
