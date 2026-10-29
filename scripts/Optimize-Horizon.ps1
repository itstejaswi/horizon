<#
.SYNOPSIS
    Measures local hardware, benchmarks downloaded Ollama chat models, and can save the fastest model.

.DESCRIPTION
    The script benchmarks models already downloaded. Ollama does not provide a
    portable control here for changing daemon logging/idle settings or selecting
    GPU/NPU variants, so those optimizations are not attempted.

.EXAMPLE
    .\Optimize-Horizon.ps1
    Benchmarks models already downloaded and reports what it finds.

.EXAMPLE
    .\Optimize-Horizon.ps1 -Apply
    Same, but writes the winning model into config.local.json.

.EXAMPLE
    .\Optimize-Horizon.ps1 -IncludeCandidates -Apply
    Also downloads a couple of small chat models and includes them.
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
if ($TokenBudget -lt 1 -or $TokenBudget -gt 4096) {
    throw 'TokenBudget must be between 1 and 4096.'
}
$ollamaBase = Get-OllamaBaseUrl -Config $config

# Small chat models that are already used as suggestions by Horizon.
$candidateModels = @('llama3.2:1b', 'qwen2.5:1.5b')

function Write-Section {
    param([string] $Title)
    Write-Host ""
    Write-Host "  $Title" -ForegroundColor White
    Write-Host "  $('-' * $Title.Length)" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "  Performance tuning for $($config.app.displayName)" -ForegroundColor White
Write-Host "  This measures your actual machine. It takes a few minutes." -ForegroundColor DarkGray
Write-HorizonDetail 'Ollama acceleration variants and daemon settings cannot be selected portably here; this script benchmarks real local responses instead.'

if (-not (Start-HorizonOllamaService -BaseUrl $ollamaBase)) {
    throw "Ollama is not responding at $ollamaBase. Start Ollama and rerun this script."
}

# ---------------------------------------------------------------- hardware ---
Write-Section 'Your hardware'

$cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1).Name
$ramGb = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
$arch = $env:PROCESSOR_ARCHITECTURE

Write-HorizonDetail "CPU:          $cpu"
Write-HorizonDetail "Architecture: $arch"
Write-HorizonDetail "Memory:       $ramGb GB"

# ------------------------------------------------------- models to benchmark ---
Write-Section 'Choosing models to benchmark'

$installed = @(Get-OllamaModels -BaseUrl $ollamaBase -TimeoutSec 30)
$cachedAliases = @(
    $installed |
        ForEach-Object { if ($_.name) { [string]$_.name } else { [string]$_.model } } |
        Where-Object { $_ }
)

if ($IncludeCandidates) {
    foreach ($candidate in $candidateModels) {
        if ((Resolve-OllamaModel -Models $installed -Alias $candidate)) { continue }
        Write-HorizonDetail "Downloading $candidate through the local Ollama service..."
        $pullBody = @{ model = $candidate; stream = $false } | ConvertTo-Json -Depth 4
        Invoke-RestMethod -Uri "$ollamaBase/api/pull" -Method Post -ContentType 'application/json' -Body $pullBody -TimeoutSec 3600 | Out-Null
        $installed = @(Get-OllamaModels -BaseUrl $ollamaBase -TimeoutSec 30)
        $candidateName = Resolve-OllamaModel -Models $installed -Alias $candidate
        if ($candidateName) { $cachedAliases += $candidateName }
        else { Write-Host "  '$candidate' did not appear in Ollama's installed-model list after download." -ForegroundColor Yellow }
    }
}

# Embedding and speech models cannot answer the chat benchmark.
$skipPattern = 'whisper|parakeet|embedding|embed|bert'
$toTest = @($cachedAliases | Where-Object { $_ -notmatch $skipPattern } | Sort-Object -Unique)
if (-not $toTest) { throw 'No chat models are downloaded. Run .\Setup-Horizon.ps1 first.' }
Write-HorizonDetail "Will benchmark: $($toTest -join ', ')"

# -------------------------------------------------------------- benchmark ----
Write-Section 'Benchmarking'
Write-HorizonDetail 'Each model is warmed up, timed, and unloaded. Please wait.'

