<#
.SYNOPSIS
    Starts Horizon and, when possible, starts the local Ollama service.

.DESCRIPTION
    Horizon can run without Ollama so the page remains available for setup and
    troubleshooting. Any Ollama endpoint used by this script must be loopback.

.EXAMPLE
    .\Start-Horizon.ps1

.EXAMPLE
    .\Start-Horizon.ps1 -WebPort 3000

.EXAMPLE
    .\Start-Horizon.ps1 -ModelAlias qwen2.5:1.5b -NoBrowser
#>
[CmdletBinding()]
param(
    [ValidateRange(0, 65535)]
    [int] $WebPort = -1,
    [string] $ModelAlias,
    [switch] $NoBrowser,
    [switch] $SkipModelLoad
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common-Horizon.ps1')

$config = Get-HorizonConfig
if (-not $ModelAlias) { $ModelAlias = $config.model.alias }
$ModelAlias = Assert-OllamaModelAlias -Alias $ModelAlias
if ($WebPort -lt 0) { $WebPort = [int]$config.web.port }
$ollamaBase = Get-OllamaBaseUrl -Config $config

Write-Host ""
Write-Host "Starting $($config.app.displayName)" -ForegroundColor White
Write-Host ""

Write-HorizonStep 'Step 1 of 4: checking Node.js...'
Assert-HorizonPrerequisite -Command 'node' -Guidance 'Install Node.js 20 or later (a supported LTS is recommended), then try again.'
$nodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) {
    throw "Node.js 20 or later is required by the local LangGraph runtime, but $(node --version) was found."
}
Write-HorizonOk "Node.js $(node --version)"

& node (Join-Path $config.rootDir 'tools\setup-agent-runtime.js') --check
if ($LASTEXITCODE -ne 0) {
    Push-Location $config.rootDir
    try {
        & npm.cmd install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Horizon dependency setup failed. Check the error above and retry.' }
        & node (Join-Path $config.rootDir 'tools\setup-agent-runtime.js')
        if ($LASTEXITCODE -ne 0) { throw 'Horizon browser setup failed. Check the error above and retry.' }
    } finally {
        Pop-Location
    }
}

Write-HorizonStep 'Step 2 of 4: checking Ollama...'
$ollamaAvailable = Test-OllamaService -BaseUrl $ollamaBase
$ollamaStartError = $null
if (-not $ollamaAvailable) {
    if (Get-Command ollama -CommandType Application -ErrorAction SilentlyContinue) {
        Write-HorizonDetail 'The service is not running. Starting it...'
        try {
            $ollamaAvailable = Start-HorizonOllamaService -BaseUrl $ollamaBase
        } catch {
            $ollamaStartError = $_.Exception.Message
        }
    } else {
        Write-Host "  Ollama is not installed or running." -ForegroundColor Yellow
        Write-Host "  Horizon will still start. Install Ollama from https://ollama.com/download" -ForegroundColor Yellow
    }
}
if ($ollamaAvailable) {
    Write-HorizonOk "Ollama is listening at $ollamaBase"
} else {
    if ($ollamaStartError) { Write-Host "  Ollama startup error: $ollamaStartError" -ForegroundColor Yellow }
    Write-Host '  Ollama could not be started. Horizon will still start; retry from the Connection panel.' -ForegroundColor Yellow
}

Write-HorizonStep "Step 3 of 4: preparing '$ModelAlias'..."
if (-not $ollamaAvailable) {
    Write-HorizonDetail 'Skipped: Ollama is not available yet.'
} elseif ($SkipModelLoad) {
    Write-HorizonDetail 'Skipped at your request.'
} else {
    try {
        $installed = @(Get-OllamaModels -BaseUrl $ollamaBase -TimeoutSec 10)
        $installedName = Resolve-OllamaModel -Models $installed -Alias $ModelAlias
        if ($installedName) {
            Write-HorizonOk "Model '$installedName' is installed."
        } else {
            Write-Host "  '$ModelAlias' is not installed. Pull it with:" -ForegroundColor Yellow
            Write-Host "    ollama pull $ModelAlias" -ForegroundColor Yellow
            Write-Host '  You can also pick or download a model from the page.' -ForegroundColor Yellow
        }
    } catch {
        Write-Host "  Could not check the installed models: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

Write-HorizonStep 'Step 4 of 4: starting the local website...'

$env:HORIZON_PROVIDER = 'ollama'
$env:HORIZON_MODEL_ALIAS = $ModelAlias
$env:HORIZON_PORT = "$WebPort"
$env:HORIZON_OPEN_BROWSER = if ($NoBrowser) { 'false' } else { 'true' }

if ($WebPort -eq 0) {
    Write-HorizonDetail 'No fixed port was requested, so a free one will be chosen automatically.'
}

try {
    node (Join-Path $config.rootDir 'src\server.js')
} finally {
    Remove-HorizonRuntimeState -Config $config
    Write-Host ""
    Write-HorizonDetail 'Horizon has stopped.'
    Write-HorizonDetail 'Run .\Stop-Horizon.ps1 to unload the model and free its memory.'
    Write-Host ""
}
