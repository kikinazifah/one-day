@echo off
REM Jalankan dashboard Django "Akademia AI".
REM
REM Konfigurasi backend (URL + kredensial service) dibaca dari file .env
REM di folder ini — lihat config/settings.py yang memuatnya otomatis.
REM Jadi skrip ini TIDAK perlu menyalin kredensial di sini.

cd /d "%~dp0"

if not exist ".env" (
    echo [ERROR] File .env tidak ada di folder ini.
    echo Salin .env.example menjadi .env lalu isi kredensial service backend.
    pause
    exit /b 1
)

REM Auto-reload ON (tanpa --noreload) -- disengaja.
REM
REM   - Edit .py  -> proses restart sendiri (~2-5 detik downtime).
REM     Tanpa autoreload, kode yang diedit TIDAK pernah ter-load dan
REM     server diam-diam melayani versi lama. Itu kelas bug yang sama
REM     dengan "data kosong": halaman minta endpoint yang tidak ada.
REM   - Edit .html -> berlaku dalam ~0.5 detik, TANPA restart.
REM     Django's template reloader me-reset loader saat file berubah
REM     (django/template/autoreload.py -> template_changed -> reset_loaders).
REM
REM Autoreloader hanya acrescenta SATU proses (parent + child) dan
REM ~1 detik system check saat start. Batas listen tetap 256 lewat
REM dashboard/dev_server.py -- yang itu yang memperbaiki ERR_CONNECTION_REFUSED.
python manage.py runserver 127.0.0.1:8010
pause
