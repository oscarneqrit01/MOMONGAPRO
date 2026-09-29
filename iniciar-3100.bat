@echo off
title MOMONGA PRO (Renta) - puerto 3100
cd /d "%~dp0"
REM Panel en 3100 para que NO choque con el SaaS (que usa 3000)
set PANEL_PASSWORD=momonga
set PORT=3100
echo ============================================
echo   MOMONGA PRO (modo RENTA) en puerto 3100
echo ============================================
echo   Al arrancar, copia la "API de control" que
echo   aparece abajo y pegala en el SaaS -^> Ajustes.
echo.
node server.js
pause
