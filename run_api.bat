@echo off
REM Jalankan dashboard Django "Akademia AI" dengan kredensial service backend.
REM Backend FastAPI student-assistant harus jalan di http://127.0.0.1:8002
cd /d "%~dp0"
set AKADEMIA_API_URL=http://127.0.0.1:8002/api/v1
set AKADEMIA_API_EMAIL=service-account@example.invalid
set AKADEMIA_API_PASSWORD=GANTI-DARI-FILE-.env
python manage.py runserver 127.0.0.1:8010
pause
