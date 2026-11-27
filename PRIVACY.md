# Privacy

Stored data is structural metadata: project paths/status evidence, timestamps, process identity/classification, shell CWD transitions, and native agent lifecycle metadata. Guardian does not store prompts, assistant content (except as noted below), reasoning, transcripts, raw terminal output, environment contents, credentials, `.env` contents, or secrets.

Operational event streams are bounded to 1,000 entries per stream. Logs default to 30-day retention and a combined 50 MiB cap. All processing is local; conversational answers are deterministic unless a future optional provider is explicitly configured.

## Cérebro vault (1.1)

When an Obsidian vault is configured, `guardian obsidian render` reads Codex, Claude Code and Hermes session files on this computer and copies **only the last assistant message of each session, trimmed to 600 characters**, plus its session id, title, time and working folder. That text is kept in `data/agent-sessions.json` and in the vault's project notes, both local. Prompts, tool output and full transcripts are not stored.

Under `metadataOnlyRoots` (for example a Google Drive streaming mount) Guardian only lists and stats entries; it never opens a file there, so cloud-only files are not downloaded.

If `cerebro.suggestCommand` is set, the nightly run sends a one-line-per-project digest (name, type, dates, last agent, path) to that command, which may be a cloud AI CLI such as `codex exec --skip-git-repo-check -`. Leave it `null` to keep everything offline.
