Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class W2 {
  public delegate bool EnumProc(IntPtr h, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder sb, int n);
}
'@

$target = $args[0]
$script:kids = @()

$childCb = [W2+EnumProc]{
  param($c, $l2)
  $sb = New-Object System.Text.StringBuilder 256
  [W2]::GetWindowText($c, $sb, 256) | Out-Null
  $txt = $sb.ToString()
  if ($txt) {
    $cn = New-Object System.Text.StringBuilder 64
    [W2]::GetClassName($c, $cn, 64) | Out-Null
    $script:kids += ($cn.ToString() + ' = ' + $txt)
  }
  return $true
}

$cb = [W2+EnumProc]{
  param($h, $lp)
  [uint32]$procId = 0
  [W2]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
  if ([int]$procId -eq $target) {
    $sb = New-Object System.Text.StringBuilder 256
    [W2]::GetWindowText($h, $sb, 256) | Out-Null
    $script:kids = @()
    [W2]::EnumChildWindows($h, $childCb, [IntPtr]::Zero) | Out-Null
    Write-Output ("窗口 [" + $sb.ToString() + "] 控件: " + ($script:kids -join " | "))
  }
  return $true
}
[W2]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
