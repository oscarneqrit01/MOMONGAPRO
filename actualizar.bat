@echo off
title Actualizar MOMONGA (git)
cd /d "%~dp0"

echo ============================================
echo   Actualizando a la ULTIMA version
echo ============================================
echo.

echo [1/3] Buscando cambios en GitHub...
git fetch origin

echo [2/3] Poniendo la ultima version (se descartan cambios locales)...
git reset --hard origin/main

echo [3/3] Reiniciando el bot...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3100" ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1

echo.
echo Listo. Si el bot no vuelve solo, ejecuta: iniciar-bot-y-tunel.bat
timeout /t 4 >nul
