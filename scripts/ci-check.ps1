<#
.SYNOPSIS
  Runs the test part of .github/workflows/release.yml locally, in the same order, so a push
  to phase6-msi (or a tag) does not fail on something this PC could have caught.

.DESCRIPTION
  pnpm ci:check          Rust + production guard + JavaScript tests + policy-vector check
  pnpm ci:check -Fast    JavaScript tests + policy-vector check only (no cargo)

  It does not build release binaries or the MSI (that costs 1-3 GB of target\release);
  for that run apps/installer/build.ps1 after a release build. Keep the steps in sync
  with release.yml when that file changes.
#>
[CmdletBinding()]
param([switch] $Fast)

$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

# CI runs Node 22; some scripts (gen-policy-vectors: module.registerHooks, strip-only
# TypeScript) do not run at all on older versions.
$major = [int]((node --version).TrimStart('v').Split('.')[0])
if ($major -lt 22) { throw "Node $(node --version) is too old: CI uses Node 22 (nvm use 22)." }

$steps = [System.Collections.Generic.List[object]]::new()
if (-not $Fast) {
  $steps.Add(@('Rust workspace tests', { cargo test --workspace --locked }))
  $steps.Add(@('Production guard tests', { cargo test --locked -p rulebox-win32 --features production --test guard_coverage }))
}
# One package at a time: the dashboard and Staff App suites time out when they share this PC's CPU.
$steps.Add(@('JavaScript tests (packages)', { pnpm -r --workspace-concurrency=1 --if-present test }))
$steps.Add(@('Convex tests', { pnpm test:convex }))
$steps.Add(@('Script tests', { pnpm test:scripts }))
$steps.Add(@('Installer source tests', { pnpm test:installer }))
$steps.Add(@('Policy vectors up to date', { node scripts/gen-policy-vectors.mjs --check }))

$started = Get-Date
foreach ($s in $steps) {
  Write-Host "`n=== $($s[0]) ===" -ForegroundColor Cyan
  & $s[1]
  if ($LASTEXITCODE -ne 0) {
    Write-Host "`nFAILED: $($s[0]) (exit $LASTEXITCODE)" -ForegroundColor Red
    exit 1
  }
}
Write-Host ("`nAll CI checks passed in {0:mm\:ss}." -f ((Get-Date) - $started)) -ForegroundColor Green
