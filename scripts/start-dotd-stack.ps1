# start-dotd-stack.ps1 —— Windows 侧启动脚本（2026-10-19）
#
# 由计划任务在登录时调用。负责启动 WSL 之外的两样东西：
#   ① agent2api（模型服务，监听 127.0.0.1:3065）
#   ② win-relay（把 WSL 的 13065 转发到 3065）
#
# 幂等：已在跑就跳过。日志写 %TEMP%\dotd-stack.log。

$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'dotd-stack.log'

function Write-Log([string]$msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    Add-Content -Path $log -Value $line -Encoding UTF8
    Write-Host $line
}

function Test-Port([int]$port) {
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $t = $c.BeginConnect('127.0.0.1', $port, $null, $null)
        $ok = $t.AsyncWaitHandle.WaitOne(1000)
        if ($ok) { $c.EndConnect($t) }
        $c.Close()
        return $ok
    } catch {
        return $false
    }
}

Write-Log "===== 启动 dotd 栈 ====="

# ① agent2api
$agent = Get-Process -Name 'agent2api' -ErrorAction SilentlyContinue
if (-not $agent) {
    $exe = 'C:\Program Files\Agent2API\agent2api.exe'
    if (Test-Path $exe) {
        Write-Log "启动 agent2api..."
        Start-Process -FilePath $exe -WindowStyle Hidden
        $ready = $false
        for ($i = 0; $i -lt 20; $i++) {
            Start-Sleep -Seconds 2
            if (Test-Port 3065) { Write-Log "  agent2api 就绪（$($i * 2)s）"; $ready = $true; break }
        }
        if (-not $ready) { Write-Log "  !! agent2api 40s 未监听 3065" }
    } else {
        Write-Log "!! 找不到 $exe"
    }
} else {
    Write-Log "agent2api 已在运行（PID $($agent.Id)）"
}

# ② win-relay
$relay = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*win-relay*' }
if (-not $relay) {
    $repo = 'D:\toagi\dotd'
    $relayScript = Join-Path $repo 'scripts\win-relay.mts'
    if (Test-Path $relayScript) {
        Write-Log "启动 win-relay..."
        # **必须设 RELAY_TTL_MS=0**：relay 默认 1 小时后自退（防僵尸进程的设计），
        # 但它一退，daemon 的所有模型调用就失败 → 触发熔断 → 任务全部 paused。
        # 2026-10-19 实测：relay 在 08:01 启动、约 09:01 自退，健康检查 3 项全挂。
        # 常驻是本场景的正确选择（它只是个 TCP 转发器，不占资源）。
        $env:RELAY_TTL_MS = '0'
        Start-Process -FilePath 'node' `
            -ArgumentList '--import', 'tsx', 'scripts/win-relay.mts' `
            -WorkingDirectory $repo -WindowStyle Hidden
        $ready = $false
        for ($i = 0; $i -lt 10; $i++) {
            Start-Sleep -Seconds 2
            if (Test-Port 13065) { Write-Log "  relay 就绪（$($i * 2)s）"; $ready = $true; break }
        }
        if (-not $ready) { Write-Log "  !! relay 20s 未监听 13065" }
    } else {
        Write-Log "!! 找不到 $relayScript"
    }
} else {
    Write-Log "win-relay 已在运行（PID $($relay.ProcessId)）"
}

# ③ 拉起 WSL（触发 /etc/wsl.conf 的 boot command → dotd-boot.sh）
Write-Log "触发 WSL 启动..."
& wsl.exe -d Ubuntu-24.04 -e bash -lc 'echo wsl-up' 2>&1 | ForEach-Object { Write-Log "  wsl: $_" }

Write-Log "===== 完成 ====="
