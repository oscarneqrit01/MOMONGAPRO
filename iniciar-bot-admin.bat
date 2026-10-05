@echo off
cd /d "%~dp0"
set PORT=3100
set PANEL_PASSWORD=momonga
if "%CLOUD_URL%"=="" set CLOUD_URL=https://mimomonga.uk
if not exist "%~dp0logs" mkdir "%~dp0logs"
:loop
"D:\Projecto Oscar\node\node.exe" server.js >> "%~dp0logs\bot-stdout.log" 2>&1
echo %date% %time% bot se cerro, reinicio en 5s... >> "%~dp0logs\bot.log"
timeout /t 5 >nul
goto loop
