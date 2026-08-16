<#
.SYNOPSIS
    Measures your hardware, benchmarks models, and applies the fastest sensible settings.

.DESCRIPTION
    Nothing here is guessed. The script inspects this machine, times real
    completions, and writes its recommendation to config.local.json so the app
    picks it up automatically.

.EXAMPLE
    .\Optimize-Horizon.ps1
    Benchmarks models already downloaded and reports what it finds.

.EXAMPLE
    .\Optimize-Horizon.ps1 -Apply
    Same, but writes the winning model into config.local.json.

.EXAMPLE
    .\Optimize-Horizon.ps1 -IncludeCandidates -Apply
    Also downloads a couple of small, fast chat models and includes them.
#>
[CmdletBinding()]
param(
    [switch] $Apply,
    [switch] $IncludeCandidates,
    [int]    $TokenBudget = 120
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common-Horizon.ps1')

$config = Get-HorizonConfig

# Small, non-reasoning chat models. Reasoning models are deliberately excluded:
# they emit long <think> passages before answering, which feels far slower.
$candidateModels = @('qwen2.5-1.5b', 'phi-3.5-mini')

function Write-Section {
    param([string] $Title)
    Write-Host ""
    Write-Host "  $Title" -ForegroundColor White
    Write-Host "  $('-' * $Title.Length)" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "  Performance tuning for $($config.app.displayName)" -ForegroundColor White
Write-Host "  This measures your actual machine. It takes a few minutes." -ForegroundColor DarkGray

# ---------------------------------------------------------------- hardware ---
Write-Section 'Your hardware'

$status = foundry status --output json 2>$null | ConvertFrom-Json -ErrorAction SilentlyContinue
$cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1).Name
$ramGb = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
$arch = $env:PROCESSOR_ARCHITECTURE

Write-HorizonDetail "CPU:          $cpu"
Write-HorizonDetail "Architecture: $arch"
Write-HorizonDetail "Memory:       $ramGb GB"

# ------------------------------------------------------- execution provider ---
Write-Section 'Acceleration available to Foundry'

$variants = foundry model list --variants 2>&1 | Out-String
$hasNpuVariant = $variants -match 'NPU'
$hasGpuVariant = $variants -match 'WebGpu|DML|CUDA'

if ($hasNpuVariant) {
    Write-HorizonOk 'NPU-accelerated model variants are available. These are usually fastest.'
} elseif ($arch -eq 'ARM64') {
    Write-Host "  No NPU variants are published for this Foundry version." -ForegroundColor Yellow
    Write-Host "  Your machine has an NPU, but Foundry cannot use it yet. This is a" -ForegroundColor Yellow
    Write-Host "  Foundry limitation, not a fault on your side. Expect modest speeds." -ForegroundColor Yellow
}
if ($hasGpuVariant) { Write-HorizonDetail 'GPU-accelerated variants are available for at least one model.' }

# ------------------------------------------------------------ daemon config ---
Write-Section 'Foundry service settings'

# Keeping the model resident avoids paying the load cost on every first message.
$currentConfig = foundry config show 2>&1 | Out-String
if ($currentConfig -match 'idle-timeout-minutes\s*\|\s*disabled') {
    Write-HorizonOk 'Models stay loaded in memory (idle timeout disabled). This is what we want.'
} else {
    Write-HorizonDetail 'Disabling the idle timeout so the model is not unloaded between messages...'
    if ($Apply) {
        foundry config set idle-timeout-minutes 0 2>&1 | Out-Null
        Write-HorizonOk 'Idle timeout disabled.'
    } else {
        Write-Host "  Would run: foundry config set idle-timeout-minutes 0" -ForegroundColor Yellow
    }
}

if ($currentConfig -match 'log-level\s*\|\s*(debug|trace)') {
    Write-HorizonDetail 'Verbose logging is on and costs a little speed. Reducing it...'
    if ($Apply) { foundry config set log-level info 2>&1 | Out-Null; Write-HorizonOk 'Log level set to info.' }
}

# ------------------------------------------------------------ what to test ---
Write-Section 'Choosing models to benchmark'

if (-not (Get-FoundryEndpoint)) {
    Write-HorizonDetail 'Starting the Foundry service...'
    foundry server start 2>&1 | Out-Null
}
$endpoint = Get-FoundryEndpoint
if (-not $endpoint) { throw 'The Foundry service could not be started. See TROUBLESHOOTING.md.' }
$apiBase = Get-FoundryApiBase -Endpoint (Assert-LoopbackEndpoint -Endpoint $endpoint) -ApiPrefix $config.foundry.apiPrefix

$cacheText = foundry cache list 2>&1 | Out-String
$cachedAliases = [regex]::Matches($cacheText, '(?m)^\|\s*([a-z0-9][\w\.\-]+)\s*\|') |
    ForEach-Object { $_.Groups[1].Value } |
    Where-Object { $_ -ne 'Alias' } |
    Sort-Object -Unique

if ($IncludeCandidates) {
    foreach ($candidate in $candidateModels) {
        if ($cachedAliases -notcontains $candidate) {
            Write-HorizonDetail "Downloading $candidate to compare..."
            foundry model download $candidate 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) { $cachedAliases += $candidate }
        }
    }
}

