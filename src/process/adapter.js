// Process adapter interface — see SPEC_V0.4.md "Windows adapter". The core (observer.js) only
// ever talks to this shape; it never imports WMI/CIM/PowerShell directly.
//
// interface ProcessAdapter {
//   start({ onEvent, onError }): { stop(): void }
//     onEvent(rawEvent) where rawEvent = {
//       type: 'ALREADY_RUNNING' | 'PROCESS_STARTED' | 'PROCESS_STOPPED',
//       pid, parentPid, processName, executablePath, commandLine, timestamp
//     }
// }

// Deterministic, dependency-free adapter used by every unit test. Never spawns a real process or
// PowerShell — tests drive it directly via emitStart/emitStop/emitAlreadyRunning.
export function createFakeProcessAdapter() {
  let handlers = null;
  return {
    start({ onEvent, onError }) {
      handlers = { onEvent, onError };
      return { stop: () => { handlers = null; } };
    },
    emitAlreadyRunning(proc) {
      handlers?.onEvent({ ...proc, type: 'ALREADY_RUNNING' });
    },
    emitStart(proc) {
      handlers?.onEvent({ ...proc, type: 'PROCESS_STARTED' });
    },
    emitStop(proc) {
      handlers?.onEvent({ ...proc, type: 'PROCESS_STOPPED' });
    },
    emitError(err) {
      handlers?.onError?.(err);
    },
    isRunning() {
      return handlers !== null;
    },
  };
}
