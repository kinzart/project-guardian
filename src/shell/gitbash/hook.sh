# Guardian Git Bash Hook v1
#
# PROJECT GUARDIAN — Git Bash context hook (V0.5B). Sourced from a small marker block in
# ~/.bashrc and/or ~/.bash_profile (see src/shell/gitbash/bash-manager.js — both files are
# installed into since git-bash.exe's real invocation, `bash --login -i`, only sources
# .bash_profile, while some other "Git Bash" terminal integrations invoke plain `bash -i`, which
# only sources .bashrc — confirmed empirically on this machine, see SPEC_V0.5B.md section 1).
#
# Reports STRUCTURAL shell context only: SHELL_STARTED, CWD_CHANGED, SHELL_EXITING. Never reads
# command text, history, or stdin/stdout/stderr content. FAIL OPEN: every meaningful step is
# guarded so a failure here can never break the shell — no visible error, no hang, no retry storm.
#
# Transport: bash has no native way to talk to a Windows named pipe (what the PowerShell hook
# uses), but it DOES have a builtin `/dev/tcp/<host>/<port>` redirection that connects (or fails)
# instantly with zero subprocess — so this hook talks to a Guardian-owned TCP loopback listener
# instead (see src/shell/ipc-server.js's tcpPort — same schema/validation/session-store on the
# other end, just a second local-only transport). Never binds/listens itself, only connects out.

# Never run for non-interactive shells (scripts, CI, batch automation) or if already loaded.
case "$-" in
  *i*) ;;
  *) return 2>/dev/null || exit 0 ;;
esac
if [ -n "$PROJECT_GUARDIAN_BASH_HOOK_LOADED" ]; then return 2>/dev/null || exit 0; fi
export PROJECT_GUARDIAN_BASH_HOOK_LOADED=1

PROJECT_GUARDIAN_AVAILABLE=0
PROJECT_GUARDIAN_LAST_CWD=""
PROJECT_GUARDIAN_TCP_PORT=47814

__guardian_json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}

__guardian_now() {
  date -u +"%Y-%m-%dT%H:%M:%S.%3NZ" 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ"
}

__guardian_cwd_now() {
  # pwd -W (MSYS extension) gives a genuine Windows path directly ("D:/PROJECT-GUARDIAN"). The
  # server normalizes this (and, defensively, a raw POSIX path too) — see
  # src/shell/gitbash/path-normalizer.js. No conversion needed here at all.
  pwd -W 2>/dev/null || pwd
}

{
  if command -v uuidgen >/dev/null 2>&1; then
    PROJECT_GUARDIAN_SESSION_ID="$(uuidgen)"
  else
    PROJECT_GUARDIAN_SESSION_ID="$(date +%s%N 2>/dev/null || date +%s)-$$-${RANDOM}${RANDOM}"
  fi

  # CRITICAL: bash's own $$/PPID are Cygwin/MSYS-internal process ids, NOT the real Windows PIDs
  # the V0.4 process observer tracks (it only ever sees WMI/Win32 PIDs) — confirmed empirically on
  # this machine that they differ. /proc/<pid>/winpid is Cygwin's own translation file; reading it
  # once at load and caching the result is what makes "shell/process PID matching" (SPEC_V0.5B.md
  # section 8) actually work. Falls back to the raw (possibly-wrong-space) pid if unavailable —
  # correlation would then just miss for this shell rather than break anything.
  # NOTE: deliberately /proc/$$/winpid, not /proc/self/winpid — "self" inside a $(...) command
  # substitution resolves to that transient forked subshell, not the persistent interactive
  # shell, and would report a pid that's already gone by the time Guardian checks it. $$ is
  # special-cased by bash to keep referring to the original shell even inside a substitution.
  PROJECT_GUARDIAN_WINPID="$(cat "/proc/$$/winpid" 2>/dev/null)"
  [ -n "$PROJECT_GUARDIAN_WINPID" ] || PROJECT_GUARDIAN_WINPID="$$"
  PROJECT_GUARDIAN_PARENT_WINPID="$(cat "/proc/$PPID/winpid" 2>/dev/null)"
  [ -n "$PROJECT_GUARDIAN_PARENT_WINPID" ] || PROJECT_GUARDIAN_PARENT_WINPID="$PPID"

  # A refused/unreachable connection fails immediately (loopback TCP never hangs the way a
  # network connection could) — one bounded attempt, never retried later. The bash diagnostic
  # this can print on failure ("Connection refused") comes from the redirection setup itself, so
  # only redirecting stderr on the exec line doesn't catch it — wrapping the whole thing in a
  # group and redirecting the GROUP's stderr does.
  { exec {PROJECT_GUARDIAN_FD}<>"/dev/tcp/127.0.0.1/$PROJECT_GUARDIAN_TCP_PORT"; } 2>/dev/null
  if [ -n "$PROJECT_GUARDIAN_FD" ]; then
    PROJECT_GUARDIAN_AVAILABLE=1
  fi
} 2>/dev/null

