@echo off
rem DeepSeek Harness Connector - double-click installer for Windows.
rem Runs install.ps1 beside this file with the execution policy relaxed for this one process only,
rem so a user who has never opened PowerShell does not have to. Everything it does is in install.ps1.
rem Unofficial community project by Corsen AI, not affiliated with DeepSeek.

setlocal
set "HERE=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%install.ps1" %*
set "CODE=%ERRORLEVEL%"
echo.
if not "%CODE%"=="0" echo The installer reported an error (code %CODE%).
pause
exit /b %CODE%
