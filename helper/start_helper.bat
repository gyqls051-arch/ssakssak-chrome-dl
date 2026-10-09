@echo off
chcp 65001 >nul
title SsakSsak Kimchi - Local Helper
cd /d "%~dp0"

REM Install yt-dlp on first run if missing
python -c "import yt_dlp" 2>nul || py -c "import yt_dlp" 2>nul
if errorlevel 1 (
  echo [first run] installing yt-dlp ...
  python -m pip install -r requirements.txt || py -m pip install -r requirements.txt
)

REM Run helper (prefer python, fallback to py launcher)
where python >nul 2>nul
if %errorlevel%==0 (
  python helper.py
) else (
  py helper.py
)

echo.
echo Helper stopped.
pause
