@echo off
title MOMONGA MEGA
cd /d "%~dp0"
set REQUIRE_LICENSE=1
set PORT=3100
set PANEL_PASSWORD=momonga
if "%CLOUD_URL%"=="" set CLOUD_URL=https://mimomonga.uk

rem Abre la app en una VENTANA tipo app (espera a que arranque el bot)
start "" /min "%~dp0abrir-app.bat"

rem Arranca el bot
"%~dp0node\node.exe" server.js
pause
