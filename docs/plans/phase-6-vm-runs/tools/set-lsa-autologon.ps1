param([Parameter(Mandatory)][string]$User, [Parameter(Mandatory)][string]$Password)
# Run A2, item 8 (Phase 2 late fix 6): sets up the "owner already used LSA auto sign-in" case inside the VM,
# like Sysinternals Autologon does: Winlogon AutoAdminLogon=1 + DefaultUserName, and the password only as the
# LSA secret DefaultPassword (never as a plain registry value). VM only, never on the dev PC.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RbLsa {
  [StructLayout(LayoutKind.Sequential)] struct LSA_UNICODE_STRING { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct LSA_OBJECT_ATTRIBUTES { public int Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes; public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService; }
  [DllImport("advapi32.dll")] static extern uint LsaOpenPolicy(IntPtr system, ref LSA_OBJECT_ATTRIBUTES attrs, uint access, out IntPtr handle);
  [DllImport("advapi32.dll")] static extern uint LsaStorePrivateData(IntPtr handle, ref LSA_UNICODE_STRING key, ref LSA_UNICODE_STRING data);
  [DllImport("advapi32.dll")] static extern uint LsaClose(IntPtr handle);
  [DllImport("advapi32.dll")] static extern uint LsaNtStatusToWinError(uint status);
  static LSA_UNICODE_STRING Str(string s) { var u = new LSA_UNICODE_STRING(); u.Buffer = Marshal.StringToHGlobalUni(s); u.Length = (ushort)(s.Length * 2); u.MaximumLength = (ushort)(s.Length * 2 + 2); return u; }
  public static uint Store(string name, string value) {
    var attrs = new LSA_OBJECT_ATTRIBUTES(); attrs.Length = Marshal.SizeOf(attrs);
    IntPtr h; uint st = LsaOpenPolicy(IntPtr.Zero, ref attrs, 0x20, out h); // POLICY_CREATE_SECRET
    if (st != 0) return LsaNtStatusToWinError(st);
    var k = Str(name); var d = Str(value);
    st = LsaStorePrivateData(h, ref k, ref d);
    Marshal.FreeHGlobal(k.Buffer); Marshal.FreeHGlobal(d.Buffer); LsaClose(h);
    return LsaNtStatusToWinError(st);
  }
}
'@
$r = [RbLsa]::Store('DefaultPassword', $Password)
if ($r -ne 0) { throw "LsaStorePrivateData failed: $r" }
$w = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
Set-ItemProperty $w -Name AutoAdminLogon -Value '1'
Set-ItemProperty $w -Name DefaultUserName -Value $User
Set-ItemProperty $w -Name DefaultDomainName -Value $env:COMPUTERNAME
Remove-ItemProperty $w -Name DefaultPassword -ErrorAction SilentlyContinue
$pl = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\PasswordLess\Device'
if (-not (Test-Path $pl)) { New-Item $pl | Out-Null }
Set-ItemProperty $pl -Name DevicePasswordLessBuildVersion -Value 0 -Type DWord
"LSA auto sign-in set for $User (no plain DefaultPassword value)"
