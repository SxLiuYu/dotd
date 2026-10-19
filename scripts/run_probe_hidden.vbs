' run_probe_hidden.vbs -- hidden wrapper for the dotd-probe health probe.
' Task Scheduler launches wscript.exe (GUI subsystem, no console window);
' Run(...,0,False) creates the powershell child hidden from the start,
' so no console window flashes every minute. Same trick as opencode2api.
' ASCII-only on purpose.
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File D:\toagi\dotd\scripts\dotd-probe.ps1", 0, False
