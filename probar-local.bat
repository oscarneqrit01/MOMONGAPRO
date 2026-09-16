@echo off
title MOMONGA PRO - Prueba local
cd /d "%~dp0"

set PANEL_PASSWORD=prueba-local
set PORT=3001
set CONFIG_PATH=%~dp0config.test.json

start "MOMONGA TEST SITE" /D "%~dp0" cmd /k node mock-site.js
node server.js
pause
