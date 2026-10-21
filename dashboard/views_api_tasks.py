"""Endpoint JSON untuk halaman Reminder System — jembatan ke backend FastAPI.

Alur:

    browser ──GET    /api/tasks/──────────────▶ Django ──▶ FastAPI /tasks
    browser ──GET    /api/courses/────────────▶ Django ──▶ FastAPI /courses/
    browser ──POST   /api/tasks/──────────────▶ Django ──▶ FastAPI /tasks
    browser ──POST   /api/tasks/<id>/complete/─▶ Django ──▶ FastAPI /tasks/<id>/complete
    browser ──POST   /api/tasks/<id>/reminders/▶ Django ──▶ FastAPI /tasks/<id>/reminders
    browser ──DELETE /api/tasks/<id>/─────────▶ Django ──▶ FastAPI /tasks/<id>

``_json_body``, ``_error``, dan dekorator ``same_origin_json`` dipakai ulang
dari ``views_api`` supaya semua endpoint JSON dashboard konsisten.
"""
from __future__ import annotations

import logging
import re

from django.http import JsonResponse
from django.views.decorators.http import (
    require_GET,
    require_http_methods,
    require_POST,
)

from . import backend_api
from .backend_api import ApiError
from .reminder_offsets import normalize_offset, preset_options
from .views_api import _error, _json_body, same_origin_json

logger = logging.getLogger(__name__)

# Prioritas yang diterima backend (lihat app/schemas/task.py di student-assistant).
TASK_PRIORITIES = ("low", "medium", "high", "urgent")

# Status yang diterima backend (enum TaskStatus di app/models/task.py).
TASK_STATUSES = ("not_started", "in_progress", "completed", "overdue")

# Jenis tugas yang diterima backend (pola di schema TaskBase).
TASK_TYPES = ("assignment", "exam", "project", "reading", "other")


def _validate_reminder_time(value):
    """Normalisasi offset pengingat, atau ``None`` kalau tidak ada.

    Offset pengingat adalah *jeda sebelum tenggat*, bukan waktu absolut.
    Bentuknya ``<jumlah>_<satuan>`` dan divalidasi oleh modul offset
    (``dashboard/reminder_offsets.py``) yang meniru aturan backend.

    Satu hal yang **tidak** boleh terjadi di sini: nilai yang tidak
    dikenal lolos ke backend. Dulu daftar preset lokal dijadikan
    gerbang, jadi "3 jam sebelum" - yang justru diminta spesifikasi -
    ditolak. Sekarang aturannya tata bahasa, bukan daftar tetap, jadi
    preset baru dari backend langsung bisa dipakai tanpa menyentuh BFF.
    """
    if value in (None, ""):
        return None

    try:
        return normalize_offset(value)
    except ValueError as exc:
        raise ValueError(str(exc)) from exc

# Id tugas dari backend berupa UUID. Pola ini mencegah id nakal dipakai
# untuk menyusun path baru ke backend.
_TASK_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# Tanggal dari ``<input type="datetime-local">``: "2026-10-25T23:59" atau
# "2026-10-25T23:59:00" — selalu tanpa zona waktu.
_NAIVE_DATETIME_RE = re.compile(
    r"^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?(\.\d+)?$"
)


def _normalize_due_date(raw: str) -> str:
    """Normalisasi datetime browser → ``YYYY-MM-DDTHH:MM:SS``.

    Backend menyimpan datetime NAIVE (tanpa zona waktu), jadi wall clock
    harus sama persis dengan yang diketik pengguna. Detik yang hilang
    ditambahkan supaya Pydantic tidak salah membaca ``23:59`` sebagai
    menit ke-59.
    """
    value = (raw or "").strip()
    match = _NAIVE_DATETIME_RE.match(value)
    if not match:
        # Format lain (mis. dengan offset) diteruskan ke backend untuk
        # divalidasi di sana.
        return value
    date_part, time_part, seconds = match.group(1), match.group(2), match.group(3)
    return f"{date_part}T{time_part}{seconds or ':00'}"


def _valid_task_id(task_id: str) -> bool:
    return bool(_TASK_ID_RE.match(task_id or ""))


@require_GET
@same_origin_json
def list_tasks(request):
    """Daftar seluruh tugas milik akun service."""
    status_filter = (request.GET.get("status_filter") or "").strip()
    params = {"status_filter": status_filter} if status_filter else None

    try:
        tasks = backend_api.request("GET", "/tasks", params=params)
    except ApiError as exc:
        logger.warning("daftar tugas gagal: %s", exc)
        return _error(exc)

    return JsonResponse({"ok": True, "tasks": tasks})


