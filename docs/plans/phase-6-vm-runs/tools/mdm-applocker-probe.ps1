param([string]$Out = 'C:\rb-run\out\a3-mdm-applocker-probe.txt')
# Run A3 item 8b: which AppLocker CSP classes the MDM WMI bridge has on this PC, and which instances exist. Read-only.
# Runs as SYSTEM (the bridge refuses other users).
$o = @("whoami: $(whoami)")
try {
  $classes = Get-CimClass -Namespace root\cimv2\mdm\dmmap -ClassName 'MDM_AppLocker*' -ErrorAction Stop
  $o += "classes: $(@($classes).Count)"
  $o += $classes | ForEach-Object CimClassName | Sort-Object
} catch { $o += "Get-CimClass failed: $($_.Exception.Message)" }
foreach ($c in 'MDM_AppLocker_ApplicationLaunchRestrictions01_EXE03', 'MDM_AppLocker_ApplicationLaunchRestrictions01_MSI03',
               'MDM_AppLocker_ApplicationLaunchRestrictions01_Script03', 'MDM_AppLocker_ApplicationLaunchRestrictions01_StoreApps03') {
  try {
    $i = @(Get-CimInstance -Namespace root\cimv2\mdm\dmmap -ClassName $c -ErrorAction Stop)
    $o += "$c instances=$($i.Count) " + (($i | ForEach-Object { "$($_.ParentID)|$($_.InstanceID) policyLen=$($_.Policy.Length)" }) -join ' ; ')
  } catch { $o += "$c ERROR $($_.Exception.Message)" }
}
$o += "--- HKLM AppLocker MDM store"
$o += Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\PolicyManager\current\device\ApplicationLaunchRestrictions' -Recurse -ErrorAction SilentlyContinue | ForEach-Object Name
$o += "--- AppIDSvc"
$o += (sc.exe qc AppIDSvc) ; $o += (sc.exe sdshow AppIDSvc)
$o | Set-Content $Out
