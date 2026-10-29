<#
.SYNOPSIS
    One-time setup: checks prerequisites and downloads the configured Ollama model.

.EXAMPLE
    .\Setup-Horizon.ps1

.EXAMPLE
    .\Setup-Horizon.ps1 -ModelAlias qwen2.5:0.5b
#>
[CmdletBinding()]
param(
    [string] $ModelAlias
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common-Horizon.ps1')

$config = Get-HorizonConfig
if (-not $ModelAlias) { $ModelAlias = $config.model.alias }
$ModelAlias = Assert-OllamaModelAlias -Alias $ModelAlias
$ollamaBase = Get-OllamaBaseUrl -Config $config

Write-Host ""
Write-Host "$($config.app.displayName) setup" -ForegroundColor White
Write-Host "  This runs once. It needs internet access and may take a while." -ForegroundColor DarkGray
Write-Host ""

Write-HorizonStep 'Step 1 of 4: checking Node.js...'
Assert-HorizonPrerequisite -Command 'node' -Guidance 'Install Node.js 20 or later (a supported LTS is recommended) from an approved source, then run this script again.'
$nodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) {
    throw "Node.js 20 or later is required by the local LangGraph runtime, but $(node --version) was found. Update Node.js and run this script again."
}
Write-HorizonOk "Node.js $(node --version) found."

Write-HorizonStep 'Step 2 of 4: checking Ollama installation...'
$ollamaCommand = Get-Command ollama -CommandType Application -ErrorAction SilentlyContinue
if (-not $ollamaCommand -and -not (Test-OllamaService -BaseUrl $ollamaBase)) {
    throw "Ollama is not installed or running. Install it from https://ollama.com/download, then rerun this script."
}
if ($ollamaCommand) { Write-HorizonOk 'Ollama command found.' }

Write-HorizonStep 'Step 3 of 4: checking the Ollama service...'
if (-not (Start-HorizonOllamaService -BaseUrl $ollamaBase)) {
    throw "Ollama could not be started at $ollamaBase. Start Ollama and rerun this script."
}
Write-HorizonOk "Ollama is responding at $ollamaBase."

Write-HorizonStep "Step 4 of 4: preparing model '$ModelAlias'..."
$installed = @(Get-OllamaModels -BaseUrl $ollamaBase)
$installedName = Resolve-OllamaModel -Models $installed -Alias $ModelAlias
if ($installedName) {
    Write-HorizonOk "Model '$installedName' is already downloaded."
} else {
    Write-HorizonDetail 'The model is not downloaded. Starting the Ollama model pull...'
    $body = @{ model = $ModelAlias; stream = $false } | ConvertTo-Json -Depth 4
    Invoke-RestMethod -Uri "$ollamaBase/api/pull" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 3600 | Out-Null
    Write-HorizonOk "Model '$ModelAlias' downloaded."
}

Write-Host ""
Write-HorizonOk 'Setup completed.'
Write-Host "  Next step: run .\Start-Horizon.ps1" -ForegroundColor White
Write-Host ""
