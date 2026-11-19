<#
.SYNOPSIS
  Builds the Rulebox MSI (plan Phase 6, Section 4.10, Step 7).

.DESCRIPTION
  Writes one MSI, target\installer\Rulebox-<Version>-x64.msi. It only runs `wix build`.
  It never installs WiX or the .NET SDK and never runs or installs the MSI it builds.
  If WiX is missing it stops and says so.

  Steps: check the three binaries, write current.json, get the WebView2 bootstrapper and
  check its SHA-256 against webview2-bootstrapper.sha256, then `wix build -arch x64`
  with the UI and Util extensions pinned to the version of `wix`.

.PARAMETER BinDir
  Folder with the built rulebox-agent.exe, rulebox-shell.exe and rulebox-staff.exe
  (for example target\release, built with --features production).

.PARAMETER Version
  x.y.z. Only the first three fields count for upgrades (MSI ignores the fourth).

.PARAMETER OutDir
  Where the MSI and the staging folder go. Default: target\installer under the repo root.

.PARAMETER AcceptEula
  Passes `-acceptEula wix7` (the OSMF EULA of WiX v7). Without it `wix build` refuses to run.
  Only pass it after the EULA was accepted and recorded in README.md (EULA record).

.PARAMETER WebView2Bootstrapper
  A local MicrosoftEdgeWebview2Setup.exe. When omitted, the script uses one next to the
  binaries in BinDir, or downloads Microsoft's Evergreen bootstrapper into the staging folder.

.PARAMETER PinWebView2
  Writes the SHA-256 of the bootstrapper into webview2-bootstrapper.sha256 and stops.
  Review the diff and commit it. Step 8 compiles the same value into the agent.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $BinDir,
  [Parameter(Mandatory)] [ValidatePattern('^\d+\.\d+\.\d+$')] [string] $Version,
  [string] $OutDir,
  [switch] $AcceptEula,
  [string] $WebView2Bootstrapper,
  [switch] $PinWebView2
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$InstallerDir = $PSScriptRoot
$RepoRoot = (Resolve-Path (Join-Path $InstallerDir '..\..')).Path
if (-not $OutDir) { $OutDir = Join-Path $RepoRoot 'target\installer' }
$BinDir = (Resolve-Path -LiteralPath $BinDir).Path
$StageDir = Join-Path $OutDir 'stage'
$PinFile = Join-Path $InstallerDir 'webview2-bootstrapper.sha256'
$BootstrapperName = 'MicrosoftEdgeWebview2Setup.exe'
# Microsoft's permanent link to the Evergreen bootstrapper.
$BootstrapperUrl = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703'

function Get-PinnedHash {
  if (-not (Test-Path -LiteralPath $PinFile)) { return $null }
  foreach ($line in Get-Content -LiteralPath $PinFile) {
    $text = $line.Trim()
    if ($text -eq '' -or $text.StartsWith('#')) { continue }
    $first = ($text -split '\s+')[0]
    if ($first -match '^[0-9a-fA-F]{64}$') { return $first.ToLowerInvariant() }
    throw "$PinFile: expected a 64-digit SHA-256, found '$first'."
  }
  return $null
}

# 1. The binaries.
foreach ($name in 'rulebox-agent.exe', 'rulebox-shell.exe', 'rulebox-staff.exe') {
  if (-not (Test-Path -LiteralPath (Join-Path $BinDir $name))) {
    throw "Missing $name in $BinDir. Build the workspace in release first (cargo build --release --features production)."
  }
}

# 2. WiX must already be there. This script never installs it.
$wix = Get-Command wix -ErrorAction SilentlyContinue
if (-not $wix -and -not $PinWebView2) {
  throw 'WiX (the `wix` command) was not found. Install WiX v7 yourself or run this in CI; this script never installs it.'
}

New-Item -ItemType Directory -Force -Path $OutDir, $StageDir | Out-Null

# 3. The WebView2 bootstrapper, checked against the pinned hash.
$bootstrapper = Join-Path $StageDir $BootstrapperName
if ($WebView2Bootstrapper) {
  Copy-Item -LiteralPath $WebView2Bootstrapper -Destination $bootstrapper -Force
} elseif (Test-Path -LiteralPath (Join-Path $BinDir $BootstrapperName)) {
  Copy-Item -LiteralPath (Join-Path $BinDir $BootstrapperName) -Destination $bootstrapper -Force
} else {
  Write-Host "Downloading the WebView2 bootstrapper from $BootstrapperUrl"
  Invoke-WebRequest -Uri $BootstrapperUrl -OutFile $bootstrapper
}
$actual = (Get-FileHash -LiteralPath $bootstrapper -Algorithm SHA256).Hash.ToLowerInvariant()

if ($PinWebView2) {
  $pinText = @(
    '# SHA-256 of Microsoft''s Evergreen WebView2 bootstrapper (MicrosoftEdgeWebview2Setup.exe).',
    '# build.ps1 refuses any other file. Update with: build.ps1 -PinWebView2, review, commit.',
    '# The agent compiles the same value in (plan Phase 6 Step 8).',
    "$actual  $BootstrapperName"
  ) -join "`n"
  Set-Content -LiteralPath $PinFile -Value $pinText -Encoding utf8NoBOM
  Write-Host "Pinned $actual in $PinFile"
  return
}

$pinned = Get-PinnedHash
if (-not $pinned) {
  throw "No SHA-256 is pinned in $PinFile yet. Run build.ps1 -PinWebView2 once, review and commit the file."
}
if ($pinned -ne $actual) {
  throw "The WebView2 bootstrapper has SHA-256 $actual, but $PinFile pins $pinned. Refusing to package it."
}

# 4. current.json: the launcher starts the version it names (PRD 23.3).
$current = '{{"version":"{0}","exe":"versions\\{0}\\rulebox-staff.exe"}}' -f $Version
Set-Content -LiteralPath (Join-Path $StageDir 'current.json') -Value $current -Encoding utf8NoBOM -NoNewline

# 5. Build. The extensions are pinned to the version of `wix` itself.
$wixVersion = ((& wix --version) | Select-Object -First 1).ToString().Trim()
$wixVersion = ($wixVersion -split '[+\s]')[0]
if ($wixVersion -notmatch '^\d+\.\d+\.\d+') { throw "Cannot read the WiX version from '$wixVersion'." }

$msi = Join-Path $OutDir "Rulebox-$Version-x64.msi"
$arguments = @(
  'build', '-arch', 'x64',
  '-ext', "WixToolset.UI.wixext/$wixVersion",
  '-ext', "WixToolset.Util.wixext/$wixVersion",
  '-d', "Version=$Version",
  '-d', "BinDir=$BinDir",
  '-d', "RepoRoot=$RepoRoot",
  '-d', "InstallerDir=$InstallerDir",
  '-d', "StageDir=$StageDir",
  '-o', $msi
)
if ($AcceptEula) { $arguments += @('-acceptEula', 'wix7') }
foreach ($file in 'Package.wxs', 'Service.wxs', 'StaffApp.wxs', 'Checks.wxs', 'UI.wxs') {
  $arguments += (Join-Path $InstallerDir $file)
}

& wix @arguments
if ($LASTEXITCODE -ne 0) { throw "wix build failed with exit code $LASTEXITCODE." }
Write-Host "Built $msi"
