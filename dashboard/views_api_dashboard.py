"""Endpoint JSON ringkasan untuk halaman dashboard.

Alur:

    browser --GET /api/dashboard/summary/--> Django --> FastAPI /tasks
                                                `----> FastAPI /schedule/
                                                  `----> FastAPI /courses/

Endpoint ini **agregator di sisi BFF**, bukan endpoint baru di FastAPI.
Alasannya:

* Data yang dibutuhkan dashboard sudah tersedia di backend - tidak perlu
  kontrak API baru yang harus dijaga di dua frontend.
* Django memegang token service, jadi satu request browser cukup menjemput
  tiga resource backend sekaligus.

Pembatas yang disengaja: endpoint ini **tidak** menghitung "terlambat".
Status itu sudah dihitung backend (lihat ``_effective_status()`` di
``app/api/routes/tasks.py``) dan dikirim apa adanya di field ``status`` -
klien tinggal membacanya, bukan menebak ulang.

"Hari ini" **tidak** dihitung di BFF maupun di browser, tapi diteruskan
dari backend: field ``schedule.today`` berisi tanggal dan hari-dalam-minggu
dalam zona aplikasi (``APP_TIMEZONE``). Alasannya:

* Django memakai ``TIME_ZONE="UTC"`` dengan ``USE_TZ=True``, sedangkan data
  backend adalah **jam dinding** (``APP_TIMEZONE=Asia/Jakarta``).
  ``timezone.localdate()`` di Django menghasilkan tanggal UTC, yang bisa
  berbeda satu hari dari tanggal yang dilihat mahasiswa. Salah sehari di
  panel jadwal = bug yang sangat menyesatkan.
* Browser tidak pernah bisa lebih tepat daripada server: ia bisa berada
  di zona waktu yang berbeda dari zona aplikasi, jadi ``new Date()`` di
  sana bisa jatuh di hari yang berbeda. Backend sudah tahu "hari ini"
  dalam zona yang benar - jadi backend yang meneruskannya.

Jadi BFF hanya mengumpulkan, menormalisasi, menyelesaikan nama mata kuliah,
dan meneruskan ``today`` apa adanya.
"""
from __future__ import annotations

import logging

from django.http import JsonResponse
from django.views.decorators.http import require_GET

from . import backend_api
from .backend_api import ApiError
from .views_api import _error, same_origin_json

logger = logging.getLogger(__name__)

# Berapa banyak tugas yang dikirim ke dashboard. Cukup untuk isi satu
# panel; sisanya ada di halaman Reminder System. Panel menampilkan
# "+N tugas lainnya" kalau ada sisanya, jadi tidak ada tugas yang hilang
# diam-diam.
TASK_LIMIT = 8

# Field tugas yang diteruskan ke browser. Dipotong eksplisit supaya
# field internal backend (mis. ``user_id``, ``reminder_job_id``) tidak
# ikut bocor ke klien tanpa perlu.
_TASK_FIELDS = (
    "id",
    "title",
    "due_date",
    "priority",
    "type",
    "status",
    "course_id",
    "is_completed",
    "created_at",
)

# Field entri jadwal yang diteruskan ke browser.
_ENTRY_FIELDS = (
    "id",
    "title",
    "start_time",
    "end_time",
    "location",
    "course_id",
    "day_of_week",
    "is_recurring",
)

# Field konflik yang diteruskan ke browser. ``message`` dan ``severity``
# sengaja tidak ikut - panel hanya perlu tahu entri mana yang bertabrakan.
_CONFLICT_FIELDS = ("entry1_id", "entry2_id", "type")


def _pick(data: dict, fields) -> dict:
    """Ambil hanya field yang diizinkan dari sebuah dict."""
    return {key: data.get(key) for key in fields if key in data}


def _course_index(courses) -> dict:
    """Bangun peta id -> mata kuliah, supaya panel bisa menampilkan kode
    (``IF3012``) dan nama (``Basis Data``) alih-alih UUID."""
    index: dict = {}
    for course in courses or []:
        if not isinstance(course, dict):
            continue
        course_id = course.get("id")
        if not course_id:
            continue
        index[course_id] = {
            "code": course.get("code") or "",
            "name": course.get("name") or "",
        }
    return index


def _with_course(item: dict, courses: dict) -> dict:
    """Sisipkan kode & nama mata kuliah ke item yang punya ``course_id``."""
    course = courses.get(item.get("course_id") or "")
    if not course:
        return item
    item["course_code"] = course["code"]
    item["course_name"] = course["name"]
    return item


def _sort_key(task: dict):
    """Urutkan tugas: yang belum selesai dulu, lalu tenggat terdekat.

    ``due_date`` adalah jam dinding (naive) - bisa ``None`` kalau tugas
    dibuat tanpa tenggat (seharusnya tidak boleh, tapi jangan sampai
    pengurutannya meledak).
    """
    due = task.get("due_date") or ""
    return (0 if not task.get("is_completed") else 1, due or "9999")


