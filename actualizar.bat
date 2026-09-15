@echo off
title MOMONGA PRO - Actualizar
cd /d "%~dp0"

echo ============================================
echo   Actualizando MOMONGA PRO...
echo ============================================
echo.

echo [1/2] Descargando cambios (git pull)...
git pull
if errorlevel 1 (
  echo.
  echo ERROR: No se pudo actualizar. Verifica que Git este instalado
  echo y que este repositorio haya sido clonado correctamente.
  echo.
  pause
  exit /b 1
)

echo.
echo [2/2] Instalando dependencias (npm install)...
call npm install
if errorlevel 1 (
  echo.
  echo ERROR al instalar las dependencias.
  echo.
  pause
  exit /b 1
)

echo.
echo ============================================
echo   Actualizacion completada con exito.
echo   Ya puedes iniciar con iniciar.bat
echo ============================================
echo.
pause
