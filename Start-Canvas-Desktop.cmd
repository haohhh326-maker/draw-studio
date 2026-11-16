@echo off
cd /d "%~dp0"
node scripts\start.cjs --no-open
if errorlevel 1 goto failed
call npm run desktop:live
if errorlevel 1 goto failed
exit /b 0
:failed
pause