$benchmarkKeepAlive = if ($config.ollama.keepAlive) { $config.ollama.keepAlive } else { '30m' }
$results = @()
foreach ($alias in $toTest) {
    Write-Host ""
    Write-Host "  Testing $alias..." -ForegroundColor Cyan
    try {
        $warm = @{
            model    = $alias
            messages = @(@{ role = 'user'; content = 'Hi' })
            options  = @{ num_predict = 1 }
            keep_alive = $benchmarkKeepAlive
            stream   = $false
        } | ConvertTo-Json -Depth 6
        Invoke-RestMethod -Uri "$ollamaBase/api/chat" -Method Post -ContentType 'application/json' -Body $warm -TimeoutSec 600 | Out-Null

        $body = @{
            model    = $alias
            messages = @(@{ role = 'user'; content = 'Write a single paragraph about the sea.' })
            options  = @{ num_predict = $TokenBudget }
            keep_alive = $benchmarkKeepAlive
            stream   = $false
        } | ConvertTo-Json -Depth 6

        $sw = [Diagnostics.Stopwatch]::StartNew()
        $response = Invoke-RestMethod -Uri "$ollamaBase/api/chat" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 900
        $sw.Stop()

        $tokens = [int]$response.eval_count
        if ($tokens -lt 1) { throw 'Ollama returned no completion-token count for the benchmark.' }
        $seconds = if ([double]$response.eval_duration -gt 0) {
            [double]$response.eval_duration / 1000000000
        } else {
            $sw.Elapsed.TotalSeconds
        }
        $rate = if ($seconds -gt 0) { [math]::Round($tokens / $seconds, 2) } else { 0 }
        $text = [string]$response.message.content
        $isReasoning = $text -match '<think>'

        $results += [pscustomobject]@{
            Alias        = $alias
            TokensPerSec = $rate
            Seconds      = [math]::Round($seconds, 1)
            Reasoning    = $isReasoning
        }

        $suffix = if ($isReasoning) { '  (reasoning model: thinks out loud first)' } else { '' }
        Write-HorizonOk "$rate tokens/second$suffix"
    } catch {
        Write-Host "    Skipped: $($_.Exception.Message)" -ForegroundColor DarkGray
    } finally {
        try {
            $unload = @{ model = $alias; prompt = ''; stream = $false; keep_alive = 0 } | ConvertTo-Json -Depth 4
            Invoke-RestMethod -Uri "$ollamaBase/api/generate" -Method Post -ContentType 'application/json' -Body $unload -TimeoutSec 120 | Out-Null
        } catch {
            Write-HorizonDetail "Could not unload '$alias' after benchmarking: $($_.Exception.Message)"
        }
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
    $modelSettings = if ($local.PSObject.Properties.Name -contains 'model' -and $local.model) {
        $local.model
    } else {
        [pscustomobject]@{}
    }
    $modelSettings | Add-Member -NotePropertyName 'alias' -NotePropertyValue $best.Alias -Force
    $local | Add-Member -NotePropertyName 'model' -NotePropertyValue $modelSettings -Force

    $local | ConvertTo-Json -Depth 10 | Set-Content $localPath -Encoding UTF8
    Write-HorizonOk "Wrote your settings to config.local.json (model: $($best.Alias))."
    Write-HorizonDetail 'Existing local settings were preserved; only the model alias was changed.'

    $keepAlive = if ($config.ollama.keepAlive) { $config.ollama.keepAlive } else { '30m' }
    $preload = @{ model = $best.Alias; prompt = ''; stream = $false; keep_alive = $keepAlive } | ConvertTo-Json -Depth 4
    Invoke-RestMethod -Uri "$ollamaBase/api/generate" -Method Post -ContentType 'application/json' -Body $preload -TimeoutSec 600 | Out-Null
    Write-HorizonOk 'Preloaded it so your first message is not slowed by loading.'
} else {
    Write-Host ""
    Write-HorizonDetail 'Nothing was changed. Rerun with -Apply to save these settings.'
}

Write-Host ""
Write-HorizonOk 'Finished. Run .\Start-Horizon.ps1 to chat.'
Write-Host ""
