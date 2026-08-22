// Validated Codex hook event -> Guardian's normalized native event shape — see SPEC_V0.6B.md
// "Normalized events". Pure mapping, no project/session lookup here (observer.js's job), same
// split as src/agent/claude/normalizer.js.

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const NATIVE_EVENT_BY_TYPE = {
  // Codex's own SessionStart source values are startup/resume/clear/compact (no "fork" — that's
  // Claude-only, confirmed via official docs — see SPEC_V0.6B.md section 1).
  SessionStart: (v) => (v.source === 'resume' ? 'AGENT_SESSION_RESUMED' : 'AGENT_SESSION_STARTED'),
  SessionEnd: () => 'AGENT_SESSION_ENDED',
  Stop: () => 'AGENT_TURN_COMPLETED',
};

export function normalizeCodexAgentEvent(validated) {
  const nativeEvent = NATIVE_EVENT_BY_TYPE[validated.hook_event_name]?.(validated) || null;

  // Codex has no native cwd-change event (confirmed, never assumed — see SPEC_V0.6B.md section
  // 1), so cwd is only ever meaningful on SessionStart; SessionEnd/Stop never carry one.
  const cwd = validated.hook_event_name === 'SessionStart' ? (validated.cwd ?? null) : null;

  return {
    event_id: newId(),
    agent: 'CODEX',
    native_session_id: validated.session_id,
    native_event: nativeEvent,
    raw_hook_event_name: validated.hook_event_name,
    cwd,
    model: validated.model ?? null,
    native_process_pid: validated.native_process_pid,
    timestamp: validated.timestamp,
    received_at: new Date().toISOString(),
    source: 'CODEX_NATIVE_HOOK',
    native_metadata: {
      start_source: validated.hook_event_name === 'SessionStart' ? validated.source : null,
      end_reason: validated.hook_event_name === 'SessionEnd' ? validated.reason : null,
      model: validated.model ?? null,
      hook_version: validated.hook_version ?? null,
    },
  };
}
