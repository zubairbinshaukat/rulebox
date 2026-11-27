param([string]$Out = 'C:\rb-run\out\a3-poll.txt', [int]$Minutes = 45)
# Run A3 items 2-4: every 2 s, one line: msiexec processes, agent `status` shell/kiosk lines, the Staff session's
# rulebox-shell.exe / rulebox-staff.exe (pid + image path) and Install\Version. Runs as SYSTEM (scheduled task),
# so `msiexec exit -> working Staff App` can be timed from the file. Read-only.
$end = (Get-Date).AddMinutes($Minutes)
$agent = 'C:\Program Files\Rulebox\rulebox-agent.exe'
while ((Get-Date) -lt $end) {
  $t = Get-Date -Format 'HH:mm:ss'
  $msi = @(Get-CimInstance Win32_Process -Filter "Name='msiexec.exe'" | ForEach-Object { "$($_.ProcessId):$(if ($_.CommandLine -match '/i|/x|/package') { 'job' } else { 'svc' })" }) -join ','
  $st = if (Test-Path $agent) { (& $agent status 2>&1 | Select-String '^(agent version|shell|kiosk)\s*:' | ForEach-Object { ($_.Line -replace '\s+', ' ').Trim() }) -join ' | ' } else { 'no agent exe' }
  $procs = @(Get-CimInstance Win32_Process -Filter "Name='rulebox-shell.exe' or Name='rulebox-staff.exe'" | ForEach-Object { "$($_.Name -replace 'rulebox-','' -replace '\.exe','')#$($_.ProcessId)@s$($_.SessionId)=$($_.ExecutablePath -replace '^C:\\Program Files\\Rulebox\\','')" }) -join ' '
  $ver = (Get-ItemProperty HKLM:\SOFTWARE\Rulebox\Install -Name Version -ErrorAction SilentlyContinue).Version
  "$t msi=[$msi] ver=$ver | $st | $procs" | Add-Content $Out
  Start-Sleep 2
}
