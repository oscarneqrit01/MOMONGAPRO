@echo off
title MOMONGA PRO Server
cd /d "%~dp0"
REM Cambia "momonga" por tu contraseña segura del panel
set PANEL_PASSWORD=momonga
echo 🚀 Encendiendo el panel MOMONGA PRO...
node server.js
pause
