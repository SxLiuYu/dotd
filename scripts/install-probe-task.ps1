# install-probe-task.ps1 -- 用 Windows 计划任务托管探针（2026-10-19）
#
# 为什么换掉自写守护者：
#   探针是常驻进程 -> 崩了就没人监控 -> 再写个守护者 -> 守护者崩了又没人管
#   这是无限递归。**正确的做法是把保活交给系统**：Windows 计划任务由系统调度，
#   探针每次跑完就退出，不存在"常驻进程崩溃"这个类别。
#
# 结构：
#   dotd-probe.ps1  -LoopSeconds 0    <- 单次检查后就退出（短命，不会累积状态）
#   计划任务：每 1 分钟触发一次，同一个时刻只允许一个实例
#
# 这样：
#   - 探针崩了？下次触发照跑，无需任何人重启它
#   - 探针卡住？MultipleInstances=IgnoreNew 保证不会堆积
#   - 机器重启后？StartWhenAvailable 会补跑

$ErrorActionPreference = 'Continue'
$probe = 'D:\toagi\dotd\scripts\dotd-probe.ps1'
$taskName = 'dotd-probe'

if (-not (Test-Path $probe)) { Write-Host "missing $probe"; exit 1 }

Write-Host "=== 1. 清理旧的常驻探针（如果有）==="
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*dotd-probe*' -or $_.CommandLine -like '*dotd-guardian*' } |
    ForEach-Object {
        Write-Host "  stop PID $($_.ProcessId)"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

Write-Host ""
Write-Host "=== 2. 删掉启动文件夹里的常驻探针项（改由计划任务负责）==="
$startup = [Environment]::GetFolderPath('Startup')
$probeCmd = Join-Path $startup 'dotd-probe.cmd'
if (Test-Path $probeCmd) {
    Remove-Item $probeCmd -Force
    Write-Host "  已删除 $probeCmd"
} else {
    Write-Host "  (无启动项)"
}

Write-Host ""
Write-Host "=== 3. 注册计划任务（每 1 分钟）==="
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$probe`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
try {
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description "dotd Windows-side health probe (runs outside WSL)" -Force -ErrorAction Stop | Out-Null
    Write-Host "  已注册 $taskName"
} catch {
    Write-Host "  !! 注册失败: $($_.Exception.Message)"
    exit 1
}

Write-Host ""
Write-Host "=== 4. 运行一次确认可用 ==="
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 12
$info = Get-ScheduledTaskInfo -TaskName $taskName
Write-Host "  LastRunTime: $($info.LastRunTime)"
Write-Host "  LastTaskResult: $($info.LastTaskResult)  (0 = 成功)"

Write-Host ""
Write-Host "=== 5. 任务状态 ==="
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State | Format-List

Write-Host "=== 6. 探针日志（最近 5 行）==="
$log = Join-Path $env:TEMP 'dotd-probe.log'
if (Test-Path $log) { Get-Content $log -Tail 5 } else { Write-Host "  (无日志)" }
