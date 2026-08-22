# Troubleshooting

- Run `node bin/guardian.js repair` for a non-mutating audit.
- Run `node bin/guardian.js service status` to inspect auto-start, supervisor, and runtime locks.
- Run `node bin/guardian.js service restart` after a runtime failure.
- Run `node bin/guardian.js shell doctor` or `agent doctor claude|codex` for hook checks.
- If Codex hooks are untrusted, open Codex and use `/hooks`; Guardian will not bypass this gate.
- If Scheduled Task creation is denied, Guardian uses its hidden per-user Startup launcher.
- WSL absence is supported and non-blocking. CMD integration is best effort and not supported as a release gate.
- Runtime diagnostics are in `logs/runtime.log`; generated install results are in `reports/INSTALL_REPORT.md`.