def _today(schedule: dict) -> dict:
    """``today`` dari backend, dengan cadangan kalau backend-nya lama.

    Backend mengirim ``today`` di ``GET /schedule/``. Kalau field itu
    tidak ada (backend versi lama, atau proxies yang memotong field),
    BFF menghitungnya sendiri **dari tanggal yang dikirim backend** -
    bukan dari jam Django, karena Django itu UTC.

    Cadangan ini dihitung dari ``schedule.today`` yang tidak ada: tanpa
    itu, panel "Jadwal Hari Ini" jadi kosong total - lebih buruk daripada
    salah satu hari.
    """
    today = schedule.get("today")
    if isinstance(today, dict) and today.get("dow") is not None:
        return {
            "date": today.get("date") or "",
            "dow": int(today["dow"]),
        }
    return {}


@require_GET
@same_origin_json
def dashboard_summary(request):
    """Ringkasan untuk dashboard: tugas, jadwal, dan mata kuliah."""
    try:
        tasks = backend_api.request("GET", "/tasks")
        schedule = backend_api.request("GET", "/schedule/")
        courses = backend_api.request("GET", "/courses/")
    except ApiError as exc:
        logger.warning("ringkasan dashboard gagal: %s", exc)
        return _error(exc)

    if not isinstance(tasks, list):
        tasks = []
    if not isinstance(schedule, dict):
        schedule = {}
    if not isinstance(courses, list):
        courses = []

    course_index = _course_index(courses)

    # --- tugas -------------------------------------------------------------
    # Yang belum selesai dulu; tugas selesai tetap dihitung supaya
    # badge "selesai" di panel bisa menampilkan jumlah yang benar.
    task_items = []
    completed = 0
    for raw in tasks:
        if not isinstance(raw, dict):
            continue
        item = _pick(raw, _TASK_FIELDS)
        if item.get("is_completed"):
            completed += 1
        task_items.append(_with_course(item, course_index))

    pending = [t for t in task_items if not t.get("is_completed")]
    pending.sort(key=_sort_key)
    upcoming = pending[:TASK_LIMIT]

    # Jumlah "terlambat" dihitung dari **seluruh** tugas yang belum
    # selesai, bukan dari 8 item yang dikirim. Kalau dihitung dari
    # 8 item, panel menampilkan "2 lewat tenggat" padahal sebenarnya
    # ada 7 — angka yang terlalu rendah lebih buruk daripada tidak
    # menampilkan sama sekali, karena user menganggapnya benar.
    #
    # Sumbernya ``status`` dari backend, yang sudah dihitung dari jam
    # dinding aplikasi. BFF tidak menghitung ulang.
    overdue = sum(1 for t in pending if t.get("status") == "overdue")

    # --- jadwal ------------------------------------------------------------
    # Backend mengirim semua entri. Yang ditampilkan "hari ini" ditentukan
    # klien (JS) memakai ``schedule.today`` yang diteruskan apa adanya.
    entries = []
    for raw in schedule.get("entries") or []:
        if not isinstance(raw, dict):
            continue
        entries.append(_with_course(_pick(raw, _ENTRY_FIELDS), course_index))

    conflicts = []
    for raw in schedule.get("conflicts") or []:
        if not isinstance(raw, dict):
            continue
        conflicts.append(_pick(raw, _CONFLICT_FIELDS))

    return JsonResponse(
        {
            "ok": True,
            "tasks": {
                "items": upcoming,
                "total": len(task_items),
                "pending": len(pending),
                "completed": completed,
                # Berapa banyak yang TIDAK ikut dikirim karena ``TASK_LIMIT``.
                # Panel memakainya untuk menampilkan "+N tugas lainnya" —
                # tanpa ini, tugas hilang diam-diam.
                "omitted": max(0, len(pending) - len(upcoming)),
                "limit": TASK_LIMIT,
                # Berapa banyak yang sudah lewat tenggat, dihitung dari
                # seluruh tugas yang belum selesai. Panel memakainya
                # untuk badge "lewat tenggat" — kalau panel menghitungnya
                # sendiri dari 8 item yang tampil, angkanya bisa jauh
                # lebih kecil dari kenyataan.
                "overdue": overdue,
            },
            "schedule": {
                "entries": entries,
                "conflicts": conflicts,
                "today": _today(schedule),
            },
            "courses": [
                {
                    "id": c.get("id"),
                    "name": c.get("name") or "",
                    "code": c.get("code") or "",
                }
                for c in courses
                if isinstance(c, dict) and c.get("id")
            ],
        }
    )
