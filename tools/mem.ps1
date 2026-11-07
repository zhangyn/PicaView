# 按 PID 树统计 PicaView + WebView2 子进程的专用工作集（任务管理器口径）
param([int]$RootPid = 0)
if ($RootPid -eq 0) { $RootPid = (Get-Process picaview -ErrorAction Stop).Id }

$all = Get-CimInstance Win32_Process
$ids = @{}
$ids[$RootPid] = 'picaview(root)'
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($p in $all) {
    if (-not $ids.ContainsKey([int]$p.ProcessId) -and $ids.ContainsKey([int]$p.ParentProcessId) -and
        ($p.Name -eq 'msedgewebview2.exe' -or $p.Name -eq 'picaview.exe')) {
      $ids[[int]$p.ProcessId] = $p.Name
      $changed = $true
    }
  }
}

$cat = New-Object System.Diagnostics.PerformanceCounterCategory('Process')
$total = 0.0
foreach ($inst in $cat.GetInstanceNames()) {
  try {
    $idc = New-Object System.Diagnostics.PerformanceCounter('Process', 'ID Process', $inst, $true)
    $p = [int]$idc.NextValue()
    $idc.Dispose()
    if ($ids.ContainsKey($p)) {
      $wsc = New-Object System.Diagnostics.PerformanceCounter('Process', 'Working Set - Private', $inst, $true)
      $mb = [math]::Round($wsc.NextValue() / 1MB, 1)
      $wsc.Dispose()
      $total += $mb
      Write-Output ("{0,-18} PID {1,-7} {2,8} MB" -f $inst, $p, $mb)
    }
  } catch { }
}
Write-Output ("合计(任务管理器口径): {0} MB" -f [math]::Round($total, 1))