@require_GET
@same_origin_json
def list_courses(request):
    """Daftar mata kuliah — dipakai untuk mengisi dropdown form tugas."""
    try:
        courses = backend_api.request("GET", "/courses/")
    except ApiError as exc:
        logger.warning("daftar mata kuliah gagal: %s", exc)
        return _error(exc)

    return JsonResponse({"ok": True, "courses": courses})


@require_GET
@same_origin_json
def list_reminder_offsets(request):
    """Offset pengingat yang dikenal backend, beserta label Indonesianya.

    Daftar ini diiklankan backend (``GET /reminders/offsets``), jadi
    antarmuka tidak perlu menyalin daftar preset-nya sendiri. Kalau
    backend menambah preset, UI ikut menampilkannya tanpa perlu diubah.

    Response juga membawa ``presets`` — daftar preset lokal BFF — supaya
    ``verify_bff.py`` bisa membandingkannya dengan daftar backend dan
    gagal kalau keduanya berbeda. Dua repo terpisah tidak bisa mengimpor
    modul satu sama lain, jadi perbedaan sekecil apa pun harus
    ketahuan lewat verifikasi, bukan lewat tugas yang pengingatnya diam-diam
    gagal dijadwalkan.
    """
    try:
        remote = backend_api.request("GET", "/reminders/offsets")
    except ApiError as exc:
        logger.warning("daftar offset pengingat gagal: %s", exc)
        return _error(exc)

    remote = remote if isinstance(remote, dict) else {}

    return JsonResponse(
        {
            "ok": True,
            "offsets": remote.get("offsets") or [],
            "labels": remote.get("labels") or {},
            "presets": preset_options(),
        }
    )


@require_POST
@same_origin_json
def create_task(request):
    """Form Reminder System → tugas baru di backend."""
    data = _json_body(request)

    title = (data.get("title") or "").strip()
    due_date = _normalize_due_date(data.get("due_date") or "")
    priority = (data.get("priority") or "medium").strip().lower()
    description = (data.get("description") or "").strip()
    course_id = (data.get("course_id") or "").strip() or None

    # Waktu pengingat opsional — form boleh mengirimnya, boleh tidak.
    try:
        reminder_time = _validate_reminder_time(
            (data.get("reminder_time") or "").strip() or None
        )
    except ValueError as exc:
        return JsonResponse({"ok": False, "error": str(exc)}, status=400)

    if not title:
        return JsonResponse({"ok": False, "error": "Nama tugas wajib diisi."}, status=400)
    if not due_date:
        return JsonResponse(
            {"ok": False, "error": "Tanggal dan waktu tenggat wajib diisi."}, status=400
        )
    if priority not in TASK_PRIORITIES:
        return JsonResponse(
            {"ok": False, "error": f"Prioritas tidak dikenal: {priority}."}, status=400
        )

    payload = {
        "title": title,
        "description": description or None,
        # Naive datetime: backend menyimpan wall clock apa adanya.
        "due_date": due_date,
        "priority": priority,
        "course_id": course_id,
    }

    if reminder_time:
        payload["reminder_enabled"] = True
        payload["reminder_time"] = reminder_time

    try:
        task = backend_api.request("POST", "/tasks", json=payload)
    except ApiError as exc:
        logger.warning("buat tugas gagal: %s", exc)
        return _error(exc)

    return JsonResponse({"ok": True, "task": task})


@require_POST
@same_origin_json
def complete_task(request, task_id: str):
    """Tandai tugas selesai."""
    if not _valid_task_id(task_id):
        return JsonResponse({"ok": False, "error": "Id tugas tidak valid."}, status=400)

    try:
        result = backend_api.request("POST", f"/tasks/{task_id}/complete")
    except ApiError as exc:
        logger.warning("tandai selesai gagal: %s", exc)
        return _error(exc)

    return JsonResponse(
        {"ok": True, "message": result.get("message", ""), "task": result.get("task")}
    )


@require_POST
@same_origin_json
def update_task_reminders(request, task_id: str):
    """Ubah pengaturan pengingat tugas (aktif/nonaktif + waktunya)."""
    if not _valid_task_id(task_id):
        return JsonResponse({"ok": False, "error": "Id tugas tidak valid."}, status=400)

    data = _json_body(request)
    payload: dict = {}

    if "enabled" in data:
        payload["enabled"] = bool(data["enabled"])
    if "time" in data:
        try:
            reminder_time = _validate_reminder_time(data["time"])
        except ValueError as exc:
            return JsonResponse({"ok": False, "error": str(exc)}, status=400)
        payload["time"] = reminder_time

    if not payload:
        return JsonResponse(
            {"ok": False, "error": "Tidak ada pengaturan pengingat yang dikirim."},
            status=400,
        )

    try:
        result = backend_api.request(
            "POST", f"/tasks/{task_id}/reminders", json=payload
        )
    except ApiError as exc:
        logger.warning("ubah pengingat gagal: %s", exc)
        return _error(exc)

    return JsonResponse(
        {"ok": True, "message": result.get("message", ""), "task": result.get("task")}
    )


