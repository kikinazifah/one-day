@echo off
title Uji Reboot Auto-Start
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Pongo\one-day\reboot_test.ps1"
echo.
echo Hasil tercatat di C:\Users\Pongo\one-day\reboot_test.log
echo (jendela ini boleh ditutup kapan saja)
pause >nul
