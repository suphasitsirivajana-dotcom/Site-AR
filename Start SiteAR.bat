@echo off
chcp 65001 >nul
title SiteAR - local server
cd /d "%~dp0sitear"
echo.
echo   SiteAR is running at  http://localhost:5173
echo   Keep this window open while testing. Close it to stop.
echo.
start "" http://localhost:5173
python -m http.server 5173
pause
