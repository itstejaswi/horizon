<#
.SYNOPSIS
    Health check. Confirms Ollama is reachable, the model answers, and the website is up.

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
Write-Host "$($config.app.displayName) health check" -ForegroundColor White
Write-Host ""

Write-HorizonStep 'Check 1 of 3: is Ollama reachable?'
if (-not (Test-OllamaService -BaseUrl $ollamaBase)) {
    throw "Ollama is not responding at $ollamaBase. Start Ollama, then run .\Start-Horizon.ps1."
}
$models = @(Get-OllamaModels -BaseUrl $ollamaBase -TimeoutSec 30)
$modelName = Resolve-OllamaModel -Models $models -Alias $ModelAlias
if (-not $modelName) {
    throw "Model '$ModelAlias' is not downloaded. Run .\Setup-Horizon.ps1 or use 'ollama pull $ModelAlias'."
}
Write-HorizonOk "Yes. Model available: $modelName"

Write-HorizonStep 'Check 2 of 3: does the model answer?'
$body = @{
    model    = $modelName
    messages = @(@{ role = 'user'; content = $Prompt })
    stream   = $false
} | ConvertTo-Json -Depth 6

$timeoutSec = [math]::Max(1, [int][math]::Ceiling($config.inference.requestTimeoutMs / 1000))
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$response = Invoke-RestMethod -Uri "$ollamaBase/api/chat" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec $timeoutSec
$stopwatch.Stop()
$answer = [string]$response.message.content
if (-not $answer) { throw 'Ollama returned no assistant text for the health-check prompt.' }

Write-HorizonOk "Yes. Replied in $([math]::Round($stopwatch.Elapsed.TotalSeconds, 1)) seconds:"
Write-Host "    $answer" -ForegroundColor White

Write-HorizonStep 'Check 3 of 3: is the website running?'
if ($state -and $state.url) {
    try {
        $webUrl = Assert-LoopbackEndpoint -Endpoint ([string]$state.url)
        $status = Invoke-RestMethod -Uri "$webUrl/api/status" -Method Get -TimeoutSec 10
        if ($status.ready) { Write-HorizonOk "Yes. Open $webUrl in your browser." }
        else { Write-Host "  The website is up but reports: $($status.error)" -ForegroundColor Yellow }
    } catch {
        Write-Host "  The website is not responding: $($_.Exception.Message) Run .\Start-Horizon.ps1." -ForegroundColor Yellow
    }
} else {
    Write-HorizonDetail 'Not running. That is fine, Ollama itself works. Run .\Start-Horizon.ps1 to use the chat page.'
}

Write-Host ""
Write-HorizonOk 'Health check finished.'
Write-Host ""
