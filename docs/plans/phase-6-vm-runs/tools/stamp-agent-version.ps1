param([Parameter(Mandatory)][string]$In, [Parameter(Mandatory)][string]$Out, [string]$From = '0.1.1', [Parameter(Mandatory)][string]$To)
# Run A2 item 9: makes a test copy of a release rulebox-agent.exe that reports another version, for an agent-driven
# upgrade test (then: apps\installer\build.ps1 -BinDir <dir> -Version $To). Test copies only, never a release.
# Same length only (x.y.z with one-digit parts). Patches BOTH forms the compiler emits:
#  - the string itself ("0.1.1" next to other literals), and
#  - inlined copies: `mov dword [rax],"0.1."` + `mov byte [rax+4],'1'` (C6 40 04 xx C7 00 + 4 bytes).
# Run A2 first patched only the 2 strings: --version said 0.1.2 but `status` and self-update still said 0.1.1,
# so the update was recorded did_not_take.
$ErrorActionPreference = 'Stop'
if ($From.Length -ne 5 -or $To.Length -ne 5) { throw 'x.y.z with one-digit parts only' }
$b = [IO.File]::ReadAllBytes($In)
$f = [Text.Encoding]::ASCII.GetBytes($From); $t = [Text.Encoding]::ASCII.GetBytes($To)
$strings = 0; $inline = 0
for ($i = 6; $i -lt $b.Length - 8; $i++) {
  # The string: the 5 bytes, not followed by another digit (so 0.1.12 is left alone).
  if ($b[$i] -eq $f[0] -and $b[$i+1] -eq $f[1] -and $b[$i+2] -eq $f[2] -and $b[$i+3] -eq $f[3] -and $b[$i+4] -eq $f[4] -and
      -not ($b[$i+5] -ge 0x30 -and $b[$i+5] -le 0x39) -and -not ($b[$i-1] -ge 0x30 -and $b[$i-1] -le 0x39) -and $b[$i-1] -ne 0x2D) {
    for ($k = 0; $k -lt 5; $k++) { $b[$i+$k] = $t[$k] }; $strings++
  }
  # The inlined form: C6 40 04 <last> C7 00 <first four>.
  elseif ($b[$i-6] -eq 0xC6 -and $b[$i-5] -eq 0x40 -and $b[$i-4] -eq 0x04 -and $b[$i-3] -eq $f[4] -and $b[$i-2] -eq 0xC7 -and $b[$i-1] -eq 0x00 -and
          $b[$i] -eq $f[0] -and $b[$i+1] -eq $f[1] -and $b[$i+2] -eq $f[2] -and $b[$i+3] -eq $f[3]) {
    $b[$i-3] = $t[4]; for ($k = 0; $k -lt 4; $k++) { $b[$i+$k] = $t[$k] }; $inline++
  }
}
[IO.File]::WriteAllBytes($Out, $b)
"strings=$strings inlined=$inline (run A2's 0.1.1 agent: 2 and 7). Check the count, then build the MSI."
