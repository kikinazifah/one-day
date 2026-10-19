@echo off
cd /d Y:\lomba\test-front
call .venv\Scripts\activate.bat
python manage.py runserver
pause