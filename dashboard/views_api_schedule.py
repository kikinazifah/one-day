"""Endpoint JSON untuk halaman Auto Scheduler — jembatan ke backend FastAPI.

Alur jadwal:

    browser ──GET    /api/schedule/──────────▶ Django ──▶ FastAPI GET    /schedule
    browser ──POST   /api/schedule/──────────▶ Django ──▶ FastAPI POST   /schedule
    browser ──PATCH  /api/schedule/<id>/─────▶ Django ──▶ FastAPI PATCH  /schedule/<id>
    browser ──DELETE /api/schedule/<id>/─────▶ Django ──▶ FastAPI DELETE /schedule/<id>
    browser ──POST   /api/schedule/import/───▶ Django ──▶ FastAPI POST   /schedule/import
    browser ──GET    /api/schedule/import/jobs/──▶ Django ─▶ FastAPI GET /schedule/import/jobs
    browser ──GET    /api/schedule/import/<id>/─▶ Django ─▶ FastAPI GET /schedule/import/<id>
    browser ──GET    /api/schedule/courses/──▶ Django ──▶ FastAPI GET    /schedule/courses

Pola sama seperti ``dashboard/views_api.py``: token service dipegang Django,
browser tidak pernah melihat JWT. Helper (``same_origin_json``, ``_json_body``,
``_error``) dipakai ulang supaya aturan proteksi seragam di semua halaman.

Catatan penting soal waktu: backend menyimpan ``start_time``/``end_time``
sebagai *naive* datetime (tanpa zona waktu). Jadi browser harus mengirim
string ISO naive apa adanya (``2026-10-20T08:00:00``) — kalau memakai
``toISOString()``, jam dindingnya geser sebesar offset zona waktu browser.
"""
from __future__ import annotations

import logging
import re

from django.http import JsonResponse
from django.views.decorators.http import require_GET, require_http_methods, require_POST

from . import backend_api
from .backend_api import ApiError
from .views_api import _error, _json_body, same_origin_json

logger = logging.getLogger(__name__)

# Id job import dibuat backend sebagai uuid4, jadi huruf/angka/hubung/
# garis bawah — bukan ``isalnum()`` yang akan menolak tanda hubung.
_JOB_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")

# Field yang boleh lolos dari browser ke backend. Sisanya (mis.
# ``is_from_campus_source``) sengaja dibuang supaya klien tidak bisa
# menandai entri seolah-olah datang dari scraper kampus.
SCHEDULE_FIELDS = (
    "title",
    "description",
    "start_time",
    "end_time",
    "location",
    "course_id",
    "day_of_week",
    "is_recurring",
    "recurrence_pattern",
)


def _schedule_payload(data: dict, *, partial: bool = False) -> dict:
    """Ambil hanya field jadwal yang dikenal, abaikan kunci asing dari klien."""
    payload: dict = {}

    for field in SCHEDULE_FIELDS:
        if field not in data:
            continue

        value = data[field]

        if value is None:
            # Pada PATCH, null berarti "kosongkan field ini".
            # Pada POST, null berarti "biarkan default backend".
            if partial:
                payload[field] = None
            continue

        if field == "is_recurring":
            payload[field] = bool(value)
            continue

        if field == "day_of_week":
            # 0=Monday .. 6=Sunday. Nilai 0 tetap sah, jadi jangan
            # diperlakukan sebagai "kosong".
            try:
                payload[field] = int(value)
            except (TypeError, ValueError):
                continue
            continue

        text = str(value).strip()

        if not text:
            # POST: string kosong = biarkan default backend.
            # PATCH: string kosong = minta backend mengosongkan field.
            if not partial or field == "title":
                continue

        payload[field] = text

    return payload


@require_http_methods(["GET", "POST"])
@same_origin_json
def schedule_collection(request):
    """Daftar jadwal (GET) atau tambah jadwal baru (POST)."""
    if request.method == "GET":
        return _list_schedule(request)
    return _create_schedule(request)


def _list_schedule(request) -> JsonResponse:
    """Jadwal milik pengguna + bentrok yang dihitung backend on-the-fly."""
    params: dict = {}
    for key in ("start", "end"):
        value = request.GET.get(key)
        if value:
            params[key] = value

    try:
        payload = backend_api.request("GET", "/schedule/", params=params or None)
    except ApiError as exc:
        logger.warning("daftar jadwal gagal: %s", exc)
        return _error(exc)

    return JsonResponse(
        {
            "ok": True,
            "entries": payload.get("entries", []),
            "conflicts": payload.get("conflicts", []),
            # "Hari ini" menurut zona aplikasi, diteruskan dari backend.
            # Dihitung di browser, hasilnya bisa salah untuk user yang
            # zona kerjanya berbeda dari ``APP_TIMEZONE``.
            "today": payload.get("today") or {},
        }
    )