# Speech and embedding models cannot answer chat prompts, so skip them.
$skipPattern = 'whisper|parakeet|nemotron|embedding'
$toTest = $cachedAliases | Where-Object { $_ -notmatch $skipPattern }

if (-not $toTest) { throw 'No chat models are downloaded. Run Setup-Horizon.ps1 first.' }
Write-HorizonDetail "Will benchmark: $($toTest -join ', ')"

# -------------------------------------------------------------- benchmark ----
Write-Section 'Benchmarking'
Write-HorizonDetail 'Each model is loaded, warmed up, then timed. Please wait.'

$results = @()
foreach ($alias in $toTest) {
    Write-Host ""
    Write-Host "  Testing $alias..." -ForegroundColor Cyan
    try {
        foundry model load $alias 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { Write-Host "    Skipped: could not load." -ForegroundColor DarkGray; continue }

        $modelId = Resolve-FoundryModel -ApiBase $apiBase -Alias $alias

        # Warm-up call. The first request after loading pays a one-off cost that
        # would otherwise distort the measurement.
        $warm = @{ model = $modelId; messages = @(@{ role = 'user'; content = 'Hi' }); max_tokens = 1; stream = $false } | ConvertTo-Json -Depth 6
        Invoke-RestMethod -Uri "$apiBase/chat/completions" -Method Post -ContentType 'application/json' -Body $warm -TimeoutSec 600 | Out-Null

        $body = @{
            model      = $modelId
            messages   = @(@{ role = 'user'; content = 'Write a single paragraph about the sea.' })
            max_tokens = $TokenBudget
            stream     = $false
        } | ConvertTo-Json -Depth 6

        $sw = [Diagnostics.Stopwatch]::StartNew()
        $response = Invoke-RestMethod -Uri "$apiBase/chat/completions" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 900
        $sw.Stop()

        $tokens = [int]$response.usage.completion_tokens
        $seconds = $sw.Elapsed.TotalSeconds
        $rate = if ($seconds -gt 0) { [math]::Round($tokens / $seconds, 2) } else { 0 }
        $text = [string]$response.choices[0].message.content
        $isReasoning = $text -match '<think>'

        $results += [pscustomobject]@{
            Alias        = $alias
            ModelId      = $modelId
            TokensPerSec = $rate
            Seconds      = [math]::Round($seconds, 1)
            Reasoning    = $isReasoning
        }

        $suffix = if ($isReasoning) { '  (reasoning model: thinks out loud first)' } else { '' }
        Write-HorizonOk "$rate tokens/second$suffix"

        foundry model unload $alias 2>&1 | Out-Null
    } catch {
        Write-Host "    Skipped: $($_.Exception.Message)" -ForegroundColor DarkGray
    }
}

if (-not $results) { throw 'No model could be benchmarked successfully.' }

# ----------------------------------------------------------------- verdict ---
Write-Section 'Results'

$results |
    Sort-Object TokensPerSec -Descending |
    Format-Table @{L='Model';E={$_.Alias}},
                 @{L='Tokens/sec';E={$_.TokensPerSec}},
                 @{L='Thinks out loud';E={ if ($_.Reasoning) {'yes'} else {'no'} }} -AutoSize |
    Out-String |
    Write-Host

# Prefer a straight-talking model: reasoning models spend tokens before the
# answer starts, which feels slow even at a good token rate.
$best = $results | Where-Object { -not $_.Reasoning } | Sort-Object TokensPerSec -Descending | Select-Object -First 1
if (-not $best) { $best = $results | Sort-Object TokensPerSec -Descending | Select-Object -First 1 }

Write-HorizonOk "Fastest for everyday chat: $($best.Alias) at $($best.TokensPerSec) tokens/second."

if ($best.TokensPerSec -lt 10) {
    Write-Host ""
    Write-Host "  A note on expectations:" -ForegroundColor Yellow
    Write-Host "  Under about 10 tokens/second, replies appear slower than reading pace." -ForegroundColor Yellow
    Write-Host "  Streaming is enabled, so text appears as it is produced rather than" -ForegroundColor Yellow
    Write-Host "  all at once at the end. Smaller models will feel noticeably quicker." -ForegroundColor Yellow
}

# ------------------------------------------------------------------ apply ----
if ($Apply) {
    Write-Section 'Applying'

    $localPath = Join-Path $config.rootDir 'config.local.json'
    $local = if (Test-Path $localPath) { Get-Content $localPath -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }

    $local | Add-Member -NotePropertyName 'model' -NotePropertyValue ([pscustomobject]@{ alias = $best.Alias }) -Force
    $local | Add-Member -NotePropertyName 'chat'  -NotePropertyValue ([pscustomobject]@{ stream = $true }) -Force

    $local | ConvertTo-Json -Depth 6 | Set-Content $localPath -Encoding UTF8
    Write-HorizonOk "Wrote your settings to config.local.json (model: $($best.Alias))."
    Write-HorizonDetail 'This file overrides config.json and is ignored by source control.'

    foundry model load $best.Alias 2>&1 | Out-Null
    Write-HorizonOk 'Preloaded it so your first message is not slowed by loading.'
} else {
    Write-Host ""
    Write-HorizonDetail 'Nothing was changed. Rerun with -Apply to save these settings.'
}

Write-Host ""
Write-HorizonOk 'Finished. Run .\Start-Horizon.ps1 to chat.'
Write-Host ""
