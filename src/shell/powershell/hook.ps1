# Guardian Shell Hook v1
#
# PROJECT GUARDIAN — PowerShell context hook (V0.5A). Dot-sourced from the user's profile via a
# small marker block (see src/shell/installer.js / profile-manager.js). Reports STRUCTURAL shell
# context only: SHELL_STARTED, CWD_CHANGED, SHELL_EXITING. Never reads command text, history,
# PSReadLine, clipboard, stdout, or stderr.
#
# FAIL OPEN: the entire body runs inside one outer try/catch. If anything here throws, or the
# Guardian pipe isn't available, PowerShell must keep working exactly as if this file didn't
# exist — no visible error, no retry storm, no perceptible prompt delay.

try {
    # Never run for non-interactive automation (CI, -NonInteractive scripts, batch jobs) — avoid
    # polluting Guardian with noise from scripted/automated shells.
    $nonInteractive = $false
    foreach ($arg in [Environment]::GetCommandLineArgs()) {
        if ($arg -match '^-NonI') { $nonInteractive = $true }
    }
    if ($nonInteractive -or -not [Environment]::UserInteractive) { return }

    # Guard against being dot-sourced twice in the same session (e.g. a user manually re-running
    # it) — never generate a second session id or double-register the exit handler.
    if ($global:ProjectGuardianShellHookLoaded) { return }
    $global:ProjectGuardianShellHookLoaded = $true

    $global:ProjectGuardianShellSessionId = [guid]::NewGuid().ToString()
    $global:ProjectGuardianLastCwd = $PWD.ProviderPath
    $global:ProjectGuardianPipeAvailable = $false
    $global:ProjectGuardianPipeStream = $null

    # Connect once, keep the connection open for the shell's lifetime. A short connect timeout
    # means "Guardian not running" costs at most ~50ms, exactly once, at shell startup — never
    # retried per-prompt.
    try {
        Add-Type -AssemblyName System.Core -ErrorAction SilentlyContinue
        $pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', 'guardian-shell', [System.IO.Pipes.PipeDirection]::Out)
        $pipe.Connect(50)
        $global:ProjectGuardianPipeStream = $pipe
        $global:ProjectGuardianPipeAvailable = $true
    } catch {
        $global:ProjectGuardianPipeAvailable = $false
    }

    function global:Send-ProjectGuardianEvent {
        param($EventObject)
        if (-not $global:ProjectGuardianPipeAvailable) { return }
        try {
            $json = $EventObject | ConvertTo-Json -Compress
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($json + "`n")
            $global:ProjectGuardianPipeStream.Write($bytes, 0, $bytes.Length)
            $global:ProjectGuardianPipeStream.Flush()
        } catch {
            # Pipe died mid-session (Guardian restarted/stopped) — disable silently, don't retry
            # every prompt render.
            $global:ProjectGuardianPipeAvailable = $false
        }
    }

    if ($global:ProjectGuardianPipeAvailable) {
        $parentPid = $null
        try { $parentPid = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -ErrorAction SilentlyContinue).ParentProcessId } catch {}

        Send-ProjectGuardianEvent @{
            type            = 'SHELL_STARTED'
            shell_session_id = $global:ProjectGuardianShellSessionId
            pid             = $PID
            parent_pid      = $parentPid
            shell_type      = $PSVersionTable.PSEdition
            shell_version   = $PSVersionTable.PSVersion.ToString()
            host_name       = $Host.Name
            cwd             = $PWD.ProviderPath
            timestamp       = (Get-Date).ToUniversalTime().ToString('o')
        }
    }

    # Preserve whatever `prompt` already is (default host prompt, or a custom one already
    # defined earlier in the profile) — see SPEC_V0.5A.md section 6. We only ever wrap it; we
    # never replace what it renders.
    # IMPORTANT: dereference .ScriptBlock into a plain variable RIGHT NOW, not the FunctionInfo
    # wrapper. A FunctionInfo from Get-Item function:\prompt is a live handle into the function
    # table, not a detached snapshot — if we kept the FunctionInfo and read .ScriptBlock lazily
    # from inside our own replacement `prompt` function below, that property would resolve to
    # OUR new scriptblock by the time it's read (since it re-reads the current "prompt" function
    # table entry), causing infinite self-recursion on every single prompt render.
    if (Test-Path function:\prompt) {
        $global:ProjectGuardianOriginalPrompt = (Get-Item function:\prompt).ScriptBlock
    } else {
        $global:ProjectGuardianOriginalPrompt = $null
    }

    function global:prompt {
        try {
            if ($global:ProjectGuardianPipeAvailable) {
                $cwd = $PWD.ProviderPath
                if ($cwd -ne $global:ProjectGuardianLastCwd) {
                    $global:ProjectGuardianLastCwd = $cwd
                    Send-ProjectGuardianEvent @{
                        type            = 'CWD_CHANGED'
                        shell_session_id = $global:ProjectGuardianShellSessionId
                        pid             = $PID
                        cwd             = $cwd
                        timestamp       = (Get-Date).ToUniversalTime().ToString('o')
                    }
                }
            }
        } catch {
            # Never let a hook failure break prompt rendering.
        }

        if ($global:ProjectGuardianOriginalPrompt) {
            & $global:ProjectGuardianOriginalPrompt
        } else {
            "PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($NestedPromptLevel + 1)) "
        }
    }

    # PowerShell.Exiting is corroborating evidence only — not reliable when the window/host is
    # killed or crashes (see SPEC_V0.5A.md section 9). The V0.4 process observer's own stop
    # detection is what actually closes out a shell whose exit event never arrives.
    Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action {
        try {
            if ($global:ProjectGuardianPipeAvailable) {
                Send-ProjectGuardianEvent @{
                    type            = 'SHELL_EXITING'
                    shell_session_id = $global:ProjectGuardianShellSessionId
                    pid             = $PID
                    timestamp       = (Get-Date).ToUniversalTime().ToString('o')
                }
            }
        } catch {}
    } | Out-Null
} catch {
    # Absolute fail-open: whatever went wrong, the shell must still work normally.
}
