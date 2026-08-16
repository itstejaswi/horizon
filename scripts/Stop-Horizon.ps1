<#
.SYNOPSIS
    Stops the local website, unloads the model, and stops the Foundry Local service.

.EXAMPLE
    .\Stop-Horizon.ps1

.EXAMPLE
    .\Stop-Horizon.ps1 -KeepService
#>
[CmdletBinding()]
param(
    [string] $ModelAlias,
    [switch] $KeepService
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'Common-Horizon.ps1')

$config = Get-HorizonConfig
if (-not $ModelAlias) { $ModelAlias = $config.model.alias }

Write-Host ""
Write-Host "Stopping $($config.app.displayName)" -ForegroundColor White
Write-Host ""

# The server releases the model it loaded during a graceful shutdown, so ask
# it to stop rather than killing the process mid-cleanup.
Write-HorizonStep 'Step 1 of 3: stopping the local website...'
$state = Get-HorizonRuntimeState -Config $config
if ($state -and $state.pid) {
    $process = Get-Process -Id $state.pid -ErrorAction SilentlyContinue
    if ($process -and $process.ProcessName -eq 'node') {
        $stopped = $false
        if ($state.url) {
            try {
                Invoke-RestMethod -Uri "$($state.url)/api/shutdown" -Method Post -TimeoutSec 10 | Out-Null
                for ($i = 0; $i -lt 50; $i++) {
                    Start-Sleep -Milliseconds 400
                    if (-not (Get-Process -Id $state.pid -ErrorAction SilentlyContinue)) { $stopped = $true; break }
                }
            } catch {
                # Fall through to stopping it directly.
            }
        }
        if (-not $stopped) {
            Stop-Process -Id $state.pid -ErrorAction SilentlyContinue
            Write-HorizonDetail 'The website did not shut down cleanly, so it was stopped directly.'
        }
        Write-HorizonOk "Website stopped (was running at $($state.url))."
    } else {
        Write-HorizonDetail 'The website was already stopped.'
    }
    Remove-HorizonRuntimeState -Config $config
} else {
    Write-HorizonDetail 'No running website was recorded. If a window is still open, press Ctrl+C in it.'
}

Write-HorizonStep "Step 2 of 3: unloading the model '$ModelAlias'..."
if (Get-Command foundry -ErrorAction SilentlyContinue) {
    foundry model unload $ModelAlias
    Write-HorizonOk 'Model unloaded from memory.'
} else {
    Write-HorizonDetail 'The foundry command is not available, so nothing to unload.'
}

Write-HorizonStep 'Step 3 of 3: stopping the Foundry service...'
if ($KeepService) {
    Write-HorizonDetail 'Left running because -KeepService was specified.'
} elseif (Get-Command foundry -ErrorAction SilentlyContinue) {
    foundry server stop
    Write-HorizonOk 'Foundry service stopped.'
}

Write-Host ""
Write-HorizonOk 'Everything is shut down.'
Write-Host ""
