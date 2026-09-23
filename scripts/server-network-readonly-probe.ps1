param([string]$Target = $env:RUNBOOK_LIVE_HOST)
$ErrorActionPreference = 'Stop'
$address = $null
if (![Net.IPAddress]::TryParse($Target, [ref]$address) -or $address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or $address.ToString() -ne $Target) {
  throw '网络只读探针需要显式 IPv4 目标。'
}
# 只检查该目标的实际选路；地址、接口名称和错误正文不进入输出。
try {
  $route = Find-NetRoute -RemoteIPAddress $Target -ErrorAction Stop 2>$null | Select-Object -First 1
  $iface = Get-NetIPInterface -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4 -ErrorAction Stop 2>$null | Select-Object -First 1
  $adapter = Get-NetAdapter -InterfaceIndex $route.InterfaceIndex -ErrorAction Stop 2>$null
  $kind = if ($adapter.InterfaceDescription -match 'ZeroTier') { 'ZeroTier' } elseif ($adapter.InterfaceDescription -match 'Tailscale') { 'Tailscale' } elseif ($adapter.InterfaceDescription -match 'WireGuard') { 'WireGuard' } elseif ($adapter.InterfaceDescription -match 'TAP') { 'TAP' } else { 'other' }
  [pscustomobject]@{feature='local-route';adapterKind=$kind;mtu=$iface.NlMtu;connected=($iface.ConnectionState -eq 'Connected')} | ConvertTo-Json -Compress
} catch { [pscustomobject]@{feature='local-route';status='unavailable'} | ConvertTo-Json -Compress }
$ping = [Net.NetworkInformation.Ping]::new()
try {
  # 固定十六次交错探测，每次最多等待二点五秒；不修改 MTU、路由或服务设置。
  for ($round = 0; $round -lt 4; $round++) {
    $sizes = if (($round % 2) -eq 0) { @(32,1200,2000,2700) } else { @(2700,2000,1200,32) }
    foreach ($size in $sizes) {
      try {
        $reply = $ping.Send($Target,2500,[byte[]]::new($size),[Net.NetworkInformation.PingOptions]::new(128,$true))
        [pscustomobject]@{feature='target-icmp-interleaved';round=$round;payloadBytes=$size;status=$reply.Status.ToString();rttMs=$reply.RoundtripTime} | ConvertTo-Json -Compress
      } catch { [pscustomobject]@{feature='target-icmp-interleaved';round=$round;payloadBytes=$size;status='unavailable'} | ConvertTo-Json -Compress }
    }
  }
} finally { $ping.Dispose() }
