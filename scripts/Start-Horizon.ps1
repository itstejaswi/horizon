<#
.SYNOPSIS
    Starts Horizon. The chosen model runtime (Foundry Local or Ollama) is started too if it is available.

.DESCRIPTION
    Horizon can run without Foundry: the page opens, and the Connection panel
    lets you install or start the service from there. This script does the same
    work up front when it can, so the first message is quick.

.EXAMPLE
    .\Start-Horizon.ps1

.EXAMPLE
    .\Start-Horizon.ps1 -WebPort 3000

.EXAMPLE
    .\Start-Horizon.ps1 -ModelAlias qwen2.5-1.5b -NoBrowser

.EXAMPLE
    .\Start-Horizon.ps1 -Provider ollama -ModelAlias llama3.2:3b
#>
[CmdletBinding()]
param(
    [ValidateRange(0, 65535)]
    [int] $WebPort = -1,
    [string] $ModelAlias,
    [ValidateSet('foundry', 'ollama')]
    [string] $Provider,
    [switch] $NoBrowser,
    [switch] $SkipModelLoad
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common-Horizon.ps1')

$config = Get-HorizonConfig
if (-not $Provider) {
    $Provider = if ($env:HORIZON_PROVIDER) { $env:HORIZON_PROVIDER }
        elseif ($config.PSObject.Properties.Name -contains 'provider') { $config.provider }
        else { 'foundry' }
}
$Provider = "$Provider".Trim().ToLowerInvariant()
if ($Provider -notin 'foundry', 'ollama') { throw "Unknown provider '$Provider'. Use 'foundry' or 'ollama'." }
if (-not $ModelAlias) {
    # The shipped default names a Foundry model, which Ollama would not know.
    $ModelAlias = if ($Provider -eq 'ollama') { 'llama3.2:3b' } else { $config.model.alias }
}
if ($WebPort -lt 0) { $WebPort = [int]$config.web.port }

Write-Host ""
Write-Host "Starting $($config.app.displayName)" -ForegroundColor White
Write-Host ""

# Node is the only hard requirement. Everything else can be sorted out from
# the page itself, so a missing Foundry is reported rather than fatal.
Write-HorizonStep 'Step 1 of 4: checking Node.js...'
Assert-HorizonPrerequisite -Command 'node' -Guidance 'Install Node.js 18 or later, then try again.'
$nodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 18) {
    throw "Node.js 18 or later is required, but $(node --version) was found."
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

$apiBase = $null
$modelId = $null

$ollamaBase = if ($config.PSObject.Properties.Name -contains 'ollama' -and $config.ollama.baseUrl) { "$($config.ollama.baseUrl)".TrimEnd('/') } else { 'http://127.0.0.1:11434' }
if ($env:HORIZON_OLLAMA_URL) { $ollamaBase = $env:HORIZON_OLLAMA_URL.TrimEnd('/') }

function Test-OllamaUp {
    try { Invoke-RestMethod -Uri "$ollamaBase/api/version" -TimeoutSec 2 | Out-Null; return $true } catch { return $false }
}

if ($Provider -eq 'ollama') {
    Write-HorizonStep 'Step 2 of 4: looking for Ollama...'
    if (-not (Get-Command ollama -ErrorAction SilentlyContinue) -and -not (Test-OllamaUp)) {
        Write-Host "  Ollama is not installed on this account." -ForegroundColor Yellow
        Write-Host "  Horizon will still start. Install it from https://ollama.com/download" -ForegroundColor Yellow
    } else {
        $loopback = ([uri]$ollamaBase).Host -in '127.0.0.1', 'localhost', '[::1]'
        if (-not $loopback) { throw "Refusing a non-loopback Ollama endpoint: $ollamaBase. This tool is local-only by design." }
        if (-not (Test-OllamaUp)) {
            Write-HorizonDetail 'The service is not running. Starting it...'
            $env:OLLAMA_HOST = ([uri]$ollamaBase).Authority
            Start-Process -FilePath 'ollama' -ArgumentList 'serve' -WindowStyle Hidden
            1..20 | ForEach-Object { if (-not (Test-OllamaUp)) { Start-Sleep -Milliseconds 500 } }
        }
        if (Test-OllamaUp) {
            Write-HorizonOk "Ollama is listening at $ollamaBase"
            $apiBase = "$ollamaBase/v1"
        } else {
            Write-Host "  Ollama could not be started. Retry from the Connection panel." -ForegroundColor Yellow
        }
    }
} elseif (-not (Get-Command foundry -ErrorAction SilentlyContinue)) {
    Write-HorizonStep 'Step 2 of 4: looking for Foundry Local...'
    Write-Host "  Foundry Local is not installed on this account." -ForegroundColor Yellow
    Write-Host "  Horizon will still start. Use the Connection panel for setup steps." -ForegroundColor Yellow
} else {
    Write-HorizonStep 'Step 2 of 4: looking for Foundry Local...'
    $endpoint = Get-FoundryEndpoint
    if (-not $endpoint) {
        Write-HorizonDetail 'The service is not running. Starting it...'
        foundry server start 2>&1 | Out-Null
        $endpoint = Get-FoundryEndpoint
    }

    if (-not $endpoint) {
        Write-Host "  The Foundry service could not be started." -ForegroundColor Yellow
        Write-Host "  Horizon will still start, and you can retry from the Connection panel." -ForegroundColor Yellow
    } else {
        $endpoint = Assert-LoopbackEndpoint -Endpoint $endpoint
        $apiBase = Get-FoundryApiBase -Endpoint $endpoint -ApiPrefix $config.foundry.apiPrefix
        Write-HorizonOk "Foundry is listening at $endpoint"
        Write-HorizonDetail 'Foundry chooses this port itself and it can change between runs. That is expected.'
    }
}

Write-HorizonStep "Step 3 of 4: preparing '$ModelAlias'..."
if (-not $apiBase) {
    Write-HorizonDetail 'Skipped: the model service is not available yet.'
} elseif ($SkipModelLoad) {
    Write-HorizonDetail 'Skipped at your request.'
} elseif ($Provider -eq 'ollama') {
    # Ollama loads a model on first use, and Horizon preloads it once it is up.
    try {
        $installed = (Invoke-RestMethod -Uri "$ollamaBase/api/tags" -TimeoutSec 10).models.name
        $wanted = if ($ModelAlias -notmatch ':') { "$ModelAlias:latest" } else { $ModelAlias }
        if ($installed -contains $wanted) {
            Write-HorizonOk "'$ModelAlias' is installed."
        } else {
            Write-Host "  '$ModelAlias' is not installed. Pull it with:" -ForegroundColor Yellow
            Write-Host "    ollama pull $ModelAlias" -ForegroundColor Yellow
            Write-Host "  You can also pick or download a model from the page." -ForegroundColor Yellow
        }
    } catch {
        Write-Host "  $($_.Exception.Message)" -ForegroundColor Yellow
    }
} else {
    foundry model load $ModelAlias 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  '$ModelAlias' could not be loaded. If it was never downloaded, run:" -ForegroundColor Yellow
        Write-Host "    foundry model download $ModelAlias" -ForegroundColor Yellow
        Write-Host "  You can also pick a different model from the page." -ForegroundColor Yellow
    } else {
        try {
            $modelId = Resolve-FoundryModel -ApiBase $apiBase -Alias $ModelAlias
            Write-HorizonOk "Model ready: $modelId"
        } catch {
            Write-Host "  $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
}

Write-HorizonStep 'Step 4 of 4: starting the local website...'

# Only pass what was actually resolved; the server discovers the rest itself
# and can recover if Foundry moves to a different port later.
# Ollama is found by the server itself, so only Foundry's endpoint is handed over.
$env:HORIZON_PROVIDER = $Provider
if ($apiBase -and $Provider -eq 'foundry') { $env:FOUNDRY_BASE_URL = $apiBase } else { Remove-Item Env:FOUNDRY_BASE_URL -ErrorAction SilentlyContinue }
if ($modelId) { $env:FOUNDRY_MODEL_ID = $modelId } else { Remove-Item Env:FOUNDRY_MODEL_ID -ErrorAction SilentlyContinue }
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
