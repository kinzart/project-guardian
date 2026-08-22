import { watch } from 'node:fs';

// Thin wrapper over node:fs's native recursive watch. Nothing outside this file imports
// node:fs's watch API directly — see SPEC_V0.3.md "Watch adapter" for why a library like
// chokidar wasn't added (recursive watch is natively supported on this platform).
export function createFsWatchAdapter() {
  return {
    // Starts watching `root` recursively. onEvent(eventType, filename) fires per raw fs event;
    // onError(err) fires on any watcher failure (including the root becoming inaccessible).
    // Returns a stop() function, safe to call more than once.
    watch(root, onEvent, onError) {
      let watcher;
      try {
        watcher = watch(root, { recursive: true, persistent: true }, (eventType, filename) => {
          try {
            onEvent(eventType, filename);
          } catch (err) {
            onError(err);
          }
        });
      } catch (err) {
        onError(err);
        return () => {};
      }
      watcher.on('error', onError);
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        try {
          watcher.close();
        } catch {
          // already closed
        }
      };
    },
  };
}
