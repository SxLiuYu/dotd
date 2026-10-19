param(
    [int]$LoopSeconds = 0,
    [string]$LogPath = "$env:TEMP\dotd-probe.log"
)
$ErrorActionPreference = 'Continue'
$StateDir = Join-Path $env:TEMP 'dotd-probe-state'
if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Path $StateDir -Force | Out-Null }
$FailThreshold = 3
$CooldownSec = 1800

function Write-Log([string]$msg) {
    # 用 [IO.File]::AppendAllText 而不是 Add-Content：
    # 2026-10-19 实测踩坑 —— 计划任务每分钟拉起一个探针，Add-Content 在并发时
    # 会因文件被占用抛异常，而异常发生在函数内**静默中断了整个 Invoke-Check**，
    # 表现为"心跳日志从来没出现过、但检查逻辑看起来在跑"。
    # AppendAllText 用 FileShare.ReadWrite，不会互相踩。
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    try {
        [System.IO.File]::AppendAllText($LogPath, $line + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
    } catch {
        # 日志写失败不能影响检查本身
    }
    Write-Host $line
}

function Test-Port([int]$port, [int]$timeoutMs = 3000) {
    # 注意：必须保证**所有路径都返回布尔值**。2026-10-19 实测踩坑：
    # ConnectAsync 抛异常时走进 catch，但若在 try 内先算 $connected 再 return，
    # 异常发生时 $connected 仍未赋值（$null），`$ok -and $null` 得到 $null，
    # 调用方 `if ($probeOk)` 会把 $null 当作**真** —— 于是探针在故障时静默通过。
    # 现在显式在每个出口给 [bool]。
    $client = $null
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $task = $client.ConnectAsync('127.0.0.1', $port)
        if (-not $task.Wait($timeoutMs)) { return [bool]$false }
        return [bool]$client.Connected
    } catch {
        return [bool]$false
    } finally {
        if ($null -ne $client) { try { $client.Close() } catch { } }
    }
}

function Get-Counter2([string]$name) {
    $f = Join-Path $StateDir "$name.cnt"
    if (Test-Path $f) { $raw = (Get-Content $f -Raw -ErrorAction SilentlyContinue); if ($null -ne $raw) { return [int]$raw.Trim() } }
    return 0
}
function Set-Counter2([string]$name, [int]$v) { Set-Content -Path (Join-Path $StateDir "$name.cnt") -Value $v -Encoding UTF8 }
function Get-State2([string]$name) {
    $f = Join-Path $StateDir "$name.state"
    if (Test-Path $f) { $raw = (Get-Content $f -Raw -ErrorAction SilentlyContinue); if ($null -ne $raw) { return $raw.Trim() } }
    return 'ok'
}
function Set-State2([string]$name, [string]$v) { Set-Content -Path (Join-Path $StateDir "$name.state") -Value $v -Encoding UTF8 }
function Get-LastAlert([string]$name) {
    $f = Join-Path $StateDir "$name.last"
    if (Test-Path $f) { $raw = (Get-Content $f -Raw -ErrorAction SilentlyContinue); if ($null -ne $raw) { return [long]$raw.Trim() } }
    return 0
}
function Set-LastAlert([string]$name) {
    $epoch = [DateTimeOffset]::Now.ToUnixTimeSeconds()
    Set-Content -Path (Join-Path $StateDir "$name.last") -Value $epoch -Encoding UTF8
}

function Send-Feishu([string]$text) {
    $tokenFile = '\\wsl.localhost\Ubuntu-24.04\root\dotd\_tokens_src.env'
    $appId = $null; $appSecret = $null; $chatId = $null
    try {
        foreach ($line in (Get-Content $tokenFile -ErrorAction Stop)) {
            if ($line -match '^\s*FEISHU_APP_ID=(.+)$') { $appId = $Matches[1].Trim() }
            elseif ($line -match '^\s*FEISHU_APP_SECRET=(.+)$') { $appSecret = $Matches[1].Trim() }
            elseif ($line -match '^\s*FEISHU_OWNER_CHAT_ID=(.+)$') { $chatId = ($Matches[1].Trim() -split ',')[0] }
        }
    } catch {
        Write-Log "  [ALERT] cannot read credentials: $text"
        return $false
    }
    if ((-not $appId) -or (-not $appSecret) -or (-not $chatId)) { Write-Log "  [ALERT] credentials incomplete"; return $false }
    try {
        $tokBody = @{ app_id = $appId; app_secret = $appSecret } | ConvertTo-Json
        $tokResp = Invoke-RestMethod -Method Post -Uri 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal' -ContentType 'application/json; charset=utf-8' -Body $tokBody -TimeoutSec 15
        if ($tokResp.code -ne 0) { Write-Log "  [ALERT] token failed"; return $false }
        $inner = @{ text = $text } | ConvertTo-Json -Compress
        $msgBody = @{ receive_id = $chatId; msg_type = 'text'; content = $inner } | ConvertTo-Json -Compress
        $headers = @{ Authorization = ("Bearer " + $tokResp.tenant_access_token) }
        $r = Invoke-RestMethod -Method Post -Uri 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id' -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $msgBody -TimeoutSec 20
        if ($r.code -eq 0) { Write-Log '  Feishu alert delivered'; return $true }
        Write-Log "  [ALERT] send failed code=$($r.code)"
        return $false
    } catch { Write-Log "  [ALERT] exception: $($_.Exception.Message)"; return $false }
}

