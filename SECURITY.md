# Security

Guardian uses loopback/local IPC, strict schemas, narrow event allow-lists, PID checks, fail-open hooks, atomic state writes, limited user privileges, and ownership markers. It refuses unknown hook fields and does not execute project content. Secret-shaped files and directories are denied before inspection.

The runtime intentionally executes as the interactive user, never LocalSystem, because its scope is that user's projects and tool configuration. Codex trust remains a human decision.
