@echo off
title MOMONGA - Tunel Cloudflare
cd /d "%~dp0"
"%~dp0cloudflared.exe" tunnel --config "%~dp0.cloudflared\config.yml" run
pause
