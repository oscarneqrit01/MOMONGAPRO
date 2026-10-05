@echo off
title Tunel bots -> VPS (no cerrar)
cd /d "%~dp0"
if not exist "%~dp0logs" mkdir "%~dp0logs"
:loop
"C:\Windows\System32\OpenSSH\ssh.exe" -i "%USERPROFILE%\.ssh\momonga_vps" -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -N -R 3100:localhost:3100 -R 3101:10.0.0.5:3100 root@5.161.222.226
echo %date% %time% tunel caido, reintentando en 5s... >> "%~dp0logs\tunel.log"
timeout /t 5 >nul
goto loop
