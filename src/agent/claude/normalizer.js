// Validated Claude hook event -> Guardian's normalized native event shape — see SPEC_V0.6A.md
// "Native event model". Deliberately does NOT resolve project correlation or session unification
// here (both need the live project list / store, which this pure function has no access to) —
// that's observer.js's job, mirroring how src/shell/wsl/normalizer.js stays a pure mapping too.

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const NATIVE_EVENT_BY_TYPE = {
  SessionStart: (v) => (v.source === 'resume' ? 'AGENT_SESSION_RESUMED' : 'AGENT_SESSION_STARTED'),
  CwdChanged: () => 'AGENT_CWD_CHANGED',
  SessionEnd: () => 'AGENT_SESSION_ENDED',
  Stop: () => 'AGENT_TURN_COMPLETED',
  StopFailure: () => 'AGENT_TURN_FAILED',
};

export function normalizeClaudeAgentEvent(validated) {
  const nativeEvent = NATIVE_EVENT_BY_TYPE[validated.hook_event_name]?.(validated) || null;

  // Only SessionStart/CwdChanged carry a meaningful cwd — SessionEnd/Stop/StopFailure never do
  // (Claude doesn't report one for those events), so cwd stays null rather than reusing a stale
  // value from a prior event.
  let cwd = null;
  if (validated.hook_event_name === 'SessionStart') cwd = validated.cwd ?? null;
  else if (validated.hook_event_name === 'CwdChanged') cwd = validated.new_cwd;

  return {
    event_id: newId(),
    agent: 'CLAUDE_CODE',
    native_session_id: validated.session_id,
    native_event: nativeEvent,
    raw_hook_event_name: validated.hook_event_name,
    cwd,
    native_process_pid: validated.native_process_pid,
    timestamp: validated.timestamp,
    received_at: new Date().toISOString(),
    source: 'CLAUDE_NATIVE_HOOK',
    native_metadata: {
      start_source: validated.hook_event_name === 'SessionStart' ? validated.source : null,
      end_reason: validated.hook_event_name === 'SessionEnd' ? validated.reason : null,
      hook_version: validated.hook_version ?? null,
    },
  };
}
