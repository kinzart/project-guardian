# Cérebro Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Project Guardian's existing inventory into a Portuguese Obsidian "second brain": every project (code and creative) with status, last change, last AI session + summary + one-click resume, universal summary, tree map, duplicate candidates and a nightly AI suggestions note.

**Architecture:** Additive modules beside the existing scanner and renderer. Scanner gains creative evidence, metadata-only roots and a "latest entry" field. A new `src/sessions/` indexes Codex / Claude Code / Hermes session files from disk and maps them to projects by `cwd`. A new `src/cerebro/` composes summaries, duplicates, launchers and suggestions; `src/obsidian/renderer.js` is rewritten to render the Portuguese vault. No DB schema changes: sessions are cached in `data/agent-sessions.json`.

**Tech Stack:** Node ≥18 ESM, `node:test`, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-27-cerebro-hub-design.md`

## Global Constraints

- Never write, move or delete anything inside scanned roots. Writes go only to the vault, Guardian's `data/`, and (Task 7, opt-in command) the marked block in global agent rule files.
- Under `metadataOnlyRoots` (Google Drive): only `readdir`/`stat`, never open a file.
- Vault labels in Portuguese. Archive threshold: no change for 365 days → "Arquivo — não mexer".
- Session summary = last assistant text, trimmed to 600 chars; stored only in vault and `data/`.
- Session ids accepted only if they match `/^[A-Za-z0-9._-]{1,128}$/`; `cwd` rejected if it contains `"`, `%`, `&`, `|`, `<`, `>`, `^` or a newline (launcher safety).
- Run tests with `node --test --test-concurrency=1 test/<file>.test.js` (17 Windows-only tests already fail on Linux; ignore them).

## Review Focus

1. A session whose `cwd` is a subfolder of a project must map to that project (longest root prefix wins), case-insensitive on Windows paths — test in Task 2.
2. Huge session files (tens of MB) must not be read whole: tail-read only — test in Task 2 with a file larger than the tail window.
3. Project names with accents/spaces/`:` produce valid note and launcher filenames — test in Task 5.
4. Projects with no sessions and no git still render with "—" placeholders, not "undefined" — test in Task 5.
5. A malformed JSON line in a session file is skipped, not fatal — test in Task 2.

---

### Task 1: Scanner — creative projects, metadata-only roots, latest entry

**Files:**
- Modify: `src/discovery/evidence.js`, `src/discovery/scanner.js`, `src/config/loadConfig.js`
- Test: `test/cerebro-scanner.test.js`

**Interfaces:**
- Produces: `STRONG_EVIDENCE_EXTENSIONS` gains `.song .als .flp .cpr .ptx .rpp .prproj .aep .psd .ai .blend .kra .fig` (30 each); new `MEDIA_EXTENSIONS` set (audio/video/image/doc: `.wav .mp3 .flac .aif .aiff .ogg .m4a .mp4 .mov .mkv .avi .jpg .jpeg .png .tif .tiff .raw .cr2 .nef .pdf .docx .xlsx .pptx .txt`); `scoreDirectory` adds `{name:'media', weight:10, tier:'secondary'}` when ≥10 top-level media files.
- Produces: project record fields `latest_entry: {name: string, mtime: ISOString} | null`, `kind: 'code'|'music'|'video'|'design'|'docs'|'media'|'other'`, `metadata_only: boolean`.
- Produces: config `metadataOnlyRoots: string[]` (default `[]`) and `cerebro: { archiveDays: 365, nightlyTime: '03:00', suggestCommand: null }`.

- [ ] Step 1: Tests: `scoreDirectory` gives ≥30 for a dir with `mix.song`; ≥10 for 10 `.wav` files; `runScan` on a temp tree records `latest_entry.name` = most recently touched entry and `kind:'music'`; a project under a `metadataOnlyRoots` path has `metadata_only:true` and the markdown/aum/git inspectors are not invoked (assert by placing an unreadable-if-opened marker: a `README.md` whose title must NOT appear in sources).
- [ ] Step 2: Run, expect FAIL.
- [ ] Step 3: Implement. `computeFingerprint` also returns the max-mtime entry name; kind derived from evidence (DAW ext → music, `.prproj/.aep` → video, `.psd/.ai/.blend/.kra/.fig` → design, manifests/.git → code, media majority → media/docs).
- [ ] Step 4: Run, expect PASS. Also run `test/discovery.test.js test/evidence*.test.js test/incremental.test.js` — no new failures.
- [ ] Step 5: Commit `feat(scan): creative projects, metadata-only roots, latest entry`.

### Task 2: Agent session index

