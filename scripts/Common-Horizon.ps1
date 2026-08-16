<#
    Common-Horizon.ps1
    Shared helpers for the Horizon launcher scripts.
    All configuration comes from config.json so nothing is hardcoded twice.
#>

Set-StrictMode -Version Latest

$script:RootDir = Split-Path -Parent $PSScriptRoot

function Get-HorizonConfig {
    $defaultsPath = Join-Path $script:RootDir 'config.json'
    if (-not (Test-Path $defaultsPath)) {
        throw "config.json was not found at $defaultsPath. The project files may be incomplete."
    }
    $config = Get-Content $defaultsPath -Raw
    $config = $config.TrimStart([char]0xFEFF) | ConvertFrom-Json

    $localPath = Join-Path $script:RootDir 'config.local.json'
    if (Test-Path $localPath) {
        $local = Get-Content $localPath -Raw | ConvertFrom-Json
        foreach ($section in $local.PSObject.Properties) {
            if ($config.PSObject.Properties.Name -contains $section.Name) {
                foreach ($setting in $section.Value.PSObject.Properties) {
                    $config.($section.Name) | Add-Member -NotePropertyName $setting.Name -NotePropertyValue $setting.Value -Force
                }
            } else {
                $config | Add-Member -NotePropertyName $section.Name -NotePropertyValue $section.Value -Force
            }
        }
    }

    $config | Add-Member -NotePropertyName 'rootDir' -NotePropertyValue $script:RootDir -Force
    return $config
}

function Get-HorizonRuntimeState {
    param([Parameter(Mandatory)] $Config)

    $directory = $Config.runtime.directory
    if (-not [System.IO.Path]::IsPathRooted($directory)) {
        $directory = Join-Path $Config.rootDir $directory
    }
    $file = Join-Path $directory $Config.runtime.stateFile
    if (-not (Test-Path $file)) { return $null }

    try { return Get-Content $file -Raw | ConvertFrom-Json } catch { return $null }
}

function Remove-HorizonRuntimeState {
    param([Parameter(Mandatory)] $Config)

    $directory = $Config.runtime.directory
    if (-not [System.IO.Path]::IsPathRooted($directory)) {
        $directory = Join-Path $Config.rootDir $directory
    }
    $file = Join-Path $directory $Config.runtime.stateFile
    if (Test-Path $file) { Remove-Item $file -Force -ErrorAction SilentlyContinue }
}

function Assert-HorizonPrerequisite {
    param(
        [Parameter(Mandatory)][string] $Command,
        [Parameter(Mandatory)][string] $Guidance
    )
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
        throw "'$Command' was not found. $Guidance"
    }
}

function Get-FoundryEndpoint {
    $status = (foundry server status 2>&1 | Out-String)
    $match = [regex]::Match($status, 'https?://(?:127\.0\.0\.1|localhost)(?::\d+)?')
    if (-not $match.Success) { return $null }
    return $match.Value.TrimEnd('/')
}

function Assert-LoopbackEndpoint {
    param([Parameter(Mandatory)][string] $Endpoint)

    $uri = [uri]$Endpoint
    if ($uri.Host -notin @('127.0.0.1', 'localhost', '::1')) {
        throw "Refusing a non-loopback Foundry endpoint: $Endpoint. This tool is local-only by design."
    }
    return $Endpoint
}

function Get-FoundryApiBase {
    param(
        [Parameter(Mandatory)][string] $Endpoint,
        [Parameter(Mandatory)][string] $ApiPrefix
    )
    if ($Endpoint.EndsWith($ApiPrefix)) { return $Endpoint }
    return "$Endpoint$ApiPrefix"
}

function Resolve-FoundryModel {
    param(
        [Parameter(Mandatory)][string] $ApiBase,
        [Parameter(Mandatory)][string] $Alias
    )

    $models = (Invoke-RestMethod -Uri "$ApiBase/models" -Method Get -TimeoutSec 30).data
    if (-not $models) { throw "Foundry Local returned no models from $ApiBase/models." }

    $match = $models | Where-Object { $_.parent -eq $Alias } | Select-Object -First 1
    if (-not $match) { $match = $models | Where-Object { $_.id -eq $Alias } | Select-Object -First 1 }
    if (-not $match) { $match = $models | Where-Object { $_.id -like "$Alias*" } | Select-Object -First 1 }

    if (-not $match) {
        $available = ($models | ForEach-Object { $_.id }) -join ', '
        throw "No loaded model matches the alias '$Alias'. Loaded models: $available. Load it with: foundry model load $Alias"
    }
    return $match.id
}

function Write-HorizonStep {
    param([Parameter(Mandatory)][string] $Message)
    Write-Host "  $Message" -ForegroundColor Cyan
}

function Write-HorizonOk {
    param([Parameter(Mandatory)][string] $Message)
    Write-Host "  $Message" -ForegroundColor Green
}

function Write-HorizonDetail {
    param([Parameter(Mandatory)][string] $Message)
    Write-Host "  $Message" -ForegroundColor DarkGray
}
