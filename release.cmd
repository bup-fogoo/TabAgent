@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\release.ps1" %*
set "releaseExit=%ERRORLEVEL%"
if "%~1"=="" pause
exit /b %releaseExit%
