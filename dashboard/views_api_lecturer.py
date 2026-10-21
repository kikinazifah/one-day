"""Endpoint JSON untuk halaman AI Lecturer — jembatan ke backend FastAPI.

Alur AI Lecturer (Dosen AI):

    browser ──GET  /api/lecturer/personas/──────────▶ Django ──▶ FastAPI /lecturer/personas
    browser ──POST /api/lecturer/persona/──────────▶ Django ──▶ FastAPI /lecturer/persona
    browser ──PATCH/api/lecturer/persona/<id>/─────▶ Django ──▶ FastAPI /lecturer/persona/<id>
    browser ──POST /api/lecturer/chat/─────────────▶ Django ──▶ FastAPI /lecturer/chat
    browser ──GET  /api/lecturer/chat/<sid>/───────▶ Django ──▶ FastAPI /lecturer/chat/<sid>
    browser ──GET  /api/lecturer/reports/──────────▶ Django ──▶ FastAPI /lecturer/reports
    browser ──POST /api/lecturer/reports/generate/─▶ Django ──▶ FastAPI /lecturer/reports/generate
    browser ──GET  /api/lecturer/reports/jobs/────▶ Django ──▶ FastAPI /lecturer/reports/jobs
    browser ──GET  /api/lecturer/reports/jobs/<id>/▶ Django ─▶ FastAPI /lecturer/reports/jobs/<id>
    browser ──GET  /api/lecturer/reports/<id>/export/▶ Django ─▶ FastAPI /lecturer/reports/<id>/export
    browser ──GET  /api/lecturer/videos/───────────▶ Django ──▶ FastAPI /lecturer/videos
    browser ──POST /api/lecturer/videos/generate/─▶ Django ──▶ FastAPI /lecturer/videos/generate
    browser ──GET  /api/lecturer/videos/<id>/──────▶ Django ──▶ FastAPI /lecturer/videos/<id>
    browser ──GET  /api/lecturer/videos/<id>/file/─▶ Django ──▶ FastAPI /videos/<id>.mp4 (root)

Pola view mengikuti ``dashboard/views_api.py``: dekorator ``same_origin_json``,
badan JSON dibaca dengan ``_json_body``, error dari backend diterjemahkan
lewat ``_error``.
"""
from __future__ import annotations

import logging
import re

from django.http import FileResponse, JsonResponse
from django.utils.http import content_disposition_header
from django.views.decorators.http import require_GET, require_POST, require_http_methods

from . import backend_api
from .backend_api import ApiError
from .views_api import _error, _json_body, same_origin_json

logger = logging.getLogger(__name__)

# Gaya persona yang diterima backend (LecturerPersonaBase.style).
PERSONA_STYLES = ("strict", "friendly", "professional", "casual", "enthusiastic")

# Gaya video yang diterima backend (ALLOWED_VIDEO_STYLES di
# app/services/video_pipeline.py). Backend juga menolak 422 — validasi di
# sini supaya pesan yang muncul di UI Django menyebut daftar pilihannya.
VIDEO_STYLES = ("professional", "casual", "animated", "slideshow")

# Nama file video backend: "<uuid>.mp4". Tolak yang lain supaya endpoint proxy
# ini tidak bisa dipakai untuk menjangkau file lain di origin FastAPI.
_VIDEO_NAME = re.compile(r"^[0-9a-fA-F-]{36}\.(mp4|webm|mov)$")

# Id sesi chat backend: UUID string. Id ini masuk ke path URL backend, jadi
# karakter lain harus ditolak — kalau tidak, `../../` bisa dipakai untuk
# menjangkau path lain di origin FastAPI.
_SESSION_ID_OK = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# Id job laporan dibuat backend sebagai uuid4 — huruf, angka, dan tanda
# hubung. Pola ini dipakai untuk memvalidasi id sebelum diteruskan ke
# backend, supaya path traversal tidak pernah sampai ke FastAPI.
_JOB_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

VIDEO_MEDIA = "video/mp4"


def _range_headers(request) -> dict:
    """Header ``Range`` dari browser, diteruskan ke backend.

    Pola yang sama dengan ``views_api_lecture.py`` — dipakai supaya
    pemutar video bisa meminta sebagian berkas, bukan seluruhnya.
    """
    header = request.META.get("HTTP_RANGE", "").strip()
    return {"Range": header} if header else {}


def _clean(value, limit: int = 4000) -> str:
    """Bersihkan string dari form: potong panjangnya dan buang spasi excess."""
    if value is None:
        return ""
    return str(value).strip()[:limit]


