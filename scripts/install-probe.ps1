# install-probe.ps1 -- install the Windows-side probe as a resident process
$ErrorActionPreference = 'Continue'
$probe = 'D:\toagi\dotd\scripts\dotd-probe.ps1'
if (-not (Test-Path $probe)) { Write-Host "missing $probe"; exit 1 }

Write-Host "=== 1. stop existing probe ==="
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*dotd-probe*' } |
    ForEach-Object {
        Write-Host "  stop PID $($_.ProcessId)"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

Write-Host ""
Write-Host "=== 2. write startup item ==="
$startup = [Environment]::GetFolderPath('Startup')
$cmdPath = Join-Path $startup 'dotd-probe.cmd'
$cmdContent = "@echo off`r`npowershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$probe`" -LoopSeconds 60"
Set-Content -Path $cmdPath -Value $cmdContent -Encoding Default
Write-Host "  wrote $cmdPath"

Write-Host ""
Write-Host "=== 3. start probe now (hidden, resident) ==="
$probeArgs = @('-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', $probe, '-LoopSeconds', '60')
Start-Process -FilePath 'powershell.exe' -ArgumentList $probeArgs -WindowStyle Hidden
Start-Sleep -Seconds 6

Write-Host ""
Write-Host "=== 4. confirm running ==="
$procs = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*dotd-probe*' }
if ($procs) { foreach ($x in $procs) { Write-Host "  PID $($x.ProcessId) running" } }
else { Write-Host "  !! not running" }

Write-Host ""
Write-Host "=== 5. probe log (last 5) ==="
$log = Join-Path $env:TEMP 'dotd-probe.log'
if (Test-Path $log) { Get-Content $log -Tail 5 } else { Write-Host "  (no log)" }