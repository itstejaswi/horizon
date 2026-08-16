<#
.SYNOPSIS
    Starts Horizon. Foundry Local is started too if it is available.

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

$apiBase = $null
$modelId = $null

Write-HorizonStep 'Step 2 of 4: looking for Foundry Local...'
if (-not (Get-Command foundry -ErrorAction SilentlyContinue)) {
    Write-Host "  Foundry Local is not installed on this account." -ForegroundColor Yellow
    Write-Host "  Horizon will still start. Use the Connection panel for setup steps." -ForegroundColor Yellow
} else {
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
    Write-HorizonDetail 'Skipped: the Foundry service is not available yet.'
} elseif ($SkipModelLoad) {
    Write-HorizonDetail 'Skipped at your request.'
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
if ($apiBase) { $env:FOUNDRY_BASE_URL = $apiBase } else { Remove-Item Env:FOUNDRY_BASE_URL -ErrorAction SilentlyContinue }
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
    Write-HorizonDetail 'Run .\Stop-Horizon.ps1 to stop the Foundry service and free its memory.'
    Write-Host ""
}
