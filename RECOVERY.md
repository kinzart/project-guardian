# Recovery

Run `node bin/guardian.js repair` for a read-only audit. Use `node bin/guardian.js service restart` for runtime recovery. A recovery supervisor restarts unexpected runtime exits after five seconds; stale locks are reclaimed and prior sessions are reconciled as uncertain rather than falsely ended.

Hook-specific restore commands are available through `guardian shell restore`. Reinstall is idempotent and is the supported repair for missing owned entries.
