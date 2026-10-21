from django.http import FileResponse, Http404
from django.shortcuts import render
from pathlib import Path

from .reminder_offsets import preset_options

# Create your views here.
def home(request):
    return render(request, 'dashboard/home.html')

def document_creator(request):
    return render(request, 'dashboard/document_creator.html', {
        'active_page': 'document',
    })


def lecture_listener(request):
    return render(request, 'dashboard/lecture_listener.html', {
        'active_page': 'lecture',
    })


def reminder_system(request):
    return render(request, 'dashboard/reminder_system.html', {
        'active_page': 'reminder',
        # Daftar preset pengingat berasal dari satu modul (``reminder_offsets``),
        # jadi template tidak menyalin daftar sendiri. Urutannya dari yang
        # paling dekat (30 menit) ke yang paling jauh (1 minggu) — preset
        # yang paling sering dipakai ada di atas.
        'reminder_presets': preset_options(),
    })


def rag_assistant(request):
    return render(request, 'dashboard/rag_assistant.html', {
        'active_page': 'rag',
    })

def ai_lecturer(request):
    return render(request, 'dashboard/ai_lecturer.html', {
        'active_page': 'ai_lecturer',
    })

def auto_scheduler(request):
    return render(request, "dashboard/auto_scheduler.html", {
        'active_page': 'auto_scheduler',
    })


def service_worker(request):
    """Sajikan Service Worker dari akar situs.

    Service Worker punya aturan scope: default-nya hanya direktori tempat
    file-nya dilayani. Kalau file-nya dilayani dari ``/static/dashboard/``,
    scope-nya jadi ``/static/dashboard/`` — dan worker **tidak bisa**
    mengendalikan halaman ``/reminder-system/`` tempat notifikasi harus
    muncul.

    Karena itu file-nya disajikan dari ``/sw.js`` (akar situs), dengan
    header ``Service-Worker-Allowed: /`` supaya browser mengizinkan scope
    penuh. Django tidak melayani file statis dari luar ``STATIC_URL``, jadi
    ini harus lewat view.
    """
    sw_path = Path(__file__).resolve().parent / "static" / "dashboard" / "notification_service_worker.js"
    if not sw_path.is_file():
        raise Http404("Service Worker tidak ditemukan.")

    response = FileResponse(sw_path.open("rb"), content_type="application/javascript")
    response["Service-Worker-Allowed"] = "/"
    # Service Worker harus selalu mengambil versi terbaru — kalau tidak,
    # perubahan pada worker tidak akan pernah aktif.
    response["Cache-Control"] = "no-cache"
    return response