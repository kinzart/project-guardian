# Project Guardian

Project Guardian is a local, Windows-first project inventory and cross-agent activity supervisor. It discovers development projects, derives evidence-backed operational status, observes files/processes/shells, receives metadata-only Claude Code and Codex lifecycle hooks, and can render a safe Obsidian dashboard.

## Requirements

- Windows 10 or 11
- Node.js 18+
- Git

WSL, Git Bash, Claude Code, Codex, and Obsidian are optional. Guardian never installs those tools automatically.

## Install

```powershell
npm install --global @kinzart/project-guardian
guardian install
```

If PowerShell blocks the generated `guardian.ps1` shim under a Restricted execution policy, invoke `guardian.cmd` or remove only that generated `.ps1` shim so PowerShell resolves the `.cmd` launcher. Do not weaken the machine execution policy solely for Guardian.

## Everyday commands

```powershell
guardian doctor
guardian service status
guardian list
guardian query active
guardian ask "no que estou trabalhando?"
guardian obsidian status
```

Runtime control:

```powershell
guardian service start
guardian service stop
guardian service restart
```

Run `guardian --help` for the complete command surface.

## Privacy

Guardian stores structural metadata only. It does not store prompts, assistant responses, reasoning, transcripts, raw terminal output, environment values, credentials, or secret-file contents. See [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md).

## Documentation

- [Install](INSTALL.md)
- [Uninstall](UNINSTALL.md)
- [Recovery](RECOVERY.md)
- [Architecture](ARCHITECTURE.md)
- [Troubleshooting](TROUBLESHOOTING.md)

## License

MIT