function Repair-Daemon([bool]$wslAlive) {
    Write-Log '  self-heal: restarting daemon'
    try {
        if ($wslAlive) {
            $out = & wsl.exe -d Ubuntu-24.04 -u root -e bash /usr/local/bin/dotd-boot.sh 2>&1
            Write-Log "  boot output: $($out -join ' | ')"
        } else {
            Write-Log '  WSL unresponsive; wsl --shutdown then restart'
            & wsl.exe --shutdown 2>&1 | Out-Null
            Start-Sleep -Seconds 8
            & wsl.exe -d Ubuntu-24.04 -e bash -lc 'echo up' 2>&1 | Out-Null
        }
    } catch { Write-Log "  self-heal exception: $($_.Exception.Message)" }
    for ($i = 0; $i -lt 45; $i++) {
        Start-Sleep -Seconds 2
        if (Test-Port 7788) { Write-Log "  self-heal OK ($($i * 2)s)"; return $true }
    }
    Write-Log '  self-heal failed'
    return $false
}

function Invoke-Check {
    $now = [DateTimeOffset]::Now.ToUnixTimeSeconds()
    $daemonOk = Test-Port 7788
    $wslAlive = $false
    try {
        $probe = & wsl.exe -d Ubuntu-24.04 -e echo alive 2>&1
        $wslAlive = (($probe -join '') -match 'alive')
    } catch { $wslAlive = $false }

    if ($daemonOk) {
        # 心跳：健康时也要留痕。否则"在正常运行"和"进程假死"从日志上无法区分
        # ——2026-10-19 实测过这个困惑：探针在跑，但日志停在几小时前，看不出死活。
        # 只做轻量记录（一行），60 秒一次不会撑爆日志。
        Write-Log "  heartbeat ok (wslAlive=$wslAlive)"
        $cnt = Get-Counter2 'daemon'
        if ((Get-State2 'daemon') -eq 'alerting') {
            $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
            Send-Feishu "dotd recovered: daemon port 7788 reachable again (was failing $cnt times). Time: $ts" | Out-Null
            Set-State2 'daemon' 'ok'
            Write-Log '  daemon recovered'
        }
        Set-Counter2 'daemon' 0
        return $true
    }

    $cnt = (Get-Counter2 'daemon') + 1
    Set-Counter2 'daemon' $cnt
    Write-Log "  daemon unreachable (attempt $cnt); wslAlive=$wslAlive"

    if ($cnt -ge $FailThreshold) {
        $repaired = Repair-Daemon $wslAlive
        if ($repaired) {
            if ((Get-State2 'daemon') -eq 'alerting') {
                $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
                Send-Feishu "dotd auto-healed (had failed $cnt times). Time: $ts" | Out-Null
                Set-State2 'daemon' 'ok'
            }
            Set-Counter2 'daemon' 0
            return $true
        }
        $last = Get-LastAlert 'daemon'
        if (($now - $last) -ge $CooldownSec) {
            if ($wslAlive) { $why = 'WSL alive but daemon will not start' } else { $why = 'WSL entirely unresponsive' }
            $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
            $msg = "dotd ALERT: daemon port 7788 unreachable. Cause: $why. Failed $cnt times; self-heal did not succeed. Time: $ts. (Sent by the Windows-side probe -- the in-WSL watchdog may be unable to alert.)"
            Send-Feishu $msg | Out-Null
            Set-State2 'daemon' 'alerting'
            Set-LastAlert 'daemon'
        }
    }
    return $false
}

Write-Log "===== probe started (LoopSeconds=$LoopSeconds) ====="
if ($LoopSeconds -le 0) {
    Invoke-Check | Out-Null
    Write-Log '===== single check done ====='
    exit 0
}
while ($true) {
    try { Invoke-Check | Out-Null } catch { Write-Log "check exception: $($_.Exception.Message)" }
    Start-Sleep -Seconds $LoopSeconds
}