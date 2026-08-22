// Raw adapter event -> normalized shape. Adapters emit slightly different raw field names
// (windows-adapter.js reads them from PowerShell JSON; the fake adapter used by tests constructs
// them directly) — this is the one place that settles on a single internal shape.

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// raw: { type: 'ALREADY_RUNNING'|'PROCESS_STARTED'|'PROCESS_STOPPED', pid, parentPid,
//        processName, executablePath, commandLine, timestamp }
export function normalizeProcessEvent(raw) {
  if (!raw || !raw.type || !raw.pid) return null;
  return {
    id: newId(),
    type: raw.type,
    timestamp: raw.timestamp || new Date().toISOString(),
    pid: Number(raw.pid),
    parentPid: raw.parentPid != null ? Number(raw.parentPid) : null,
    processName: raw.processName || 'unknown',
    executablePath: raw.executablePath || null,
    // Kept only transiently in-memory for classification/sanitization/correlation — never
    // persisted as-is (see sanitizer.js / observer.js).
    commandLine: raw.commandLine || null,
    // PROCESS_STARTED/STOPPED are always real-time observed, so their own timestamp IS the true
    // event time. Only ALREADY_RUNNING carries genuine ambiguity (see windows-observer.ps1).
    startTimeKnown: raw.type === 'ALREADY_RUNNING' ? Boolean(raw.startTimeKnown) : true,
  };
}
