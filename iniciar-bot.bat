@echo off
cd /d "%~dp0"
set REQUIRE_LICENSE=1
set PORT=3100
set PANEL_PASSWORD=momonga
if "%CLOUD_URL%"=="" set CLOUD_URL=https://mimomonga.uk
"%~dp0node\node.exe" server.js