**Files:**
- Create: `src/sessions/tail.js`, `src/sessions/codex.js`, `src/sessions/claude.js`, `src/sessions/hermes.js`, `src/sessions/index.js`
- Test: `test/cerebro-sessions.test.js` (fixtures written to temp dirs)

**Interfaces:**
- Produces: `type AgentSessionRecord = { agent: 'codex'|'claude'|'hermes', session_id: string, cwd: string|null, updated_at: ISOString, last_message: string|null, file: string }`
- Produces: `readTailLines(file, maxBytes = 262144): string[]` (complete lines from the tail only).
- Produces: `readCodexSession(file): AgentSessionRecord|null` — first line `type:'session_meta'` gives `payload.id`, `payload.cwd`; last assistant text from tail lines (`response_item` with `payload.role==='assistant'` content `output_text`, or `event_msg` `agent_message`).
- Produces: `readClaudeSession(file): AgentSessionRecord|null` — lines with `sessionId`, `cwd`; last `type:'assistant'` `message.content[].text`.
- Produces: `readHermesSessions(hermesHome): AgentSessionRecord[]` — best-effort: if `state.db` exists and `node:sqlite` loads, read most recent 200 sessions; otherwise `[]`. Never throws.
- Produces: `indexSessions({ codexHome, claudeHome, hermesHome, cachePath }): Promise<AgentSessionRecord[]>` — walks `codexHome/sessions/**/*.jsonl` and `claudeHome/projects/*/*.jsonl`, reuses cache entries whose file mtime+size are unchanged.
- Produces: `mapSessionsToProjects(sessions, projects): Map<projectId, AgentSessionRecord[]>` sorted newest first; longest `root_path` prefix wins, case-insensitive, `\`/`/` agnostic (reuse `isUnderRoot` from scanner).

- [ ] Step 1: Tests: codex fixture → id/cwd/last message; claude fixture → same; 600-char trim; malformed line skipped; 1 MB file with meta in first line still parsed (head read for meta, tail for message); cache reuse (second call doesn't re-read — assert via mtime-unchanged + modified content ignored); mapping picks `D:\a\b` over `D:\a` for cwd `d:/a/b/c`.
- [ ] Step 2: FAIL. Step 3: implement. Step 4: PASS.
- [ ] Step 5: Commit `feat(sessions): index Codex/Claude/Hermes sessions by project`.

### Task 3: Resume launchers

**Files:**
- Create: `src/cerebro/launchers.js`
- Test: `test/cerebro-launchers.test.js`

**Interfaces:**
- Produces: `resumeCommand(session): string|null` — codex → `codex resume <id>`, claude → `claude --resume <id>`, hermes → `hermes --resume <id>`; null if id/cwd fail Global Constraints.
- Produces: `writeLauncher(vaultPath, session): string|null` — writes `<vault>/_retomar/<agent>-<id>.cmd` (`@echo off`, `cd /d "<cwd>"`, command, CRLF line endings), returns `file:///` URL (forward slashes, spaces as `%20`); idempotent.

- [ ] Steps: tests for each agent, unsafe cwd → null and no file, URL encoding; FAIL → implement → PASS → commit `feat(cerebro): resume launchers`.

### Task 4: Universal summary, archive flag, duplicates

**Files:**
- Create: `src/cerebro/summary.js`, `src/cerebro/duplicates.js`
- Test: `test/cerebro-summary.test.js`

**Interfaces:**
- Produces: `readInbox(vaultPath, projectName): string|null` — `<vault>/Caixa de entrada/<safeName>.md` contents (max 4 KB).
- Produces: `buildUniversalSummary({ project, intelligence, lastSession, inbox }): string[]` — 3–6 lines: what (first README title / name + kind), where it stopped (inbox → last session message → current_focus), next step (first next_steps item), each omitted if unknown.
- Produces: `lastActivityIso(project, sessions): string|null` — max of latest_entry.mtime, last_git_activity, last_file_activity, newest session.
- Produces: `isArchived(lastIso, nowMs, archiveDays): boolean`.
- Produces: `findDuplicateGroups(projects): Array<{ key: string, projects: Project[] }>` — normalize name: lowercase, strip accents, remove `(\d+)`, `- cópia|copia|copy`, `final`, `v\d+`, `old|backup|bkp`, non-alphanumerics; groups of ≥2 with different root paths.

- [ ] Steps: tests (`"Mix Master (1)"` ≡ `"mix master - cópia"`; archive at 366 days true / 364 false; summary prefers inbox over session); FAIL → implement → PASS → commit `feat(cerebro): universal summary, archive flag, duplicates`.

### Task 5: Portuguese vault renderer

