<#
.SYNOPSIS
    Health check. Confirms Foundry Local is reachable, the model answers, and the website is up.

.EXAMPLE
    .\Test-Horizon.ps1

.EXAMPLE
    .\Test-Horizon.ps1 -Prompt "Explain what you are in one sentence."
#>
[CmdletBinding()]
param(
    [string] $Prompt = 'Reply with exactly: the local model is working.',
    [string] $ModelAlias
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common-Horizon.ps1')

$config = Get-HorizonConfig
if (-not $ModelAlias) { $ModelAlias = $config.model.alias }

Write-Host ""
Write-Host "$($config.app.displayName) health check" -ForegroundColor White
Write-Host ""

# Prefer the endpoint recorded by a running server; fall back to asking Foundry.
$state = Get-HorizonRuntimeState -Config $config
if ($state -and $state.endpoint) {
    $apiBase = $state.endpoint
    Write-HorizonDetail 'Using the endpoint recorded by the running website.'
} else {
    $endpoint = Get-FoundryEndpoint
    if (-not $endpoint) { throw 'The Foundry service is not running. Run .\Start-Horizon.ps1 first.' }
    $apiBase = Get-FoundryApiBase -Endpoint (Assert-LoopbackEndpoint -Endpoint $endpoint) -ApiPrefix $config.foundry.apiPrefix
}

Write-HorizonStep 'Check 1 of 3: is Foundry reachable?'
$modelId = Resolve-FoundryModel -ApiBase $apiBase -Alias $ModelAlias
Write-HorizonOk "Yes. Model loaded: $modelId"

Write-HorizonStep 'Check 2 of 3: does the model answer?'
$body = @{
    model    = $modelId
    messages = @(@{ role = 'user'; content = $Prompt })
    stream   = $false
} | ConvertTo-Json -Depth 6

$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$response = Invoke-RestMethod -Uri "$apiBase/chat/completions" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec ([int]($config.foundry.requestTimeoutMs / 1000))
$stopwatch.Stop()

Write-HorizonOk "Yes. Replied in $([math]::Round($stopwatch.Elapsed.TotalSeconds, 1)) seconds:"
Write-Host "    $($response.choices[0].message.content)" -ForegroundColor White

Write-HorizonStep 'Check 3 of 3: is the website running?'
if ($state -and $state.url) {
    try {
        $status = Invoke-RestMethod -Uri "$($state.url)/api/status" -Method Get -TimeoutSec 10
        if ($status.ready) { Write-HorizonOk "Yes. Open $($state.url) in your browser." }
        else { Write-Host "  The website is up but reports: $($status.error)" -ForegroundColor Yellow }
    } catch {
        Write-Host '  The website is not responding. Run .\Start-Horizon.ps1.' -ForegroundColor Yellow
    }
} else {
    Write-HorizonDetail 'Not running. That is fine, Foundry itself works. Run .\Start-Horizon.ps1 to use the chat page.'
}

Write-Host ""
Write-HorizonOk 'Health check finished.'
Write-Host ""
