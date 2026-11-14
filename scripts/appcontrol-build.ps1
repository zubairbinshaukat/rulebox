<#
.SYNOPSIS
  Builds the App Control policy binaries the agent embeds (plan 4.9, Phase 5 Step 6).

.DESCRIPTION
  For each policy XML in apps\agent\policies\appcontrol and each variant (audit, enforce):
  sets or removes the "Enabled:Audit Mode" rule on a scratch copy, runs ConvertFrom-CIPolicy
  and writes target\appcontrol\<PolicyID>.<variant>.cip. Prints the SHA-256 of every file.
  It also writes target\appcontrol\sources.txt (the SHA-256 of each XML source, line endings
  ignored) so apps\agent\build.rs can refuse a binary that is older than its XML.

  SAFE ON THE DEV MACHINE: it only converts files. It never deploys a policy, never runs
  CiTool, never copies anything into C:\Windows and never changes a setting. Every path it
  writes is checked to be below <repo>\target\ first.

  Needs the ConfigCI module (part of Windows). If it is missing the script stops: run it on
  the VM and copy target\appcontrol\ back (plan Section 13).
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$targetRoot = [System.IO.Path]::GetFullPath((Join-Path $repo 'target'))
$sourceDir = Join-Path $repo 'apps\agent\policies\appcontrol'
$outDir = Join-Path $targetRoot 'appcontrol'
$workDir = Join-Path $outDir 'work'

function Assert-UnderTarget([string] $path) {
    $full = [System.IO.Path]::GetFullPath($path)
    $prefix = $targetRoot.TrimEnd('\') + '\'
    if (-not $full.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to write outside target\: $full"
    }
    return $full
}

foreach ($cmd in 'ConvertFrom-CIPolicy', 'Set-RuleOption') {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        throw "The ConfigCI module ($cmd) is missing on this Windows. Run this script on the VM and copy target\appcontrol\ back (plan Section 13)."
    }
}

# Fixed list: name of the XML file (without .xml). The agent embeds exactly these.
$policies = @('recommended-blocks', 'allowlist')
$variants = @('audit', 'enforce')
$AUDIT_MODE_OPTION = 3   # Set-RuleOption -Option 3 = "Enabled:Audit Mode"

function Get-NormalizedSha256([string] $file) {
    # Line endings are ignored so a CRLF checkout hashes like an LF one (build.rs does the same).
    $bytes = [System.IO.File]::ReadAllBytes($file)
    $clean = New-Object System.Collections.Generic.List[byte]
    foreach ($b in $bytes) { if ($b -ne 13) { $clean.Add($b) } }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([System.BitConverter]::ToString($sha.ComputeHash($clean.ToArray())) -replace '-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Get-FileSha256([string] $file) {
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant()
}

[void](Assert-UnderTarget $outDir)
[void](Assert-UnderTarget $workDir)
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
if (Test-Path -LiteralPath $workDir) { Remove-Item -LiteralPath $workDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $workDir | Out-Null

$sourceLines = New-Object System.Collections.Generic.List[string]
$built = 0
try {
    foreach ($name in $policies) {
        $xmlPath = Join-Path $sourceDir "$name.xml"
        if (-not (Test-Path -LiteralPath $xmlPath)) { throw "Missing policy source: $xmlPath" }
        $xml = [xml](Get-Content -LiteralPath $xmlPath -Raw)
        $ns = New-Object System.Xml.XmlNamespaceManager($xml.NameTable)
        $ns.AddNamespace('p', 'urn:schemas-microsoft-com:sipolicy')
        $policyId = $xml.SelectSingleNode('/p:SiPolicy/p:PolicyID', $ns).InnerText.Trim('{', '}').ToLowerInvariant()
        $baseId = $xml.SelectSingleNode('/p:SiPolicy/p:BasePolicyID', $ns).InnerText.Trim('{', '}').ToLowerInvariant()
        if ($policyId -ne $baseId) { throw "$name.xml must be a base policy (PolicyID = BasePolicyID)." }
        if ($policyId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { throw "$name.xml: bad PolicyID." }
        $sourceLines.Add("source $name $(Get-NormalizedSha256 $xmlPath)")

        foreach ($variant in $variants) {
            $scratch = Assert-UnderTarget (Join-Path $workDir "$name.$variant.xml")
            Copy-Item -LiteralPath $xmlPath -Destination $scratch -Force
            # Remove first, then add: never a duplicate rule.
            Set-RuleOption -FilePath $scratch -Option $AUDIT_MODE_OPTION -Delete
            if ($variant -eq 'audit') { Set-RuleOption -FilePath $scratch -Option $AUDIT_MODE_OPTION }

            $cip = Assert-UnderTarget (Join-Path $outDir "$policyId.$variant.cip")
            if (Test-Path -LiteralPath $cip) { Remove-Item -LiteralPath $cip -Force }
            ConvertFrom-CIPolicy -XmlFilePath $scratch -BinaryFilePath $cip | Out-Null
            if (-not (Test-Path -LiteralPath $cip) -or (Get-Item -LiteralPath $cip).Length -eq 0) {
                throw "ConvertFrom-CIPolicy produced no file for $name ($variant)."
            }
            $hash = Get-FileSha256 $cip
            $sourceLines.Add("binary $policyId.$variant.cip $hash")
            Write-Host ("{0}  {1}.{2}.cip  ({3} bytes)" -f $hash, $policyId, $variant, (Get-Item -LiteralPath $cip).Length)
            $built++
        }
    }
    $manifest = Assert-UnderTarget (Join-Path $outDir 'sources.txt')
    [System.IO.File]::WriteAllText($manifest, (($sourceLines -join "`n") + "`n"))
}
finally {
    if (Test-Path -LiteralPath $workDir) { Remove-Item -LiteralPath $workDir -Recurse -Force }
}
Write-Host "Built $built App Control binaries in $outDir (nothing was deployed)."
