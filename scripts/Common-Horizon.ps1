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

function Assert-LoopbackEndpoint {
    param([Parameter(Mandatory)][string] $Endpoint)

    $uri = $null
    if (-not [uri]::TryCreate($Endpoint, [System.UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -notin @('http', 'https') -or
        $uri.UserInfo -or
        $uri.Query -or
        $uri.Fragment) {
        throw "Invalid local service endpoint: $Endpoint."
    }

    $hostName = $uri.Host -replace '^\[|\]$', ''
    if ($hostName -notin @('127.0.0.1', 'localhost', '::1')) {
        throw "Refusing a non-loopback endpoint: $Endpoint. This tool is local-only by design."
    }

    $baseUrl = $Endpoint.TrimEnd('/')
    if ($baseUrl -match '/v1$') { $baseUrl = $baseUrl.Substring(0, $baseUrl.Length - 3) }
    return $baseUrl
}

function Get-OllamaBaseUrl {
    param([Parameter(Mandatory)] $Config)

    $baseUrl = if ($env:HORIZON_OLLAMA_URL) {
        $env:HORIZON_OLLAMA_URL
    } elseif ($Config.ollama.baseUrl) {
        "$($Config.ollama.baseUrl)"
    } else {
        'http://127.0.0.1:11434'
    }
    return Assert-LoopbackEndpoint -Endpoint $baseUrl.TrimEnd('/')
}

function Test-OllamaService {
    param(
        [Parameter(Mandatory)][string] $BaseUrl,
        [int] $TimeoutSec = 2
    )

    try {
        Invoke-RestMethod -Uri "$BaseUrl/api/version" -TimeoutSec $TimeoutSec | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Start-HorizonOllamaService {
    param(
        [Parameter(Mandatory)][string] $BaseUrl,
        [int] $WaitSeconds = 10
    )

    $BaseUrl = Assert-LoopbackEndpoint -Endpoint $BaseUrl
    if (Test-OllamaService -BaseUrl $BaseUrl) { return $true }

    $command = Get-Command ollama -CommandType Application -ErrorAction SilentlyContinue
    if (-not $command) { return $false }

    $previousHost = $env:OLLAMA_HOST
    try {
        $env:OLLAMA_HOST = ([uri]$BaseUrl).Authority
        Start-Process -FilePath $command.Source -ArgumentList 'serve' -WindowStyle Hidden
    } finally {
        if ($null -eq $previousHost) {
            Remove-Item Env:OLLAMA_HOST -ErrorAction SilentlyContinue
        } else {
            $env:OLLAMA_HOST = $previousHost
        }
    }

    for ($i = 0; $i -lt ($WaitSeconds * 2); $i++) {
        if (Test-OllamaService -BaseUrl $BaseUrl) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return (Test-OllamaService -BaseUrl $BaseUrl)
}

function Get-OllamaModels {
    param(
        [Parameter(Mandatory)][string] $BaseUrl,
        [int] $TimeoutSec = 20
    )

    $BaseUrl = Assert-LoopbackEndpoint -Endpoint $BaseUrl
    $response = Invoke-RestMethod -Uri "$BaseUrl/api/tags" -Method Get -TimeoutSec $TimeoutSec
    return @($response.models)
}

function Resolve-OllamaModel {
    param(
        [Parameter(Mandatory)][object[]] $Models,
        [Parameter(Mandatory)][string] $Alias
    )

    $wanted = if ($Alias -notmatch ':') { $Alias + ':latest' } else { $Alias }
    $match = $Models |
        Where-Object {
            $name = if ($_.name) { [string]$_.name } else { [string]$_.model }
            $name -ieq $Alias -or $name -ieq $wanted
        } |
        Select-Object -First 1
    if (-not $match) { return $null }
    if ($match.name) { return [string]$match.name }
    return [string]$match.model
}

function Assert-OllamaModelAlias {
    param([Parameter(Mandatory)][string] $Alias)

    if ($Alias -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._\-/:]{0,127}$' -or
        $Alias.Contains('..') -or
        $Alias.Contains('//')) {
        throw "Rejected Ollama model name: $Alias"
    }
    return $Alias
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
