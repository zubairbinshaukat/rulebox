param([string]$Tag)
# Runs C:\rb-run\in\<Tag>.json {exe,args}, waits, writes C:\rb-run\out\<Tag>.txt.
$j = Get-Content "C:\rb-run\in\$Tag.json" -Raw | ConvertFrom-Json
$start = Get-Date
$who = whoami; $sess = (Get-Process -Id $PID).SessionId
$elev = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
try {
  if ($j.args) { $p = Start-Process -FilePath $j.exe -ArgumentList $j.args -PassThru -Wait -ErrorAction Stop }
  else { $p = Start-Process -FilePath $j.exe -PassThru -Wait -ErrorAction Stop }
  $code = $p.ExitCode
} catch { $code = "start failed: $($_.Exception.Message)" }
$end = Get-Date
"tag=$Tag who=$who session=$sess elevated=$elev`nexe=$($j.exe)`nargs=$($j.args)`nstart=$($start.ToString('HH:mm:ss')) end=$($end.ToString('HH:mm:ss')) seconds=$([math]::Round(($end-$start).TotalSeconds,1)) exit=$code" | Set-Content "C:\rb-run\out\$Tag.txt"
