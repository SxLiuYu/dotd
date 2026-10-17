Start-Process -FilePath 'C:\Program Files\Git\bin\bash.exe' -ArgumentList '-lc "/c/Users/1/colibri/start-colibri.sh olmoe >> /c/Users/1/.dotd/olmoe.log 2>&1"' -WindowStyle Hidden
Start-Sleep -Seconds 3
$p = Get-Process -Name "python*","olmoe*","coli*" -ErrorAction SilentlyContinue | Select-Object -First 5 | ForEach-Object { "$($_.ProcessName):$($_.Id)" }
if ($p) { "LAUNCHED: $p" } else { "NOT_VISIBLE_YET" }
