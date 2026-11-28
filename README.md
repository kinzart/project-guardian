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

Each project note shows status, last change (and which file), the universal summary, the last AI session (Codex, Claude Code or Hermes) with its final message and a **▶ Retomar** link that reopens that exact session in the project folder. To delete a project, tick the **excluir** property in its note (or write `#apagar` under "Minhas notas"), then run `guardian cerebro limpar` to see the list and `guardian cerebro limpar --confirmar` to send those folders to the Windows Recycle Bin. Drive roots, scanned roots and folders holding other unmarked projects are refused. For a deep clean-up, give an agent (e.g. Hermes) the task in `<vault>\_hermes\TRIAGEM.md`: it only writes `<vault>\Triagem\<project>.md` notes with `- [ ] apagar: \`path\`` lines; tick the ones you agree with and the same `limpar` command sends them to the Recycle Bin. Projects untouched for `cerebro.archiveDays` (365) are listed as "Arquivo — não mexer". Nothing in your project folders is moved, changed or deleted. Set `metadataOnlyRoots` for Google Drive so nothing is downloaded.

Each note also has an **Arquivos** section: every file inside the project by type (vídeo, áudio, projeto de música, imagem, design, planilha…), the main folders, a photo gallery (up to 12 thumbnails), the videos, the latest files, and a link to `Project Guardian/Arquivos/<projeto>.md` with the complete list grouped by folder. The frontmatter gets `arquivos`, `tamanho`, `tem` and `tags: tem/<tipo>` so the Obsidian graph and search can filter by what a folder contains. Only names, sizes and dates are read (opening a note with Drive photos downloads those thumbnails). Turn it off with `cerebro.inventory: false`.

**Descrição e maturidade.** `guardian cerebro descrever [N] [--todos]` (also part of the nightly) finds each project's `.md` docs (README, CLAUDE.md, AGENTS.md, docs/…), sends their text to a cheap AI (`cerebro.describeCommand`, default `codex exec … -m gpt-6-luna` with low effort, read-only, 3 at a time) and writes a **Descrição** section: what it is, what was done, where it started, where it is now, and `maturidade` (inacabado / quase resolvido / resolvido e funcional). It is cached in `data/cerebro-descricoes.json` and only re-run when the docs change. Set `cerebro.describe: false` to turn it off, or `cerebro.describeDrive: false` to skip Google Drive folders (their .md files are downloaded to be read). Folders without docs are described from their file listing.

**Ligações.** `guardian cerebro ligar [N]` (also in the nightly) links projects across places using similar names, identical files (name + size) and shared working days. Obvious pairs are linked directly; likely ones are judged by the cheap AI, then by a second opinion (`cerebro.secondOpinionCommand`) when unsure; the rest go to `Project Guardian/Acertos.md`, where you tick the right option (or "nenhum"). Links show in each note (`## Ligações`, `ligado_a`), in the graph and in the Mapa ("Ligações entre lugares"). Empty folders are listed in `Triagem/Pastas vazias.md` for `guardian cerebro limpar`.

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