def _persona_payload(data: dict) -> dict:
    """Badan POST/PATCH persona → payload backend (tanpa field tak dikenal)."""
    payload: dict = {}

    name = _clean(data.get("name"), 255)
    if name:
        payload["name"] = name

    style = _clean(data.get("style"), 32).lower()
    if style:
        if style not in PERSONA_STYLES:
            raise ValueError(
                "Gaya persona harus salah satu dari: " + ", ".join(PERSONA_STYLES) + "."
            )
        payload["style"] = style

    for field, limit in (
        ("teaching_style", 2000),
        ("special_needs", 2000),
        ("custom_prompt", 4000),
        ("language", 50),
    ):
        if field in data:
            payload[field] = _clean(data.get(field), limit) or None

    if "is_active" in data:
        payload["is_active"] = bool(data.get("is_active"))

    if "course_id" in data:
        payload["course_id"] = _clean(data.get("course_id"), 36) or None

    return payload


# ------------------------------------------------------------------ persona


@require_GET
@same_origin_json
def lecturer_personas(request):
    """Daftar persona milik pengguna."""
    try:
        personas = backend_api.request("GET", "/lecturer/personas")
    except ApiError as exc:
        logger.warning("ambil persona gagal: %s", exc)
        return _error(exc)

    return JsonResponse(
        {"ok": True, "personas": personas if isinstance(personas, list) else []}
    )


@require_GET
@same_origin_json
def lecturer_persona_detail(request):
    """Persona aktif — backend otomatis membuatnya kalau belum ada.

    Dipakai halaman saat pengguna belum punya persona sama sekali, supaya
    chat selalu punya dosen untuk berdiskusi.

    Catatan: ``GET /lecturer/persona`` di backend memakai ``scalar_one_or_none``,
    jadi ia melempar 500 kalau pengguna punya lebih dari satu persona AKTIF.
    Karena itu di sini persona aktif lebih dulu dicari lewat daftar
    (``/lecturer/personas``); endpoint backend baru dipanggil kalau memang
    belum ada persona sama sekali — kondisi di mana backend pasti membuat
    persona default.
    """
    params = {}
    course_id = _clean(request.GET.get("course_id"), 64)
    if course_id:
        params["course_id"] = course_id

    try:
        personas = backend_api.request("GET", "/lecturer/personas")
    except ApiError as exc:
        logger.warning("ambil daftar persona gagal: %s", exc)
        return _error(exc)

    if isinstance(personas, list):
        active = [p for p in personas if p.get("is_active")]
        if course_id:
            scoped = [p for p in active if p.get("course_id") == course_id]
            if scoped:
                return JsonResponse({"ok": True, "persona": scoped[0]})
        if active:
            return JsonResponse({"ok": True, "persona": active[0]})

    # Belum ada persona aktif → backend membuat persona default.
    try:
        persona = backend_api.request("GET", "/lecturer/persona", params=params or None)
    except ApiError as exc:
        logger.warning("ambil persona aktif gagal: %s", exc)
        return _error(exc)

    return JsonResponse({"ok": True, "persona": persona})


@require_POST
@same_origin_json
def lecturer_persona_create(request):
    """Buat persona baru."""
    data = _json_body(request)
    try:
        payload = _persona_payload(data)
    except ValueError as exc:
        return JsonResponse({"ok": False, "error": str(exc)}, status=400)

    if not payload.get("name"):
        return JsonResponse({"ok": False, "error": "Nama persona wajib diisi."}, status=400)
    if not payload.get("style"):
        return JsonResponse({"ok": False, "error": "Gaya persona wajib diisi."}, status=400)

    try:
        persona = backend_api.request("POST", "/lecturer/persona", json=payload)
    except ApiError as exc:
        logger.warning("buat persona gagal: %s", exc)
        return _error(exc)

    return JsonResponse({"ok": True, "persona": persona}, status=201)


@require_http_methods(["PATCH", "POST"])
@same_origin_json
def lecturer_persona_update(request, persona_id: str):
    """Ubah persona (PATCH ke backend)."""
    data = _json_body(request)
    try:
        payload = _persona_payload(data)
    except ValueError as exc:
        return JsonResponse({"ok": False, "error": str(exc)}, status=400)

    if not payload:
        return JsonResponse(
            {"ok": False, "error": "Tidak ada field persona yang diubah."}, status=400
        )

    try:
        persona = backend_api.request("PATCH", f"/lecturer/persona/{persona_id}", json=payload)
    except ApiError as exc:
        logger.warning("ubah persona gagal: %s", exc)
        return _error(exc)

    return JsonResponse({"ok": True, "persona": persona})


