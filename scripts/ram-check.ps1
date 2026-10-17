$os = Get-CimInstance Win32_OperatingSystem
"FreeGB=$([math]::Round($os.FreePhysicalMemory/1MB,1)) TotalGB=$([math]::Round($os.TotalVisibleMemorySize/1MB,1))"
$colibri = Get-Process -Name "colibri*","coli*" -ErrorAction SilentlyContinue | Select-Object -First 3 | ForEach-Object { "$($_.ProcessName) RSS=$([math]::Round($_.WorkingSet64/1MB))MB" }
if ($colibri) { $colibri } else { "NO_COLIBRI_PROCESS" }
