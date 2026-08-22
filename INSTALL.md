# Install

From the repository, run `node bin/guardian.js install`. The installer verifies Node, initializes storage, detects roots, scans, installs only hooks for tools already present, configures user-context auto-start, starts Guardian, runs doctor, and writes `reports/INSTALL_REPORT.md`.

It does not install WSL, Obsidian, Claude, Codex, or Git Bash. Codex hook trust is never bypassed; if the report says manual action is required, open Codex and use `/hooks`.

Re-running install is supported. Existing configuration and database state are preserved, hooks remain single, and every external edit is backed up.
