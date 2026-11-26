param([string]$Tag)
# Step 22 install checks: service, failure actions, folder ACL, files, marker registry, Start menu, ARP, agent log tail, events.
$o = @()
$o += "== service"; $o += (sc.exe qc RuleboxAgent) ; $o += (sc.exe qfailure RuleboxAgent); $o += (sc.exe queryex RuleboxAgent)
$o += "== service SDDL"; $o += (sc.exe sdshow RuleboxAgent)
$o += "== service privileges"; $o += (sc.exe qprivs RuleboxAgent)
$o += "== folder ACL"
$staff = @(Get-ChildItem 'C:\Program Files\Rulebox\versions\*\rulebox-staff.exe' -ErrorAction SilentlyContinue | ForEach-Object FullName)
foreach ($p in @('C:\Program Files\Rulebox','C:\Program Files\Rulebox\rulebox-agent.exe') + $staff) {
  if (Test-Path $p) { $a = Get-Acl $p; $o += "$p"; $o += "  SDDL $($a.Sddl)"; $o += "  protected=$($a.AreAccessRulesProtected)"; $o += ($a.Access | ForEach-Object { "  $($_.IdentityReference) $($_.FileSystemRights) $($_.AccessControlType) inherited=$($_.IsInherited)" }) }
}
$o += "== files"; $o += Get-ChildItem 'C:\Program Files\Rulebox' -Recurse -File | ForEach-Object { "{0} {1} v={2} sha256={3}" -f $_.FullName, $_.Length, $_.VersionInfo.FileVersion, (Get-FileHash $_.FullName).Hash }
$o += "== current.json"; $o += Get-Content 'C:\Program Files\Rulebox\current.json' -ErrorAction SilentlyContinue
$o += "== HKLM\SOFTWARE\Rulebox"
if (Test-Path HKLM:\SOFTWARE\Rulebox) { Get-ChildItem HKLM:\SOFTWARE\Rulebox -Recurse | ForEach-Object { $k = $_; $o += "KEY $($k.Name)"; foreach ($n in $k.Property) { $v = $k.GetValue($n); $kind = $k.GetValueKind($n); if ($n -eq 'Code') { $v = "<present, length $($v.Length)>" }; $o += "  $n ($kind) = $v" } } } else { $o += "  (no key)" }
if (Test-Path HKLM:\SOFTWARE\Rulebox\Install\Pending) { $o += "Pending SDDL: $((Get-Acl HKLM:\SOFTWARE\Rulebox\Install\Pending).Sddl)" }
$o += "== Start menu"; Get-ChildItem 'C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Rulebox' -ErrorAction SilentlyContinue | ForEach-Object { $sh = (New-Object -ComObject WScript.Shell).CreateShortcut($_.FullName); $o += "$($_.Name) -> $($sh.TargetPath) $($sh.Arguments) (wd $($sh.WorkingDirectory))" }
$o += "== ARP"; $o += Get-ChildItem HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall | ForEach-Object { $p = Get-ItemProperty $_.PSPath; if ($p.DisplayName -like 'Rulebox*') { "$($_.PSChildName) | $($p.DisplayName) | $($p.DisplayVersion) | NoModify=$($p.NoModify) | $($p.UninstallString)" } }
$o += "== ProgramData\Rulebox"; $o += Get-ChildItem C:\ProgramData\Rulebox -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object { "$($_.FullName) $($_.Length)" }
$o += "== agent processes"; $o += Get-CimInstance Win32_Process -Filter "Name like 'rulebox%'" | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }
$o += "== Application events (Rulebox*, last 30)"; $o += Get-WinEvent -LogName Application -MaxEvents 400 -ErrorAction SilentlyContinue | Where-Object { $_.ProviderName -like 'Rulebox*' -or $_.ProviderName -eq 'MsiInstaller' } | Select-Object -First 30 | ForEach-Object { "$($_.TimeCreated.ToString('HH:mm:ss')) $($_.ProviderName) $($_.Id) $($_.LevelDisplayName): $(($_.Message -replace '\s+',' ').Substring(0,[math]::Min(300,($_.Message -replace '\s+',' ').Length)))" }
$o | Set-Content "C:\rb-run\out\$Tag-checks.txt"
"$Tag-checks lines=$($o.Count)"
