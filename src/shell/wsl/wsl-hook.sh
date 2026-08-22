# Guardian WSL Hook v1
#
# PROJECT GUARDIAN — WSL context hook (V0.5C). Sourced from a small marker block in whichever
# startup file was empirically determined for this distro (see src/shell/wsl/manager.js's
# detectStartupFile — never assumed to be .bashrc). The startup block also exports
# PROJECT_GUARDIAN_REPO_DATA_WSL (the WSL-mounted path to this repo's data/ directory) before
# sourcing this file.
#
# Reports STRUCTURAL shell context only: SHELL_STARTED, CWD_CHANGED, SHELL_EXITING, and an
# occasional HEARTBEAT (see below). Never reads command text, history, BASH_COMMAND, stdin,
# stdout, stderr, or environment content. FAIL OPEN: every meaningful step is guarded so a
# failure here can never break the shell.
#
# CRITICAL: $$ here is a genuine, sole Linux PID — WSL2 processes are not Win32 processes and
# never appear in Win32_Process at all, so there is no "real Windows PID" to translate to (unlike
# the Cygwin/MSYS $$-vs-winpid split V0.5B had to handle). linux_pid is therefore never compared
# against or merged with any Windows PID (see SPEC_V0.5C.md section 2).

case "$-" in
  *i*) ;;
  *) return 2>/dev/null || exit 0 ;;
esac
if [ -n "$PROJECT_GUARDIAN_WSL_HOOK_LOADED" ]; then return 2>/dev/null || exit 0; fi
export PROJECT_GUARDIAN_WSL_HOOK_LOADED=1

PROJECT_GUARDIAN_AVAILABLE=0
PROJECT_GUARDIAN_LAST_CWD=""
PROJECT_GUARDIAN_WSL_PORT=47815
PROJECT_GUARDIAN_LAST_HEARTBEAT=0
PROJECT_GUARDIAN_HEARTBEAT_INTERVAL=60

__guardian_json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}

__guardian_now() {
  date -u +"%Y-%m-%dT%H:%M:%S.%3NZ" 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ"
}

# CASE A vs CASE B (SPEC_V0.5C.md section 5) — never assumes /mnt/: wslpath itself is the
# authoritative translator, and its success/failure IS the signal for which case applies.
__guardian_project_identity() {
  local winpath
  if winpath="$(wslpath -w "$PWD" 2>/dev/null)" && [ -n "$winpath" ]; then
    printf 'windows:%s' "$winpath"
  else
    printf 'wsl:%s:%s' "${WSL_DISTRO_NAME:-unknown}" "$PWD"
  fi
}

__guardian_wsl_version() {
  case "$(uname -r 2>/dev/null)" in
    *WSL2*|*microsoft-standard*) printf '2' ;;
    *[Mm]icrosoft*) printf '1' ;;
    *) printf 'unknown' ;;
  esac
}

{
  if command -v uuidgen >/dev/null 2>&1; then
    PROJECT_GUARDIAN_SESSION_ID="$(uuidgen)"
  else
    PROJECT_GUARDIAN_SESSION_ID="$(date +%s%N 2>/dev/null || date +%s)-$$-${RANDOM}${RANDOM}"
  fi

  __guardian_token=""
  if [ -n "$PROJECT_GUARDIAN_REPO_DATA_WSL" ] && [ -f "$PROJECT_GUARDIAN_REPO_DATA_WSL/wsl-auth.token" ]; then
    __guardian_token="$(cat "$PROJECT_GUARDIAN_REPO_DATA_WSL/wsl-auth.token" 2>/dev/null)"
  fi

  # Transport discovery (SPEC_V0.5C.md section 4) — never hardcodes one strategy. Tries loopback
  # first (WSL1, and WSL2 mirrored-networking mode both reach the Windows host via 127.0.0.1),
  # then falls back to the default-route gateway (the standard, documented way a WSL2-NAT session
  # reaches its host) — never touches .wslconfig to change this.
  if [ -n "$__guardian_token" ]; then
    { exec {PROJECT_GUARDIAN_FD}<>"/dev/tcp/127.0.0.1/$PROJECT_GUARDIAN_WSL_PORT"; } 2>/dev/null
    if [ -z "$PROJECT_GUARDIAN_FD" ]; then
      __guardian_gateway="$(ip route 2>/dev/null | awk '/^default/ {print $3; exit}')"
      if [ -n "$__guardian_gateway" ]; then
        { exec {PROJECT_GUARDIAN_FD}<>"/dev/tcp/$__guardian_gateway/$PROJECT_GUARDIAN_WSL_PORT"; } 2>/dev/null
      fi
      unset __guardian_gateway
    fi
    if [ -n "$PROJECT_GUARDIAN_FD" ]; then
      if printf '%s\n' "$__guardian_token" >&"$PROJECT_GUARDIAN_FD" 2>/dev/null; then
        PROJECT_GUARDIAN_AVAILABLE=1
      else
        exec {PROJECT_GUARDIAN_FD}>&- 2>/dev/null
      fi
    fi
  fi
  unset __guardian_token
} 2>/dev/null