def _create_schedule(request) -> JsonResponse:
    """Buat entri jadwal baru."""
    data = _json_body(request)

    title = str(data.get("title") or "").strip()
    if not title:
        return JsonResponse({"ok": False, "error": "Judul jadwal wajib diisi."}, status=400)

    start_time = str(data.get("start_time") or "").strip()
    end_time = str(data.get("end_time") or "").strip()
    if not start_time or not end_time:
        return JsonResponse(
            {"ok": False, "error": "Waktu mulai dan waktu selesai wajib diisi."},
            status=400,
        )

    payload = _schedule_payload(data)
    payload["title"] = title
    payload["start_time"] = start_time
    payload["end_time"] = end_time

    try:
        entry = backend_api.request("POST", "/schedule/", json=payload)
    except ApiError as exc:
        logger.warning("buat jadwal gagal: %s", exc)
        return _error(exc)

    return JsonResponse({"ok": True, "entry": entry})


@require_http_methods(["PATCH", "DELETE"])
@same_origin_json
def schedule_detail(request, entry_id: str):
    """Perbarui (PATCH) atau hapus (DELETE) satu entri jadwal."""
    if request.method == "DELETE":
        return _delete_schedule(entry_id)
    return _update_schedule(request, entry_id)


def _update_schedule(request, entry_id: str) -> JsonResponse:
    """Perbarui sebagian field entri jadwal."""
    payload = _schedule_payload(_json_body(request), partial=True)

    if not payload:
        return JsonResponse(
            {"ok": False, "error": "Tidak ada field jadwal yang diperbarui."}, status=400
        )

    try:
        entry = backend_api.request("PATCH", f"/schedule/{entry_id}", json=payload)
    except ApiError as exc:
        logger.warning("ubah jadwal %s gagal: %s", entry_id, exc)
        return _error(exc)

    return JsonResponse({"ok": True, "entry": entry})


def _delete_schedule(entry_id: str) -> JsonResponse:
    """Hapus entri jadwal."""
    try:
        payload = backend_api.request("DELETE", f"/schedule/{entry_id}")
    except ApiError as exc:
        logger.warning("hapus jadwal %s gagal: %s", entry_id, exc)
        return _error(exc)

    message = payload.get("message") if isinstance(payload, dict) else None

    return JsonResponse({"ok": True, "message": message or "Jadwal dihapus."})


@require_POST
@same_origin_json
def schedule_import(request):
    """Mulai impor jadwal dari halaman kampus.

    Backend menjalankan ini sebagai *background job* dan tidak menyediakan
    endpoint status, jadi respons hanya memberi tahu bahwa proses sudah
    dijalankan — hasilnya baru terlihat setelah querying ulang jadwal.
    """
    data = _json_body(request)

    url = str(data.get("url") or "").strip()
    if not url:
        return JsonResponse({"ok": False, "error": "URL sumber wajib diisi."}, status=400)

    payload: dict = {"url": url}

    course_id = str(data.get("course_id") or "").strip()
    if course_id:
        payload["course_id"] = course_id

    selectors = data.get("selectors")
    if isinstance(selectors, dict) and selectors:
        payload["selectors"] = selectors

    try:
        result = backend_api.request("POST", "/schedule/import", json=payload)
    except ApiError as exc:
        logger.warning("impor jadwal gagal: %s", exc)
        return _error(exc)

    result = result if isinstance(result, dict) else {}

    return JsonResponse(
        {
            "ok": True,
            "message": result.get("message", "Import jadwal dimulai."),
            "task_id": result.get("task_id"),
            # Import berjalan di latar belakang. Tanpa ``job_id`` halaman
            # hanya bisa memintakan pengguna menekan "Muat ulang" — status
            # prosesnya tidak pernah terlihat.
            "job_id": result.get("job_id"),
            "job": result.get("job"),
        }
    )


@require_GET
@same_origin_json
def schedule_import_jobs(request):
    """Daftar proses import jadwal (terbaru dulu)."""
    try:
        jobs = backend_api.request("GET", "/schedule/import/jobs")
    except ApiError as exc:
        logger.warning("daftar job import gagal: %s", exc)
        return _error(exc)

    return JsonResponse(
        {"ok": True, "jobs": jobs if isinstance(jobs, list) else []}
    )


@require_GET
@same_origin_json
def schedule_import_job(request, job_id: str):
    """Status satu proses import jadwal."""
    cleaned = (job_id or "").strip()
    # Id job dibuat backend sebagai uuid4 — mengandung tanda hubung, jadi
    # ``isalnum()`` akan menolaknya. Pola yang diizinkan: huruf, angka,
    # hubung, dan garis bawah, maksimal 64 karakter.
    if not cleaned or len(cleaned) > 64 or not _JOB_ID_RE.fullmatch(cleaned):
        return JsonResponse({"ok": False, "error": "Id job tidak valid."}, status=400)

    try:
        job = backend_api.request("GET", f"/schedule/import/{cleaned}")
    except ApiError as exc:
        logger.warning("status job import %s gagal: %s", cleaned, exc)
        return _error(exc)

    job = job if isinstance(job, dict) else {}

    return JsonResponse({"ok": True, "job": job})


@require_GET
@same_origin_json
def schedule_courses(request):
    """Mata kuliah milik pengguna — untuk pemilih mata kuliah."""
    try:
        courses = backend_api.request("GET", "/schedule/courses")
    except ApiError as exc:
        logger.warning("daftar mata kuliah gagal: %s", exc)
        return _error(exc)

    return JsonResponse(
        {"ok": True, "courses": courses if isinstance(courses, list) else []}
    )