# --------------------------------------------------------------------- chat


@require_POST
@same_origin_json
def lecturer_chat(request):
    """Kirim pesan ke Dosen AI → balasan teks + id sesi."""
    data = _json_body(request)
    persona_id = _clean(data.get("persona_id"), 64)
    message = _clean(data.get("message"), 8000)

    if not persona_id:
        return JsonResponse({"ok": False, "error": "Persona belum dipilih."}, status=400)
    if not message:
        return JsonResponse({"ok": False, "error": "Pesan tidak boleh kosong."}, status=400)

    payload = {"persona_id": persona_id, "message": message}
    course_id = _clean(data.get("course_id"), 64)
    if course_id:
        payload["course_id"] = course_id
    if "use_rag" in data:
        payload["use_rag"] = bool(data.get("use_rag"))

    # Sesi tujuan. Kalau tidak dikirim, backend memakai sesi terakhir
    # persona (perilaku lama). Kalau dikirim, pesannya menempel ke sesi
    # itu — itulah yang membuat "mulai percakapan baru" benar-benar baru.
    session_id = _clean(data.get("session_id"), 64)
    if session_id:
        if not _SESSION_ID_OK.fullmatch(session_id):
            return JsonResponse(
                {"ok": False, "error": "Id sesi tidak valid."}, status=400
            )
        payload["session_id"] = session_id

    try:
        result = backend_api.request(
            "POST", "/lecturer/chat", json=payload, timeout=backend_api.TIMEOUT_LLM,
        )
    except ApiError as exc:
        logger.warning("chat dosen gagal: %s", exc)
        return _error(exc)

    return JsonResponse(
        {
            "ok": True,
            "response": result.get("response", ""),
            "session_id": result.get("session_id"),
            # `sources` backend selalu kosong; tetap diteruskan agar kontrak
            # backend tetap utuh kalau nanti mulai diisi.
            "sources": result.get("sources") or [],
        }
    )


@require_GET
@same_origin_json
def lecturer_chat_history(request, session_id: str):
    """Riwayat percakapan satu sesi."""
    if not _SESSION_ID_OK.fullmatch(session_id or ""):
        return JsonResponse({"ok": False, "error": "Id sesi tidak valid."}, status=400)

    try:
        history = backend_api.request("GET", f"/lecturer/chat/{session_id}")
    except ApiError as exc:
        logger.warning("ambil riwayat chat gagal: %s", exc)
        return _error(exc)

    return JsonResponse(
        {
            "ok": True,
            "session": history.get("session") or {},
            # `messages` adalah saudara dari `session`, bukan di dalamnya.
            "messages": history.get("messages") or [],
        }
    )


@require_POST
@same_origin_json
def lecturer_chat_session_create(request):
    """Buat sesi chat baru → id sesi.

    Dipanggil tombol "mulai percakapan baru". Tanpa ini, Clear hanya
    bisa mengosongkan tampilan — pesannya tetap menempel di sesi lama
    dan muncul lagi saat halaman dimuat ulang.
    """
    data = _json_body(request)
    persona_id = _clean(data.get("persona_id"), 64)

    if not persona_id:
        return JsonResponse({"ok": False, "error": "Persona belum dipilih."}, status=400)

    params = {"persona_id": persona_id}
    title = _clean(data.get("title"), 200)
    if title:
        params["title"] = title

    try:
        session = backend_api.request(
            "POST", "/lecturer/chat/sessions", params=params,
            timeout=backend_api.TIMEOUT_DEFAULT,
        )
    except ApiError as exc:
        logger.warning("buat sesi chat dosen gagal: %s", exc)
        return _error(exc)

    return JsonResponse(
        {"ok": True, "session": session if isinstance(session, dict) else {}},
        status=201,
    )


@require_POST
@same_origin_json
def lecturer_chat_session_delete(request, session_id: str):
    """Hapus satu sesi chat beserta pesannya."""
    if not _SESSION_ID_OK.fullmatch(session_id or ""):
        return JsonResponse({"ok": False, "error": "Id sesi tidak valid."}, status=400)

    try:
        backend_api.request("DELETE", f"/lecturer/chat/{session_id}")
    except ApiError as exc:
        logger.warning("hapus sesi chat dosen gagal: %s", exc)
        return _error(exc)

    return JsonResponse({"ok": True})


