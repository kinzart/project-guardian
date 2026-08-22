# Architecture

Project Guardian is a local Node.js application with a single-writer runtime. A user-session recovery supervisor owns one observed runtime protected by atomic PID locks.

The runtime combines filesystem watching, process observation, shell IPC, Claude Code/Codex lifecycle receivers, scheduled reconciliation, bounded event retention, and derived project intelligence. Hooks use local transports, strict allow-list schemas, and fail open when Guardian is unavailable.

Storage and generated reports live under Guardian's configured home. A repository checkout uses its own root; an npm installation defaults to `%LOCALAPPDATA%\Project Guardian` (or `~/.project-guardian` outside Windows), and `GUARDIAN_HOME` can override it. Code and state remain separate, so package updates do not replace the database. Project trees are read-only inputs. Obsidian output is derived, ownership-marked, incremental, and preserves manual note sections.

Windows auto-start prefers a limited user logon task and falls back to a hidden per-user Startup launcher when task creation is denied by host policy.
