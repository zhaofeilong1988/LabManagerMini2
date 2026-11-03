$p = 'd:\miniapp\LabManagerMini2\prototype.html'
$c = [IO.File]::ReadAllText($p)
$map = [ordered]@{
  '#1B5270'     = '#0A7BB8';  # 旧深蓝主色 -> 新主色
  '#03A9F4'     = '#33ADDE';  # 旧强调色 -> 新强调色
  '#1976D2'     = '#0A7BB8';  # 蓝700文字 -> 新主色
  '#2E9BFF'     = '#33ADDE';  # 预约按钮渐变亮端 -> 新亮端
  '#0E6CB8'     = '#0A7BB8';  # 预约按钮渐变暗端 -> 新暗端
  '#C3E7FF'     = '#C9E9FA';  # 浅蓝底 -> 新primary容器
  '#E3F2FD'     = '#C9E9FA';  # 蓝50浅底 -> 新primary容器
  '#1B3A50'     = '#0E3A50';  # 深蓝小标题 -> 新on-primary-container
  '#F5F9FC'     = '#F5FAFD';  # 页面背景 -> 新背景
  'rgba(27, 82, 112,' = 'rgba(10, 123, 184,'
  'rgba(27,82,112,'    = 'rgba(10,123,184,'
  'rgb(27, 82, 112)'   = 'rgb(10, 123, 184)'
  'rgb(27,82,112)'     = 'rgb(10,123,184)'
  'rgba(14, 108, 184,' = 'rgba(10, 123, 184,'
  'rgba(14,108,184,'   = 'rgba(10,123,184,'
}
foreach ($k in $map.Keys) {
  $c = [regex]::Replace($c, [regex]::Escape($k), $map[$k], 'IgnoreCase')
}
[IO.File]::WriteAllText($p, $c, (New-Object System.Text.UTF8Encoding($false)))
Write-Host ('prototype.html synced, length=' + $c.Length)
