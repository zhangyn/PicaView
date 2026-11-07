# 从"最近使用"快捷方式解析用户打开过的图片文件路径
$shell = New-Object -ComObject WScript.Shell
$recent = [Environment]::GetFolderPath('Recent')
$items = Get-ChildItem $recent -Filter *.lnk | Sort-Object LastWriteTime -Descending | Select-Object -First 40
foreach ($it in $items) {
  try {
    $t = $shell.CreateShortcut($it.FullName).TargetPath
    if ($t -match '\.(jpg|jpeg|png|bmp|gif|webp)$') {
      Write-Output ("{0}  {1}" -f $it.LastWriteTime.ToString('MM-dd HH:mm'), $t)
    }
  } catch {}
}