if [ "$PROJECT_GUARDIAN_AVAILABLE" = "1" ]; then
  {
    __guardian_cwd="$(__guardian_cwd_now)"
    PROJECT_GUARDIAN_LAST_CWD="$__guardian_cwd"
    printf '{"type":"SHELL_STARTED","shell_session_id":"%s","pid":%d,"parent_pid":%s,"shell_type":"bash","shell_version":"%s","host_name":"%s","cwd":"%s","timestamp":"%s"}\n' \
      "$(__guardian_json_escape "$PROJECT_GUARDIAN_SESSION_ID")" \
      "$PROJECT_GUARDIAN_WINPID" \
      "$PROJECT_GUARDIAN_PARENT_WINPID" \
      "$(__guardian_json_escape "$BASH_VERSION")" \
      "$(__guardian_json_escape "${MSYSTEM:-bash}")" \
      "$(__guardian_json_escape "$__guardian_cwd")" \
      "$(__guardian_now)" >&"$PROJECT_GUARDIAN_FD" 2>/dev/null || PROJECT_GUARDIAN_AVAILABLE=0
    unset __guardian_cwd
  } 2>/dev/null
fi

__guardian_prompt_command() {
  { # never let a failure here affect prompt rendering
    if [ "$PROJECT_GUARDIAN_AVAILABLE" = "1" ]; then
      local cwd
      cwd="$(__guardian_cwd_now)"
      if [ "$cwd" != "$PROJECT_GUARDIAN_LAST_CWD" ]; then
        PROJECT_GUARDIAN_LAST_CWD="$cwd"
        printf '{"type":"CWD_CHANGED","shell_session_id":"%s","pid":%d,"cwd":"%s","timestamp":"%s"}\n' \
          "$(__guardian_json_escape "$PROJECT_GUARDIAN_SESSION_ID")" \
          "$PROJECT_GUARDIAN_WINPID" \
          "$(__guardian_json_escape "$cwd")" \
          "$(__guardian_now)" >&"$PROJECT_GUARDIAN_FD" 2>/dev/null || PROJECT_GUARDIAN_AVAILABLE=0
      fi
    fi
  } 2>/dev/null
}

# Never overwrite an existing PROMPT_COMMAND — prepend, keep whatever was already there (a
# user's own, or one set by a prompt theme like Starship/Oh My Posh loaded earlier in the
# profile). PS1 itself is never touched by this hook at all.
if [ -n "$PROMPT_COMMAND" ]; then
  PROMPT_COMMAND="__guardian_prompt_command; $PROMPT_COMMAND"
else
  PROMPT_COMMAND="__guardian_prompt_command"
fi

__guardian_shell_exiting() {
  { # bash's closest equivalent to PowerShell.Exiting — same reliability caveat: not fired on a
    # killed window or a crash; the V0.4 process observer's own stop detection reconciles those.
    if [ "$PROJECT_GUARDIAN_AVAILABLE" = "1" ]; then
      printf '{"type":"SHELL_EXITING","shell_session_id":"%s","pid":%d,"timestamp":"%s"}\n' \
        "$(__guardian_json_escape "$PROJECT_GUARDIAN_SESSION_ID")" \
        "$PROJECT_GUARDIAN_WINPID" \
        "$(__guardian_now)" >&"$PROJECT_GUARDIAN_FD" 2>/dev/null
      exec {PROJECT_GUARDIAN_FD}>&- 2>/dev/null
    fi
  } 2>/dev/null
}
trap __guardian_shell_exiting EXIT