if [ "$PROJECT_GUARDIAN_AVAILABLE" = "1" ]; then
  {
    __guardian_identity="$(__guardian_project_identity)"
    PROJECT_GUARDIAN_LAST_CWD="$PWD"
    printf '{"type":"SHELL_STARTED","shell_session_id":"%s","shell_type":"WSL_BASH","distro":"%s","wsl_version":"%s","linux_pid":%d,"linux_parent_pid":%s,"bash_version":"%s","cwd_linux":"%s","cwd_project_identity":"%s","timestamp":"%s"}\n' \
      "$(__guardian_json_escape "$PROJECT_GUARDIAN_SESSION_ID")" \
      "$(__guardian_json_escape "${WSL_DISTRO_NAME:-unknown}")" \
      "$(__guardian_wsl_version)" \
      "$$" \
      "${PPID:-null}" \
      "$(__guardian_json_escape "$BASH_VERSION")" \
      "$(__guardian_json_escape "$PWD")" \
      "$(__guardian_json_escape "$__guardian_identity")" \
      "$(__guardian_now)" >&"$PROJECT_GUARDIAN_FD" 2>/dev/null || PROJECT_GUARDIAN_AVAILABLE=0
    unset __guardian_identity
  } 2>/dev/null
fi

__guardian_prompt_command() {
  { # never let a failure here affect prompt rendering
    if [ "$PROJECT_GUARDIAN_AVAILABLE" = "1" ]; then
      if [ "$PWD" != "$PROJECT_GUARDIAN_LAST_CWD" ]; then
        PROJECT_GUARDIAN_LAST_CWD="$PWD"
        printf '{"type":"CWD_CHANGED","shell_session_id":"%s","distro":"%s","linux_pid":%d,"cwd_linux":"%s","cwd_project_identity":"%s","timestamp":"%s"}\n' \
          "$(__guardian_json_escape "$PROJECT_GUARDIAN_SESSION_ID")" \
          "$(__guardian_json_escape "${WSL_DISTRO_NAME:-unknown}")" \
          "$$" \
          "$(__guardian_json_escape "$PWD")" \
          "$(__guardian_json_escape "$(__guardian_project_identity)")" \
          "$(__guardian_now)" >&"$PROJECT_GUARDIAN_FD" 2>/dev/null || PROJECT_GUARDIAN_AVAILABLE=0
      else
        # Heartbeat, piggybacked on the SAME prompt-render hook point — never a new background
        # process, at most one per PROJECT_GUARDIAN_HEARTBEAT_INTERVAL seconds, never sent on
        # every prompt (SPEC_V0.5C.md section 7).
        local __guardian_now_epoch
        __guardian_now_epoch="$(date +%s 2>/dev/null || echo 0)"
        if [ $((__guardian_now_epoch - PROJECT_GUARDIAN_LAST_HEARTBEAT)) -ge "$PROJECT_GUARDIAN_HEARTBEAT_INTERVAL" ]; then
          PROJECT_GUARDIAN_LAST_HEARTBEAT=$__guardian_now_epoch
          printf '{"type":"HEARTBEAT","shell_session_id":"%s","linux_pid":%d,"timestamp":"%s"}\n' \
            "$(__guardian_json_escape "$PROJECT_GUARDIAN_SESSION_ID")" \
            "$$" \
            "$(__guardian_now)" >&"$PROJECT_GUARDIAN_FD" 2>/dev/null || PROJECT_GUARDIAN_AVAILABLE=0
        fi
      fi
    fi
  } 2>/dev/null
}

# Never overwrite an existing PROMPT_COMMAND — prepend, keep whatever was already there. PS1
# itself is never touched by this hook at all — same philosophy as V0.5B.
if [ -n "$PROMPT_COMMAND" ]; then
  PROMPT_COMMAND="__guardian_prompt_command; $PROMPT_COMMAND"
else
  PROMPT_COMMAND="__guardian_prompt_command"
fi

__guardian_shell_exiting() {
  { # Not reliable on a killed terminal, `wsl --shutdown`, or host sleep — the staleness sweep in
    # src/shell/wsl/observer.js is what actually reconciles those (the Windows process observer
    # has no visibility into this VM's processes at all to do it the V0.4 way).
    if [ "$PROJECT_GUARDIAN_AVAILABLE" = "1" ]; then
      printf '{"type":"SHELL_EXITING","shell_session_id":"%s","distro":"%s","linux_pid":%d,"timestamp":"%s"}\n' \
        "$(__guardian_json_escape "$PROJECT_GUARDIAN_SESSION_ID")" \
        "$(__guardian_json_escape "${WSL_DISTRO_NAME:-unknown}")" \
        "$$" \
        "$(__guardian_now)" >&"$PROJECT_GUARDIAN_FD" 2>/dev/null
      exec {PROJECT_GUARDIAN_FD}>&- 2>/dev/null
    fi
  } 2>/dev/null
}
trap __guardian_shell_exiting EXIT
