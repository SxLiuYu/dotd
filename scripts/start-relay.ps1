# Start the Windows-side TCP relay (win-relay.mts), no self-retire.
# Usage from anywhere: powershell -File scripts\start-relay.ps1
# Re-running spawns another process; the old one keeps 13065/18001, the new one
# only logs its listen failure and stays alive (idempotent re-entry).
$env:RELAY_TTL_MS = '0'
# PowerShell 5.1 Start-Process bug: a case-differing duplicate env key
# (NO_PROXY vs no_proxy) makes the child env block throw
# "dictionary key already added". Drop the lowercase copies first.
foreach ($k in @('no_proxy', 'http_proxy', 'https_proxy', 'all_proxy', 'ftp_proxy')) {
  if ([Environment]::GetEnvironmentVariable($k.ToUpper(), 'Process') -ne $null) {
    Remove-Item -LiteralPath ("Env:" + $k) -ErrorAction SilentlyContinue
  }
}
# cwd must be the package root: `--import tsx` resolves from cwd's node_modules.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
Set-Location $root
$script = Join-Path $here 'win-relay.mts'
Start-Process -WindowStyle Hidden -FilePath node `
  -ArgumentList '--import','tsx',$script `
  -RedirectStandardOutput "$env:USERPROFILE\.dotd\win-relay.log" `
  -RedirectStandardError "$env:USERPROFILE\.dotd\win-relay.err.log"
