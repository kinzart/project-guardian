// Real Windows process adapter — spawns windows-observer.ps1 and turns its JSON-lines stdout
// into onEvent calls. See SPEC_V0.4.md section 4 for the __InstanceCreationEvent/
// __InstanceDeletionEvent rationale. Never captures stderr content beyond surfacing it as an
// error (it is PowerShell's own diagnostic stream, not process/terminal content).

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(__dirname, 'windows-observer.ps1');

export function createWindowsProcessAdapter() {
  return {
    start({ onEvent, onError }) {
      let child;
      try {
        child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH], {
          windowsHide: true,
        });
      } catch (err) {
        onError?.(err);
        return { stop() {} };
      }

      let buffer = '';
      let stopped = false;

      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          let parsed;
          try {
            parsed = JSON.parse(line);
          } catch (err) {
            onError?.(err);
            continue;
          }
          if (parsed.type === 'ADAPTER_READY') continue;
          if (parsed.type === 'ADAPTER_ERROR') {
            onError?.(new Error(parsed.message || 'windows process observer reported an error'));
            continue;
          }
          onEvent(parsed);
        }
      });

      child.stderr.on('data', () => {
        // PowerShell diagnostic noise (warnings, deprecation notices) — never process/terminal
        // content. Not surfaced as a Guardian error; the observer only cares whether the child
        // stays alive and keeps emitting valid JSON events.
      });

      child.on('error', (err) => {
        if (!stopped) onError?.(err);
      });

      child.on('exit', (code) => {
        if (!stopped && code !== 0 && code !== null) {
          onError?.(new Error(`windows process observer exited with code ${code}`));
        }
      });

      return {
        stop() {
          stopped = true;
          try {
            child.kill();
          } catch {
            // already gone
          }
        },
      };
    },
  };
}
