param([string]$Root = 'C:\rb-deploy', [int]$Port = 8443, [string]$Log = 'C:\rb-run\out\a2-09-serve.log')
# Run A2 item 9: serves the test MSIs at https://localhost:<Port>/<file> inside the VM only, so the agent's
# self-update can download them without publishing anything. The certificate is a self-signed "localhost"
# one, trusted only in this VM's LocalMachine\Root (setup in Setup-Serve below). Runs as SYSTEM (scheduled task).
$ErrorActionPreference = 'Stop'
$l = New-Object System.Net.HttpListener
$l.Prefixes.Add("https://localhost:$Port/")
$l.Start()
"$(Get-Date -Format o) listening on $Port" | Add-Content $Log
while ($l.IsListening) {
  $c = $l.GetContext()
  $name = [IO.Path]::GetFileName($c.Request.Url.AbsolutePath)
  $path = Join-Path $Root $name
  if ($name -like '*.msi' -and (Test-Path -LiteralPath $path)) {
    $bytes = [IO.File]::ReadAllBytes($path)
    $c.Response.ContentType = 'application/x-msi'
    $c.Response.ContentLength64 = $bytes.Length
    $c.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $code = 200
  } else { $c.Response.StatusCode = 404; $code = 404 }
  $c.Response.Close()
  "$(Get-Date -Format o) $($c.Request.HttpMethod) $($c.Request.Url.AbsolutePath) ua=$($c.Request.UserAgent) -> $code" | Add-Content $Log
}
