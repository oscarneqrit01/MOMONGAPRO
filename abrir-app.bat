@echo off
rem Espera a que el bot arranque y abre el panel en una VENTANA tipo app (sin barra de navegador).
timeout /t 6 /nobreak >nul
set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if exist "%CHROME%" (
  start "" "%CHROME%" --app="http://localhost:3100/cliente" --window-size=1200,820 --window-position=80,40
) else (
  start "" "http://localhost:3100/cliente"
)