**Files:**
- Modify (rewrite): `src/obsidian/renderer.js`; update `test/obsidian-renderer.test.js`
- Modify: `src/cli/commands/obsidian.js` (render gathers sessions via Task 2 and passes them)

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces: `renderObsidianDashboard({ vaultPath, projects, runtimeStates, intelligence, sessionsByProject = new Map(), roots = [], now = Date.now(), archiveDays = 365 })` → `{ root, changed, projectsRendered }`. Root stays `<vault>/Project Guardian`.
- Output files: `Painel.md` (sections **Em andamento** ≤7 days, **Dá pra retomar** 7–90 days with ▶ link, **Parados há mais tempo** >90 days not archived, **Concluídos** (completion_state DONE), **Arquivo — não mexer**), `Mapa.md` (root → first-level area → project links), `Duplicados.md`, `Projetos/<name>.md`. Each project note starts with YAML frontmatter (`status`, `tipo`, `area`, `ultima_mudanca`, `ultimo_arquivo`, `ultima_ia`, `ultima_ia_em`, `arquivo`, `caminho`) and the sections from the spec (Resumo universal, Última IA with ▶ Retomar link + up to 5 older sessions, Próximos passos, Bloqueios, Relacionados = same family/duplicate group, Minhas notas preserved). Keep the START/END generated-block preservation; frontmatter lives inside a separate generated block at the very top (`writePreserving` handles both).
- Old `Dashboard.md` / `Projects/` are left untouched (no deletes).

- [ ] Steps: tests for each section placement, frontmatter keys, manual notes preserved, Review Focus 3 and 4; FAIL → implement → PASS → commit `feat(obsidian): Portuguese Cérebro vault`.

### Task 6: Nightly run + suggestions

**Files:**
- Create: `src/cerebro/suggest.js`, `src/cli/commands/cerebro.js`; Modify: `src/cli/index.js`, `src/cli/commands/observe.js`
- Test: `test/cerebro-suggest.test.js`

**Interfaces:**
- Produces: `buildInventoryDigest(projects, sessionsByProject, duplicates): string` (≤ 60 KB; one line per project: name | kind | status | last change | last AI | path).
- Produces: `runSuggestions({ command, digest, outPath, spawnImpl = spawn })` — runs `command` (string, e.g. `codex exec -`) with a fixed Portuguese prompt + digest on stdin, 15-minute timeout, writes stdout to `<vault>/Project Guardian/Sugestões.md` inside a generated block. Prompt tells the AI to list: unir, descartar, problemas, retomar primeiro — and to only suggest, never act.
- CLI: `guardian cerebro nightly` = scan + render + suggestions (if `cerebro.suggestCommand`); `guardian cerebro rule <install|remove>` = Task 7.
- observe.js: second `startMaintenanceScheduler({ times: [config.cerebro.nightlyTime], run: nightly })`.

- [ ] Steps: test digest shape and that runSuggestions writes the file from a fake spawn; FAIL → implement → PASS → commit `feat(cerebro): nightly suggestions`.

### Task 7: Agent rule block + docs + version

**Files:**
- Create: `src/cerebro/rule.js`; Modify: `PRIVACY.md`, `README.md`, `guardian.config.example.json`, `package.json` (1.1.0)
- Test: `test/cerebro-rule.test.js`

**Interfaces:**
- Produces: `installRule(file, vaultPath)` / `removeRule(file)` — idempotent marked block (`<!-- >>> CEREBRO >>> -->` … `<!-- <<< CEREBRO <<< -->`) in `~/.codex/AGENTS.md` and `~/.claude/CLAUDE.md`, text (pt-BR): ao terminar uma tarefa num projeto, escreva 3–5 linhas (o que foi feito, onde parou, próximo passo) em `<vault>\Caixa de entrada\<nome da pasta do projeto>.md`, acrescentando no fim com data; não escreva nada dentro da pasta do projeto por causa disso.

- [ ] Steps: tests install twice → one block, remove restores original; FAIL → implement → PASS; docs (PRIVACY: last assistant message stored locally); commit `feat(cerebro): agent rule, docs, v1.1.0`.

### Task 8: Install on the PC (Remote Control session)

- [ ] Create vault `D:\CEREBRO` (with `.obsidian`), `guardian obsidian configure D:\CEREBRO`.
- [ ] `guardian.config.json`: add `F:\` and `G:\Meu Drive` to `scanRoots`, `G:\Meu Drive` to `metadataOnlyRoots`, `Downloads` to `exclude`, `cerebro.suggestCommand: "codex exec -"`. Back up the config first.
- [ ] Install branch build (`npm install -g <tarball>`), `guardian service restart`, `guardian cerebro nightly` once, `guardian cerebro rule install`.
- [ ] Verify: `Painel.md` exists, a known Codex project shows "Última IA: Codex" with a working ▶ link; Drive files untouched (no hydration).
