@echo off
REM Jalankan backend FastAPI "student-assistant" yang dipakai dashboard Django.
REM
REM Port dan lokasi backend dapat diubah lewat argumen:
REM     run_api.bat [port] [path_ke_backend]
REM Default: port 8022, folder ..\UINIC\student-assistant\backend
REM
REM CATATAN: Celery worker (run_worker.bat di folder backend) harus jalan
REM terpisah — task async (laporan mingguan, video ajar, pengingat) tidak
REM dieksekusi tanpa worker.

setlocal

set "PORT=%~1"
if "%PORT%"=="" set "PORT=8022"

set "BACKEND=%~2"
if "%BACKEND%"=="" set "BACKEND=%~dp0..\UINIC\student-assistant\backend"

if not exist "%BACKEND%\app\main.py" (
    echo [ERROR] Backend tidak ditemukan di: %BACKEND%
    echo Jalankan: run_api.bat 8022 "C:\path\to\student-assistant\backend"
    pause
    exit /b 1
)

cd /d "%BACKEND%"

REM Venv lokal lebih dulu kalau ada, supaya dependensi backend dipakai.
if exist "%BACKEND%\.venv\Scripts\activate.bat" (
    call "%BACKEND%\.venv\Scripts\activate.bat"
)

python -m uvicorn app.main:app --host 127.0.0.1 --port %PORT%
pause
