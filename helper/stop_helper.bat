@echo off
chcp 65001 >nul
title SsakSsak - Stop helper
REM Stop whatever is listening on the helper port (default 8787).
set FOUND=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8787 ^| findstr LISTENING') do (
  echo Stopping helper (PID %%a) ...
  taskkill /PID %%a /F >nul 2>nul
  set FOUND=1
)
if "%FOUND%"=="0" echo Helper was not running.
echo Done.
timeout /t 2 >nul