@require_http_methods(["DELETE"])
@same_origin_json
def delete_task(request, task_id: str):
    """Hapus tugas."""
    if not _valid_task_id(task_id):
        return JsonResponse({"ok": False, "error": "Id tugas tidak valid."}, status=400)

    try:
        result = backend_api.request("DELETE", f"/tasks/{task_id}")
    except ApiError as exc:
        logger.warning("hapus tugas gagal: %s", exc)
        return _error(exc)

    return JsonResponse(
        {"ok": True, "message": result.get("message", "Tugas dihapus.")}
    )


@require_http_methods(["PATCH"])
@same_origin_json
def update_task(request, task_id: str):
    """Ubah field tugas yang sudah ada → ``PATCH /tasks/<id>``.

    Backend hanya mengubah field yang benar-benar dikirim
    (``model_dump(exclude_unset=True)``), jadi field yang tidak disebut di
    payload tetap apa adanya.

    Validasi enum dilakukan di sini supaya kesalahan ketik (mis. prioritas
    "Mendesak" alih-alih "urgent") ditolak dengan pesan yang jelas, bukan
    422 dari Pydantic yang sulit dibaca.
    """
    if not _valid_task_id(task_id):
        return JsonResponse({"ok": False, "error": "Id tugas tidak valid."}, status=400)

    data = _json_body(request)
    payload: dict = {}

    if "title" in data:
        title = (data.get("title") or "").strip()
        if not title:
            return JsonResponse(
                {"ok": False, "error": "Nama tugas tidak boleh kosong."}, status=400
            )
        if len(title) > 500:
            return JsonResponse(
                {"ok": False, "error": "Nama tugas maksimal 500 karakter."}, status=400
            )
        payload["title"] = title

    if "description" in data:
        description = (data.get("description") or "").strip()
        payload["description"] = description or None

    if "due_date" in data:
        due_date = _normalize_due_date(data.get("due_date") or "")
        if not due_date:
            return JsonResponse(
                {"ok": False, "error": "Tanggal dan waktu tenggat wajib diisi."},
                status=400,
            )
        payload["due_date"] = due_date

    if "priority" in data:
        priority = (data.get("priority") or "").strip().lower()
        if priority not in TASK_PRIORITIES:
            return JsonResponse(
                {"ok": False, "error": f"Prioritas tidak dikenal: {priority}."},
                status=400,
            )
        payload["priority"] = priority

    if "type" in data:
        task_type = (data.get("type") or "").strip().lower()
        if task_type not in TASK_TYPES:
            return JsonResponse(
                {"ok": False, "error": f"Jenis tugas tidak dikenal: {task_type}."},
                status=400,
            )
        payload["type"] = task_type

    if "status" in data:
        status = (data.get("status") or "").strip().lower()
        if status not in TASK_STATUSES:
            return JsonResponse(
                {"ok": False, "error": f"Status tidak dikenal: {status}."}, status=400
            )
        payload["status"] = status

    if "course_id" in data:
        course_id = (data.get("course_id") or "").strip() or None
        payload["course_id"] = course_id

    if "reminder_enabled" in data:
        payload["reminder_enabled"] = bool(data["reminder_enabled"])

    if "reminder_time" in data:
        try:
            reminder_time = _validate_reminder_time(data["reminder_time"])
        except ValueError as exc:
            return JsonResponse({"ok": False, "error": str(exc)}, status=400)
        payload["reminder_time"] = reminder_time
        if reminder_time is None:
            # Mematikan pengingat tanpa waktu = mematikan pengingatnya.
            payload.setdefault("reminder_enabled", False)

    if not payload:
        return JsonResponse(
            {"ok": False, "error": "Tidak ada field tugas yang diperbarui."}, status=400
        )

    try:
        task = backend_api.request("PATCH", f"/tasks/{task_id}", json=payload)
    except ApiError as exc:
        logger.warning("ubah tugas %s gagal: %s", task_id, exc)
        return _error(exc)

    return JsonResponse({"ok": True, "task": task})
