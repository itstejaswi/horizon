<#
.SYNOPSIS
    One-time setup: checks prerequisites, installs Microsoft Foundry Local, and downloads the model.

.EXAMPLE
    .\Setup-Horizon.ps1

.EXAMPLE
    .\Setup-Horizon.ps1 -ModelAlias qwen2.5-0.5b
#>
[CmdletBinding()]
param(
    [string] $ModelAlias
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common-Horizon.ps1')

$config = Get-HorizonConfig
if (-not $ModelAlias) { $ModelAlias = $config.model.alias }

Write-Host ""
Write-Host "$($config.app.displayName) setup" -ForegroundColor White
Write-Host "  This runs once. It needs internet access and may take a while." -ForegroundColor DarkGray
Write-Host ""

Write-HorizonStep 'Step 1 of 4: checking Node.js...'
Assert-HorizonPrerequisite -Command 'node' -Guidance 'Install Node.js 18 or later from an approved source, then run this script again.'
$nodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 18) {
    throw "Node.js 18 or later is required, but $(node --version) was found. Update Node.js and run this script again."
}
Write-HorizonOk "Node.js $(node --version) found."

Write-HorizonStep 'Step 2 of 4: checking Microsoft Foundry Local...'
if (-not (Get-Command foundry -ErrorAction SilentlyContinue)) {
    Assert-HorizonPrerequisite -Command 'winget' -Guidance 'Install Microsoft Foundry Local manually, then run this script again.'
    Write-HorizonDetail 'Foundry Local was not found. Installing it now...'
    winget install --id Microsoft.FoundryLocal --exact --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { throw "The Foundry Local installation failed with exit code $LASTEXITCODE." }
}
if (-not (Get-Command foundry -ErrorAction SilentlyContinue)) {
    throw 'Foundry Local was installed, but the "foundry" command is not available in this window. Close PowerShell, open it again, and rerun this script.'
}
Write-HorizonOk "Foundry Local $((foundry --version 2>&1 | Select-Object -First 1)) found."

Write-HorizonStep 'Step 3 of 4: preparing the Foundry service...'
foundry model list | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-HorizonDetail 'The service did not respond. Restarting it and trying again...'
    foundry server restart
    foundry model list | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'The Foundry Local service could not be started. See TROUBLESHOOTING.md.' }
}
Write-HorizonOk 'Foundry service is responding.'

Write-HorizonStep "Step 4 of 4: downloading the model '$ModelAlias'..."
Write-HorizonDetail 'This is a large one-time download. Leave this window open.'
foundry model download $ModelAlias
if ($LASTEXITCODE -ne 0) { throw "Downloading '$ModelAlias' failed with exit code $LASTEXITCODE." }

Write-Host ""
Write-HorizonOk 'Setup completed.'
Write-Host "  Next step: run .\Start-Horizon.ps1" -ForegroundColor White
Write-Host ""
