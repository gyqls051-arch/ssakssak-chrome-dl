@echo off
chcp 65001 >nul
title SsakSsak - Register autostart (silent)
cd /d "%~dp0"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"

REM Point the Startup shortcut at the silent (no-window) launcher.
powershell -NoProfile -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%STARTUP%\SsakSsak-helper.lnk'); $s.TargetPath='%~dp0start_hidden.vbs'; $s.WorkingDirectory='%~dp0'; $s.Save()"

echo.
echo [done] Helper will auto-start SILENTLY (no window) on Windows login.
echo It is also starting now so you don't need to reboot.
echo To undo: delete SsakSsak-helper.lnk in:
echo   %STARTUP%
echo.

REM Start it right now too (silent), so it's available immediately.
start "" "%~dp0start_hidden.vbs"

echo Helper started in background. You can close this window.
timeout /t 4 >nul