# ------------------------------------------------------------------ laporan


@require_GET
@same_origin_json
def lecturer_reports(request):
    """Daftar laporan mingguan (opsional difilter per mata kuliah)."""
    params = {}
    course_id = _clean(request.GET.get("course_id"), 64)
    if course_id:
        params["course_id"] = course_id

    try:
        reports = backend_api.request("GET", "/lecturer/reports", params=params or None)
    except ApiError as exc:
        logger.warning("ambil laporan gagal: %s", exc)
        return _error(exc)

    return JsonResponse({"ok": True, "reports": reports if isinstance(reports, list) else []})


@require_POST
@same_origin_json
def lecturer_reports_generate(request):
    """Trigger pembuatan laporan mingguan (proses di background backend).

    Backend endpoint ini tidak menerima body — ``course_id`` dikirim sebagai
    query param.
    """
    data = _json_body(request)
    course_id = _clean(data.get("course_id") or request.GET.get("course_id"), 64)
    params = {"course_id": course_id} if course_id else None

    try:
        result = backend_api.request("POST", "/lecturer/reports/generate", params=params)
    except ApiError as exc:
        logger.warning("generate laporan gagal: %s", exc)
        return _error(exc)

    return JsonResponse(
        {
            "ok": True,
            "message": result.get("message", "Laporan sedang dibuat."),
            "task_id": result.get("task_id"),
            # Pembuatan laporan berjalan di latar belakang. Tanpa
            # ``job_id`` halaman tidak bisa menampilkan status prosesnya —
            # cuma tahu "sedang jalan" tanpa tahu selesai atau gagal.
            "job_id": result.get("job_id"),
            "job": result.get("job") or {},
        }
    )


@require_GET
@same_origin_json
def lecturer_report_jobs(request):
    """Daftar proses pembuatan laporan (terbaru dulu)."""
    try:
        jobs = backend_api.request("GET", "/lecturer/reports/jobs")
    except ApiError as exc:
        logger.warning("ambil daftar job laporan gagal: %s", exc)
        return _error(exc)

    return JsonResponse({"ok": True, "jobs": jobs if isinstance(jobs, list) else []})


@require_GET
@same_origin_json
def lecturer_report_job(request, job_id: str):
    """Status satu proses pembuatan laporan — dipakai polling."""
    cleaned = (job_id or "").strip()

    # Id job dibuat backend sebagai uuid4 — mengandung tanda hubung, jadi
    # ``isalnum()`` akan menolaknya.
    if not cleaned or len(cleaned) > 64 or not _JOB_ID_RE.fullmatch(cleaned):
        return JsonResponse({"ok": False, "error": "Id job tidak valid."}, status=400)

    try:
        job = backend_api.request("GET", f"/lecturer/reports/jobs/{cleaned}")
    except ApiError as exc:
        logger.warning("ambil status job laporan %s gagal: %s", cleaned, exc)
        return _error(exc)

    return JsonResponse({"ok": True, "job": job if isinstance(job, dict) else {}})


