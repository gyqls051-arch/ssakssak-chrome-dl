@echo off
chcp 65001 >nul
title SsakSsak - Install ffmpeg
cd /d "%~dp0"
echo Downloading ffmpeg (yt-dlp recommended static build) into ~/.ssakssak/ffmpeg ...
echo.
where python >nul 2>nul
if %errorlevel%==0 (
  python helper.py setup-ffmpeg
) else (
  py helper.py setup-ffmpeg
)
echo.
pause
