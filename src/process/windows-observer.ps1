# PROJECT GUARDIAN — Windows process observer helper (V0.4). Spawned as a child process by
# src/process/windows-adapter.js. Writes ONE JSON object per line to stdout for the one-time
# startup snapshot and for every subsequent process start/stop. Never reads or echoes any
# terminal/console content — only structured CIM instance fields (Name, ProcessId,
# ParentProcessId, CommandLine). See SPEC_V0.4.md section 4 for why this uses
# __InstanceCreationEvent/__InstanceDeletionEvent (standard user privilege) instead of
# Win32_ProcessStartTrace/StopTrace (requires Administrator — confirmed access-denied on a
# non-elevated session on this machine).

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

function Emit($obj) {
    $json = $obj | ConvertTo-Json -Compress -Depth 4
    Write-Output $json
}

function NowIso {
    (Get-Date).ToUniversalTime().ToString('o')
}

# One-time startup snapshot — not polling, a single Get-CimInstance call. CreationDate is real
# OS data (not invented) when available, so an already-running process still gets its true start
# time recorded; startTimeKnown = $false only for the rare case where CIM couldn't report it, and
# Node then leaves started_at null rather than inventing "now" as the start time.
try {
    Get-CimInstance Win32_Process | ForEach-Object {
        $creation = $null
        try { if ($_.CreationDate) { $creation = $_.CreationDate.ToUniversalTime().ToString('o') } } catch {}
        Emit @{
            type           = 'ALREADY_RUNNING'
            pid            = $_.ProcessId
            parentPid      = $_.ParentProcessId
            processName    = $_.Name
            executablePath = $_.ExecutablePath
            commandLine    = $_.CommandLine
            timestamp      = if ($creation) { $creation } else { NowIso }
            startTimeKnown = [bool]$creation
        }
    }
} catch {
    Emit @{ type = 'ADAPTER_ERROR'; message = "startup snapshot failed: $($_.Exception.Message)" }
}

try {
    Register-CimIndicationEvent -Query "SELECT * FROM __InstanceCreationEvent WITHIN 1 WHERE TargetInstance ISA 'Win32_Process'" -SourceIdentifier GuardianProcCreate -ErrorAction Stop | Out-Null
    Register-CimIndicationEvent -Query "SELECT * FROM __InstanceDeletionEvent WITHIN 1 WHERE TargetInstance ISA 'Win32_Process'" -SourceIdentifier GuardianProcDelete -ErrorAction Stop | Out-Null
} catch {
    Emit @{ type = 'ADAPTER_ERROR'; message = "event registration failed: $($_.Exception.Message)" }
    exit 1
}

Emit @{ type = 'ADAPTER_READY' }

try {
    while ($true) {
        $evt = Wait-Event -Timeout 2
        if ($null -eq $evt) { continue }
        $ti = $evt.SourceEventArgs.NewEvent.TargetInstance
        if ($evt.SourceIdentifier -eq 'GuardianProcCreate') {
            Emit @{
                type           = 'PROCESS_STARTED'
                pid            = $ti.ProcessId
                parentPid      = $ti.ParentProcessId
                processName    = $ti.Name
                executablePath = $ti.ExecutablePath
                commandLine    = $ti.CommandLine
                timestamp      = NowIso
            }
        } elseif ($evt.SourceIdentifier -eq 'GuardianProcDelete') {
            Emit @{
                type        = 'PROCESS_STOPPED'
                pid         = $ti.ProcessId
                parentPid   = $ti.ParentProcessId
                processName = $ti.Name
                timestamp   = NowIso
            }
        }
        Remove-Event -EventIdentifier $evt.EventIdentifier -ErrorAction SilentlyContinue
    }
} finally {
    Unregister-Event -SourceIdentifier GuardianProcCreate -ErrorAction SilentlyContinue
    Unregister-Event -SourceIdentifier GuardianProcDelete -ErrorAction SilentlyContinue
}
