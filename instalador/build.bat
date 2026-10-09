@echo off
title Compilar instalador MOMONGA MEGA
cd /d "%~dp0"

set "VERSION=22"

echo == Compilando instalador ==
set "ISCC=C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" set "ISCC=C:\Program Files\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" set "ISCC=%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" (
  echo No se encontro Inno Setup 6.
  echo Instalalo desde: https://jrsoftware.org/isdl.php  ^(elige "Inno Setup 6"^)
  pause
  exit /b 1
)
"%ISCC%" "%~dp0MOMONGA-BOT.iss"
if exist "%~dp0dist\MOMONGA-MEGA-Setup-%VERSION%.exe" (
  if not exist "%~dp0..\renta\backend\downloads" mkdir "%~dp0..\renta\backend\downloads"
  copy /Y "%~dp0dist\MOMONGA-MEGA-Setup-%VERSION%.exe" "%~dp0..\renta\backend\downloads\MOMONGA-MEGA-Setup-%VERSION%.exe" >nul
  echo Instalador copiado a renta\backend\downloads (se sirve en /downloads)
)
echo.
echo Listo. El instalador quedo en: instalador\dist\
pause
