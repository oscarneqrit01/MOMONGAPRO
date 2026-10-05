@echo off
cd /d "%~dp0"
start "MOMONGA BOT" /min "%~dp0iniciar-bot-admin.bat"
timeout /t 4 /nobreak >nul
start "TUNEL VPS" /min "%~dp0tunel-vps.bat"
echo Bot + tunel iniciados. El SaaS ya verA este bot en 127.0.0.1:3100.
timeout /t 3 /nobreak >nul
