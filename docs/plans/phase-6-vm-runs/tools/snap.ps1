param([string]$Name)
# Install-footprint snapshot for Step 22 (sorted, no timestamps): files, registry, services, ARP, Start menu, tasks.
$out = @()
foreach ($r in 'C:\Program Files\Rulebox','C:\ProgramData\Rulebox','C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Rulebox','C:\Windows\System32\config\systemprofile\AppData\Local\Rulebox') {
  if (Test-Path $r) { $out += "PATH $r"; $out += Get-ChildItem $r -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object { 'FILE ' + $_.FullName } } else { $out += "NOPATH $r" }
}
foreach ($k in 'HKLM:\SOFTWARE\Rulebox','HKLM:\SOFTWARE\WOW6432Node\Rulebox') {
  if (Test-Path $k) { $out += Get-ChildItem $k -Recurse -ErrorAction SilentlyContinue | ForEach-Object { 'KEY ' + $_.Name; foreach ($p in $_.Property) { "VAL $($_.Name)\$p" } }; $out += "KEY $k"; $out += (Get-Item $k).Property | ForEach-Object { "VAL $k\$_" } } else { $out += "NOKEY $k" }
}
$out += Get-CimInstance Win32_Service | ForEach-Object { "SVC $($_.Name) | $($_.StartMode) | $($_.PathName)" }
foreach ($k in 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall') {
  $out += Get-ChildItem $k -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-ItemProperty $_.PSPath; "ARP $($_.PSChildName) | $($p.DisplayName) | $($p.DisplayVersion)" }
}
$out += Get-ScheduledTask | Where-Object TaskName -notlike 'rb-run-*' | ForEach-Object { "TASK $($_.TaskPath)$($_.TaskName)" }
$out += Get-ChildItem 'HKLM:\SYSTEM\CurrentControlSet\Services\EventLog\Application' | ForEach-Object { "EVSRC $($_.PSChildName)" }
$out += Get-ChildItem C:\Windows\Installer -Force -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in '.msi' } | ForEach-Object { 'CACHED ' + $_.Name }
$out | Sort-Object | Set-Content "C:\rb-run\out\snap-$Name.txt"
"snap-$Name lines=$($out.Count)"
