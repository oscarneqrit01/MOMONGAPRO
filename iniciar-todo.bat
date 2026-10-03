@echo off
title MOMONGA PRO + Renta - Arranque
setlocal
cd /d "%~dp0"
rem Usa el Node.js de ESTA carpeta (portable), asi no depende de C:
if exist "%~dp0node\node.exe" set "PATH=%~dp0node;%PATH%"

echo ==========================================
echo   MOMONGA PRO  +  Panel de Renta
echo ==========================================
echo.

rem 1) MongoDB (base de datos del SaaS)
netstat -ano | findstr ":27017" | findstr LISTENING >nul
if errorlevel 1 (
  echo [1/5] Iniciando MongoDB...
  start "MongoDB" /min "%~dp0renta\backend\mongo7\mongodb-win32-x86_64-windows-7.0.24\bin\mongod.exe" --dbpath="%~dp0renta\backend\data\db" --port=27017 --bind_ip=127.0.0.1 --logpath="%~dp0renta\backend\data\mongo70.log" --logappend
  timeout /t 3 /nobreak >nul
) else (
  echo [1/5] MongoDB ya esta corriendo.
)

rem 2) Bot (Actulizador) en puerto 3100
netstat -ano | findstr ":3100" | findstr LISTENING >nul
if errorlevel 1 (
  echo [2/5] Iniciando bot (puerto 3100)...
  start "MOMONGA Bot" /min /D "%~dp0" cmd /k "set PORT=3100&& set PANEL_PASSWORD=momonga&& node server.js"
  timeout /t 3 /nobreak >nul
) else (
  echo [2/5] Bot ya esta corriendo.
)

rem 3) Backend del SaaS (puerto 4000)
netstat -ano | findstr ":4000" | findstr LISTENING >nul
if errorlevel 1 (
  echo [3/5] Iniciando backend del SaaS (puerto 4000)...
  start "Renta Backend" /min /D "%~dp0renta\backend" cmd /k node supervisor.js
  timeout /t 4 /nobreak >nul
) else (
  echo [3/5] Backend ya esta corriendo.
)

rem 4) Frontend del SaaS (puerto 3000)
netstat -ano | findstr ":3000" | findstr LISTENING >nul
if errorlevel 1 (
  echo [4/5] Iniciando frontend del SaaS (puerto 3000)...
  start "Renta Frontend" /min /D "%~dp0renta\frontend" cmd /k node node_modules\vite\bin\vite.js
  timeout /t 6 /nobreak >nul
) else (
  echo [4/5] Frontend ya esta corriendo.
)

rem 5) Tunel Cloudflare (mimomonga.uk -> panel en 4000) - usa el cloudflared y config de ESTA carpeta
if exist "%~dp0cloudflared.exe" (
  tasklist /fi "imagename eq cloudflared.exe" | findstr /i cloudflared >nul
  if errorlevel 1 (
    echo [5/5] Iniciando tunel Cloudflare ^(mimomonga.uk^)...
    start "Cloudflare Tunnel" /min "%~dp0tunel.bat"
    timeout /t 4 /nobreak >nul
  ) else (
    echo [5/5] Tunel Cloudflare ya esta corriendo.
  )
) else (
  echo [5/5] cloudflared no esta en la carpeta; el dominio publico no arrancara.
)

echo.
echo Sistema listo. Abriendo el panel...
start "" "http://localhost:3000"
echo.
echo   Panel local:   http://localhost:3000   admin@saas.local / Admin123!
echo   Panel publico: https://mimomonga.uk
echo   Bot directo:   http://localhost:3100   (contrasena: momonga)
echo.
echo Para apagar: cierra las ventanas "MOMONGA Bot", "Renta Backend", "Renta Frontend" y "Cloudflare Tunnel".
echo.
pause
