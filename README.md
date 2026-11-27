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

## Cérebro: painel de todos os projetos no Obsidian

```powershell
guardian obsidian configure D:\CEREBRO   # an existing vault (has a .obsidian folder)
guardian obsidian render                  # Painel, Mapa, Duplicados and one note per project
guardian cerebro rule install             # asks Codex/Claude to log a short summary per task
guardian cerebro nightly                  # scan + render + AI suggestions (Sugestões.md)
```

Each project note shows status, last change (and which file), the universal summary, the last AI session (Codex, Claude Code or Hermes) with its final message and a **▶ Retomar** link that reopens that exact session in the project folder. To delete a project, tick the **excluir** property in its note (or write `#apagar` under "Minhas notas"), then run `guardian cerebro limpar` to see the list and `guardian cerebro limpar --confirmar` to send those folders to the Windows Recycle Bin. Drive roots, scanned roots and folders holding other unmarked projects are refused. Projects untouched for `cerebro.archiveDays` (365) are listed as "Arquivo — não mexer". Nothing in your project folders is moved, changed or deleted. Set `metadataOnlyRoots` for Google Drive so nothing is downloaded.

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
