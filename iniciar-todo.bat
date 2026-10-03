@echo off
title MOMONGA PRO + Renta (una sola ventana)
setlocal
cd /d "%~dp0"
rem Usa el Node.js de ESTA carpeta (portable), asi no depende de C:
if exist "%~dp0node\node.exe" set "PATH=%~dp0node;%PATH%"

rem Un SOLO lanzador: Mongo + Bot + SaaS + Frontend + Tunel en esta misma ventana.
rem Ctrl+C apaga todo.
node arranque.js

pause