@require_GET
@same_origin_json
def lecturer_report_export(request, report_id: str):
    """Proxy unduhan laporan mingguan (.docx).

    Berkas dibangun backend dari data laporan, bukan disimpan di Django —
    jadi BFF hanya meneruskan byte dan nama file. ``?download=1`` memaksa
    unduhan; tanpa itu pun tetap attachment karena tidak ada yang bisa
    menampilkan .docx di tab browser.
    """
    cleaned = (report_id or "").strip()
    if not cleaned or len(cleaned) > 64 or not _JOB_ID_RE.fullmatch(cleaned):
        return JsonResponse({"ok": False, "error": "Id laporan tidak valid."}, status=400)

    try:
        file = backend_api.download(f"/lecturer/reports/{cleaned}/export")
    except ApiError as exc:
        logger.warning("unduh laporan %s gagal: %s", cleaned, exc)
        return _error(exc)

    # Nama file ikut dari backend lewat Content-Disposition; kalau tidak
    # ada, pakai nama yang masih bisa dikenali pengguna.
    filename = f"laporan-mingguan-{cleaned}.docx"
    disposition = file.disposition or ""
    match = re.search(r'filename="?([^";]+)"?', disposition)
    if match:
        filename = match.group(1)

    response = FileResponse(
        iter([file.content]),
        content_type=(
            file.content_type
            or "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        ),
    )
    response["Content-Disposition"] = content_disposition_header(True, filename)
    return response


# --------------------------------------------------------------------- video


@require_GET
@same_origin_json
def lecturer_videos(request):
    """Daftar job video ajar (opsional difilter per mata kuliah)."""
    params = {}
    course_id = _clean(request.GET.get("course_id"), 64)
    if course_id:
        params["course_id"] = course_id

    try:
        jobs = backend_api.request("GET", "/lecturer/videos", params=params or None)
    except ApiError as exc:
        logger.warning("ambil job video gagal: %s", exc)
        return _error(exc)

    return JsonResponse({"ok": True, "videos": jobs if isinstance(jobs, list) else []})


@require_POST
@same_origin_json
def lecturer_video_create(request):
    """Buat job video ajar baru."""
    data = _json_body(request)
    material = _clean(data.get("material"), 20000)
    if not material:
        return JsonResponse({"ok": False, "error": "Materi ajar wajib diisi."}, status=400)

    payload: dict = {"material": material}
    video_style = _clean(data.get("video_style"), 50)
    if video_style:
        if video_style not in VIDEO_STYLES:
            return JsonResponse(
                {
                    "ok": False,
                    "error": "Gaya video harus salah satu dari: "
                    + ", ".join(VIDEO_STYLES)
                    + ".",
                },
                status=422,
            )
        payload["video_style"] = video_style
    for field in ("course_id", "persona_id"):
        value = _clean(data.get(field), 64)
        if value:
            payload[field] = value

    try:
        result = backend_api.request("POST", "/lecturer/videos/generate", json=payload)
    except ApiError as exc:
        logger.warning("generate video gagal: %s", exc)
        return _error(exc)

    return JsonResponse(
        {
            "ok": True,
            "message": result.get("message", "Video sedang dibuat."),
            "job": result.get("job") or {},
        },
        status=201,
    )


@require_GET
@same_origin_json
def lecturer_video_detail(request, job_id: str):
    """Detail satu job video — dipakai polling status."""
    try:
        job = backend_api.request("GET", f"/lecturer/videos/{job_id}")
    except ApiError as exc:
        logger.warning("ambil detail video gagal: %s", exc)
        return _error(exc)

    return JsonResponse({"ok": True, "job": job})


@require_GET
@same_origin_json
def lecturer_video_file(request, job_id: str):
    """Proxy file video dari backend (disajikan dari root site, bukan /api/v1).

    Backend menulis video ke ``VIDEO_DIR`` dan melayaninya lewat static mount
    ``/videos`` di root, jadi URL-nya harus dibangun dari origin backend —
    bukan dari base URL API.
    """
    try:
        job = backend_api.request("GET", f"/lecturer/videos/{job_id}")
    except ApiError as exc:
        logger.warning("ambil job video gagal: %s", exc)
        return _error(exc)

    video_url = job.get("video_url") or ""
    filename = video_url.rsplit("/", 1)[-1] if video_url else f"{job_id}.mp4"

    if not _VIDEO_NAME.match(filename):
        return JsonResponse(
            {"ok": False, "error": "File video tidak valid."}, status=400
        )

    try:
        file = backend_api.download(
            f"/videos/{filename}", origin=True, headers=_range_headers(request)
        )
    except ApiError as exc:
        logger.warning("unduh video gagal: %s", exc)
        return _error(exc)

    response = FileResponse(
        iter([file.content]),
        content_type=file.content_type or VIDEO_MEDIA,
        filename=filename,
        as_attachment=False,
        # Teruskan status dari backend apa adanya — 206 kalau browser
        # meminta sebagian berkas (Range), 200 kalau minta utuh.
        status=file.status,
    )
    # FileResponse hanya menulis Content-Disposition kalau isinya file-like
    # (punya .read()); di sini isinya iterator byte, jadi header diset manual.
    # ``?download=1`` memaksa unduhan; tanpa itu file dibuka inline (diputar).
    as_attachment = request.GET.get("download") in ("1", "true", "yes")
    response["Content-Disposition"] = content_disposition_header(
        as_attachment, filename
    )

    # Teruskan header range apa adanya — pola yang sama dengan endpoint
    # rekaman audio. Tanpa ini, ``<video preload="metadata">`` akan
    # meminta seluruh berkas (36 MB!) sebelum halaman selesai memuat, dan
    # `waitUntil: "networkidle"` di browser test tidak pernah tercapai.
    for key, value in file.headers.items():
        if key.lower() == "content-length":
            continue
        response[key] = value

    response["Accept-Ranges"] = "bytes"
    return response
