@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -NonInteractive -File "%~dp0scripts\local-service.ps1" -Action Stop
if errorlevel 1 pause
