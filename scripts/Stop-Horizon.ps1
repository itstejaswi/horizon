<#
.SYNOPSIS
    Stops the local website and unloads its Ollama model. Ollama itself is left running.

.EXAMPLE
    .\Stop-Horizon.ps1

.EXAMPLE
    .\Stop-Horizon.ps1 -ModelAlias qwen2.5:1.5b
#>
[CmdletBinding()]
param(
    [string] $ModelAlias
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'Common-Horizon.ps1')

$config = Get-HorizonConfig
$state = Get-HorizonRuntimeState -Config $config
if (-not $ModelAlias) {
    $ModelAlias = if ($state -and $state.modelAlias) { [string]$state.modelAlias } else { [string]$config.model.alias }
}
$ModelAlias = Assert-OllamaModelAlias -Alias $ModelAlias
$ollamaBase = if ($state -and $state.endpoint) {
    Assert-LoopbackEndpoint -Endpoint ([string]$state.endpoint)
} else {
    Get-OllamaBaseUrl -Config $config
}

Write-Host ""
Write-Host "Stopping $($config.app.displayName)" -ForegroundColor White
Write-Host ""

# The server releases the model it loaded during a graceful shutdown, so ask
# it to stop rather than killing the process mid-cleanup.
Write-HorizonStep 'Step 1 of 2: stopping the local website...'
if ($state -and $state.pid) {
    $process = Get-Process -Id $state.pid -ErrorAction SilentlyContinue
    if ($process -and $process.ProcessName -eq 'node') {
        $stopped = $false
        if ($state.url) {
            try {
                $webUrl = Assert-LoopbackEndpoint -Endpoint ([string]$state.url)
                Invoke-RestMethod -Uri "$webUrl/api/shutdown" -Method Post -TimeoutSec 10 | Out-Null
                for ($i = 0; $i -lt 50; $i++) {
                    Start-Sleep -Milliseconds 400
                    if (-not (Get-Process -Id $state.pid -ErrorAction SilentlyContinue)) { $stopped = $true; break }
                }
            } catch {
                Write-HorizonDetail "Graceful website shutdown was not confirmed: $($_.Exception.Message)"
            }
        }
        if (-not $stopped) {
            try {
                Stop-Process -Id $state.pid -ErrorAction Stop
                for ($i = 0; $i -lt 10; $i++) {
                    Start-Sleep -Milliseconds 500
                    if (-not (Get-Process -Id $state.pid -ErrorAction SilentlyContinue)) { $stopped = $true; break }
                }
            } catch {
                Write-Host "  Could not stop the website process: $($_.Exception.Message)" -ForegroundColor Yellow
            }
        }
        if (-not (Get-Process -Id $state.pid -ErrorAction SilentlyContinue)) { $stopped = $true }
        if ($stopped) {
            Write-HorizonOk "Website stopped (was running at $($state.url))."
            Remove-HorizonRuntimeState -Config $config
        } else {
            Write-Host "  The website process $($state.pid) is still running; its runtime state was retained for another stop attempt." -ForegroundColor Yellow
        }
    } else {
        Write-HorizonDetail 'The website was already stopped.'
        Remove-HorizonRuntimeState -Config $config
    }
} else {
    Write-HorizonDetail 'No running website was recorded. If a window is still open, press Ctrl+C in it.'
}

Write-HorizonStep "Step 2 of 2: unloading the Ollama model '$ModelAlias'..."
if (-not (Test-OllamaService -BaseUrl $ollamaBase)) {
    Write-HorizonDetail 'Ollama is not responding at the configured loopback endpoint; nothing was unloaded.'
} else {
    try {
        $loaded = @((Invoke-RestMethod -Uri "$ollamaBase/api/ps" -Method Get -TimeoutSec 10).models)
        $loadedName = Resolve-OllamaModel -Models $loaded -Alias $ModelAlias
        if (-not $loadedName) {
            Write-HorizonDetail "Model '$ModelAlias' is not currently loaded."
        } else {
            $body = @{ model = $loadedName; prompt = ''; stream = $false; keep_alive = 0 } | ConvertTo-Json -Depth 4
            Invoke-RestMethod -Uri "$ollamaBase/api/generate" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 120 | Out-Null
            Write-HorizonOk 'Model unloaded from memory.'
        }
    } catch {
        Write-Host "  Could not unload the model: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

Write-HorizonDetail 'Ollama is left running; stop it from its own application if you want to close the service.'
Write-Host ""
Write-HorizonOk 'Horizon has been shut down.'
Write-Host ""
