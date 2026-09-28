@echo off
rem Run the bullet vs. water balloon simulation on Windows: double-click this file.
rem Starts a local server with Python 3 and opens the page in your browser. Close this window to stop.
setlocal
title Bullet vs. Water Balloon
pushd "%~dp0"
set "CHECK=import sys; sys.exit(sys.version_info < (3, 7))"
set "PY="
py -3 -c "%CHECK%" >nul 2>&1 && set "PY=py -3"
if not defined PY python -c "%CHECK%" >nul 2>&1 && set "PY=python"
if not defined PY python3 -c "%CHECK%" >nul 2>&1 && set "PY=python3"
if not defined PY goto nopython
%PY% run.py %*
if errorlevel 1 pause
popd
exit /b

:nopython
echo Python 3.7 or newer was not found, so the page will open straight from disk instead.
echo To run it through the local server, install Python from https://www.python.org
start "" "%~dp0water_balloon.html"
popd
timeout /t 10 >nul 2>&1
