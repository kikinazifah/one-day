"""Endpoint JSON untuk halaman Lecture Listener — jembatan ke backend FastAPI.

Alur rekaman:

    browser ──POST /api/lecture/start/──────▶ Django ──▶ FastAPI POST /lecture/start
    browser ──POST /api/lecture/<id>/audio/─▶ Django ──▶ FastAPI POST /lecture/<id>/audio
    browser ──POST /api/lecture/<id>/chunks/▶ Django ──▶ FastAPI POST /lecture/<id>/chunks
    browser ──GET  /api/lecture/<id>/live/──▶ Django ──▶ FastAPI GET  /lecture/<id>/live
    browser ──POST /api/lecture/<id>/stop/──▶ Django ──▶ FastAPI POST /lecture/<id>/stop
    browser ──GET  /api/lecture/<id>/status/─▶ Django ──▶ FastAPI GET  /lecture/<id>/status
    browser ──GET  /api/lecture/<id>/transcript/▶ Django ▶ FastAPI GET  /lecture/<id>/transcript
    browser ──GET  /api/lecture/<id>/summary/▶ Django ──▶ FastAPI GET  /lecture/<id>/summary
    browser ──GET  /api/lecture/─────────────▶ Django ──▶ FastAPI GET  /lecture/

Pola sama seperti ``dashboard/views_api.py``: token service dipegang Django,
browser tidak pernah melihat JWT. Helper (``same_origin_json``, ``_error``)
dipakai ulang supaya aturan proteksi seragam di semua halaman.

Catatan penting soal alur backend:

* ``POST /lecture/start`` mengembalikan objek ringkas, **bukan** objek session
  penuh: ``{"session_id", "status", "message"}``. Yang dipakai di UI adalah
  ``session_id``.
* ``POST /lecture/<id>/audio`` hanya menandai status ``transcribing`` lalu
  men-*kick off* transkripsi di background. **Transkrip belum ada** saat
  respons balik — browser harus polling ``/status`` sampai ``completed``
  (atau ``failed``).
* ``POST /lecture/<id>/stop`` juga men-set status ``transcribing``, bukan
  ``completed``. Karena itu urutan yang dipakai UI: rekam → stop → upload →
  polling status → ambil transkrip & ringkasan.
* **Jalur live** (FR-05): browser mengirim potongan PCM mentah ke
  ``POST /lecture/<id>/chunks`` setiap beberapa detik, lalu mem-poll
  ``GET /lecture/<id>/live`` untuk melihat transkrip parsial. Saat
  berhenti, server menggabungkan semua potongan menjadi satu WAV dan
  menjalankan transkripsi utuh.
"""
from __future__ import annotations

import json
import logging

from django.http import (
    HttpResponse,
    HttpResponseBadRequest,
    HttpResponseForbidden,
    HttpResponseNotFound,
    JsonResponse,
)
from django.views.decorators.http import require_GET, require_POST, require_http_methods

from . import backend_api
from .backend_api import ApiError
from .views_api import _error, _json_body, _same_origin, same_origin_json

logger = logging.getLogger(__name__)

# Batas ukuran rekaman yang diteruskan ke backend. Backend punya batasnya
# sendiri (``MAX_AUDIO_SIZE``, 100 MB); nilai di sini sedikit lebih kecil
# supaya file yang kelewat besar ditolak lebih awal di Django.
MAX_UPLOAD_BYTES = 100 * 1024 * 1024

# Batas ukuran satu potongan audio live. Potongan normal 4 detik @16 kHz
# = 128.000 byte, jadi batas ini hanya menahan request yang tidak wajar.
MAX_CHUNK_BYTES = 2_000_000


def _session_id(session_id: str) -> str | None:
    """Validasi bentuk id sesi sebelum dipakai di path backend.

    Id sesi dibuat backend sebagai UUID string. Menolak id dengan karakter
    lain mencegah penyisipan path traversal ke URL backend (``/lecture/../..``).
    """
    cleaned = (session_id or "").strip()
    if not cleaned or len(cleaned) > 64:
        return None
    if not all(ch.isalnum() or ch in "-_" for ch in cleaned):
        return None
    return cleaned


@require_POST
@same_origin_json
def lecture_start(request):
    """Mulai sesi rekaman baru."""
    data = _json_body(request)

    title = str(data.get("title") or "").strip()
    if not title:
        return JsonResponse({"ok": False, "error": "Nama sesi wajib diisi."}, status=400)
    if len(title) > 500:
        return JsonResponse(
            {"ok": False, "error": "Nama sesi maksimal 500 karakter."}, status=400
        )

    payload: dict = {"title": title}

    description = str(data.get("description") or "").strip()
    if description:
        payload["description"] = description

    course_id = str(data.get("course_id") or "").strip()
    if course_id:
        payload["course_id"] = course_id

    try:
        result = backend_api.request("POST", "/lecture/start", json=payload)
    except ApiError as exc:
        logger.warning("mulai sesi rekaman gagal: %s", exc)
        return _error(exc)

    result = result if isinstance(result, dict) else {}

    return JsonResponse(
        {
            "ok": True,
            # Backend mengembalikan ``session_id`` (bukan ``id``) di endpoint
            # start — bedakan dengan objek session penuh di GET /lecture/.
            "session_id": result.get("session_id"),
            "status": result.get("status"),
            "message": result.get("message"),
        }
    )


@require_POST
@same_origin_json
def lecture_audio(request, session_id: str):
    """Unggah rekaman (multipart) → backend menjalankan Whisper di background."""
    sid = _session_id(session_id)
    if not sid:
        return JsonResponse({"ok": False, "error": "Id sesi tidak valid."}, status=400)

    upload = request.FILES.get("file")
    if upload is None:
        return JsonResponse(
            {"ok": False, "error": "Berkas audio tidak ditemukan (field 'file')."},
            status=400,
        )

    if upload.size <= 0:
        return JsonResponse({"ok": False, "error": "Berkas audio kosong."}, status=400)

    if upload.size > MAX_UPLOAD_BYTES:
        return JsonResponse(
            {
                "ok": False,
                "error": f"Berkas audio maksimal {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.",
            },
            status=413,
        )

    # Teruskan apa adanya sebagai multipart — JANGAN base64 ke dalam JSON:
    # backend menerima field multipart bernama ``file`` dan menyimpannya
    # ke disk untuk diproses Whisper.
    filename = upload.name or "recording.webm"
    content_type = upload.content_type or "application/octet-stream"

    try:
        result = backend_api.request(
            "POST",
            f"/lecture/{sid}/audio",
            files={"file": (filename, upload, content_type)},
            timeout=backend_api.TIMEOUT_UPLOAD_AUDIO,
        )
    except ApiError as exc:
        logger.warning("unggah audio sesi %s gagal: %s", sid, exc)
        return _error(exc)

    result = result if isinstance(result, dict) else {}

    return JsonResponse(
        {
            "ok": True,
            "session_id": result.get("session_id", sid),
            "filename": result.get("filename"),
            "size": result.get("size"),
            # Selalu ``transcribing``: transkrip BELUM ada saat ini, browser
            # harus polling /status sampai ``completed``.
            "status": result.get("status", "transcribing"),
            "message": result.get("message"),
        }
    )


@require_POST
@same_origin_json
def lecture_chunk(request, session_id: str):
    """Terima satu potongan audio live (PCM mentah) → backend.

    Body-nya adalah PCM 16-bit mono mentah, dikirim sebagai
    ``application/octet-stream``. Bukan multipart dan bukan JSON — PCM
    tidak punya konsep field, dan dibungkus base64 ukurannya jadi 4/3
    lebih besar tanpa advantage.

    Query parameter:

    * ``seq`` — nomor urut potongan (mulai dari 0).
    * ``rate`` — sample rate potongan (default 16000).
    """
    sid = _session_id(session_id)
    if not sid:
        return JsonResponse({"ok": False, "error": "Id sesi tidak valid."}, status=400)

    try:
        seq = int(request.GET.get("seq", ""))
    except (TypeError, ValueError):
        return JsonResponse(
            {"ok": False, "error": "Nomor potongan (seq) tidak valid."}, status=400
        )

    if seq < 0 or seq > 1_000_000:
        return JsonResponse(
            {"ok": False, "error": "Nomor potongan di luar rentang."}, status=400
        )

    try:
        rate = int(request.GET.get("rate", "16000"))
    except (TypeError, ValueError):
        return JsonResponse(
            {"ok": False, "error": "Sample rate tidak valid."}, status=400
        )

    if rate not in (8000, 16000, 22050, 24000, 44100, 48000):
        return JsonResponse(
            {"ok": False, "error": "Sample rate tidak didukung."}, status=400
        )

    body = request.body

    if not body:
        return JsonResponse({"ok": False, "error": "Potongan kosong."}, status=400)

    if len(body) > MAX_CHUNK_BYTES:
        return JsonResponse(
            {
                "ok": False,
                "error": f"Potongan maksimal {MAX_CHUNK_BYTES} byte.",
            },
            status=413,
        )

    try:
        result = backend_api.request(
            "POST",
            f"/lecture/{sid}/chunks",
            params={"seq": seq, "rate": rate},
            content=body,
            headers={"Content-Type": "application/octet-stream"},
            timeout=backend_api.TIMEOUT_CHUNK,
        )
    except ApiError as exc:
        logger.warning("unggah potongan %s sesi %s gagal: %s", seq, sid, exc)
        return _error(exc)

    result = result if isinstance(result, dict) else {}

    return JsonResponse(
        {
            "ok": True,
            "session_id": result.get("session_id", sid),
            "seq": result.get("seq", seq),
            "rate": result.get("rate", rate),
            "bytes": result.get("bytes", len(body)),
            "duration_seconds": result.get("duration_seconds"),
            "task_id": result.get("task_id"),
        }
    )


@require_GET
@same_origin_json
def lecture_live(request, session_id: str):
    """Transkrip parsial selama rekaman — dipakai polling dari UI."""
    sid = _session_id(session_id)
    if not sid:
        return JsonResponse({"ok": False, "error": "Id sesi tidak valid."}, status=400)

    try:
        result = backend_api.request("GET", f"/lecture/{sid}/live")
    except ApiError as exc:
        logger.warning("ambil transkrip live %s gagal: %s", sid, exc)
        return _error(exc)

    result = result if isinstance(result, dict) else {}

    segments = result.get("segments")
    if not isinstance(segments, list):
        segments = []

    return JsonResponse(
        {
            "ok": True,
            "session_id": result.get("session_id", sid),
            "status": result.get("status"),
            "chunks_received": result.get("chunks_received", 0),
            "chunks_expected": result.get("chunks_expected", 0),
            "seconds_captured": result.get("seconds_captured", 0),
            "transcript": result.get("transcript") or "",
            "segments": segments,
        }
    )


@require_POST
@same_origin_json
def lecture_stop(request, session_id: str):
    """Akhiri sesi rekaman."""
    sid = _session_id(session_id)
    if not sid:
        return JsonResponse({"ok": False, "error": "Id sesi tidak valid."}, status=400)

    try:
        result = backend_api.request("POST", f"/lecture/{sid}/stop")
    except ApiError as exc:
        logger.warning("hentikan sesi %s gagal: %s", sid, exc)
        return _error(exc)

    result = result if isinstance(result, dict) else {}

    return JsonResponse(
        {
            "ok": True,
            "message": result.get("message", "Rekaman dihentikan."),
            # ``mode`` memberi tahu jalur mana yang dipakai: "live"
            # (potongan PCM digabung di server), "upload" (berkas penuh
            # diunggah), atau "empty" (tidak ada apa pun yang terekam).
            # Frontend membutuhkannya untuk tahu apakah harus menunggu
            # penggabungan chunk sebelum polling transkrip.
            "mode": result.get("mode", "empty"),
            "chunks": result.get("chunks", 0),
        }
    )


@require_GET
@same_origin_json
def lecture_status(request, session_id: str):
    """Status sesi — dipakai polling sampai transkripsi selesai."""
    sid = _session_id(session_id)
    if not sid:
        return JsonResponse({"ok": False, "error": "Id sesi tidak valid."}, status=400)

    try:
        result = backend_api.request("GET", f"/lecture/{sid}/status")
    except ApiError as exc:
        logger.warning("status sesi %s gagal: %s", sid, exc)
        return _error(exc)

    result = result if isinstance(result, dict) else {}

    return JsonResponse(
        {
            "ok": True,
            "session_id": result.get("session_id", sid),
            "status": result.get("status"),
            "duration_seconds": result.get("duration_seconds"),
            "transcript": result.get("transcript"),
            "summary": result.get("summary"),
            "started_at": result.get("started_at"),
            "ended_at": result.get("ended_at"),
        }
    )


@require_GET
@same_origin_json
def lecture_transcript(request, session_id: str):
    """Transkrip sesi beserta segmen bertimestamp."""
    sid = _session_id(session_id)
    if not sid:
        return JsonResponse({"ok": False, "error": "Id sesi tidak valid."}, status=400)

    try:
        result = backend_api.request("GET", f"/lecture/{sid}/transcript")
    except ApiError as exc:
        logger.warning("ambil transkrip %s gagal: %s", sid, exc)
        return _error(exc)

    result = result if isinstance(result, dict) else {}

    segments = result.get("segments")
    if not isinstance(segments, list):
        segments = []

    return JsonResponse(
        {
            "ok": True,
            "session_id": result.get("session_id", sid),
            "status": result.get("status"),
            "transcript": result.get("transcript") or "",
            # Segmen: field ``text`` (bukan ``content``), ``start``/``end``
            # berupa detik (float).
            "segments": segments,
            "summary": result.get("summary") or "",
        }
    )


@require_GET
@same_origin_json
def lecture_summary(request, session_id: str):
    """Ringkasan materi hasil summarization backend."""
    sid = _session_id(session_id)
    if not sid:
        return JsonResponse({"ok": False, "error": "Id sesi tidak valid."}, status=400)

    try:
        result = backend_api.request("GET", f"/lecture/{sid}/summary")
    except ApiError as exc:
        logger.warning("ambil ringkasan %s gagal: %s", sid, exc)
        return _error(exc)

    result = result if isinstance(result, dict) else {}

    return JsonResponse(
        {
            "ok": True,
            "summary": result.get("summary") or "",
        }
    )


@require_GET
@same_origin_json
def lecture_list(request):
    """Daftar sesi rekaman milik pengguna."""
    try:
        result = backend_api.request("GET", "/lecture/")
    except ApiError as exc:
        logger.warning("daftar sesi rekaman gagal: %s", exc)
        return _error(exc)

    sessions = result if isinstance(result, list) else []

    return JsonResponse({"ok": True, "sessions": sessions})


# ----------------------------------------------------------------------
# Tiket WebSocket (FR-04)
# ----------------------------------------------------------------------


@require_POST
@same_origin_json
def lecture_ticket(request):
    """Terbitkan tiket WebSocket untuk rekaman live.

    Browser membuka WebSocket **langsung ke FastAPI** (beda origin dari
    dashboard Django), jadi butuh kredensial sendiri. Backend menerbitkan
    tiket JWT bertipe ``ws_ticket`` — tipe yang ditolak ``get_current_user``,
    jadi tiket tidak bisa dipakai memanggil endpoint REST mana pun.

    Django memegang token service; yang sampai ke browser hanya tiket
    berumur pendek (default 60 detik).
    """
    try:
        result = backend_api.request("POST", "/lecture/ticket")
    except ApiError as exc:
        logger.warning("terbitkan tiket WS gagal: %s", exc)
        return _error(exc)

    result = result if isinstance(result, dict) else {}

    ticket = result.get("ticket")
    if not ticket:
        return JsonResponse(
            {"ok": False, "error": "Backend tidak menerbitkan tiket."}, status=502
        )

    # URL WebSocket dihitung di sini, bukan di browser, supaya browser
    # tidak perlu tahu port FastAPI — dan kalau AKADEMIA_API_URL berubah,
    # UI tidak ikut ubah.
    ws_base = backend_api.origin_url()
    ws_base = ws_base.replace("https://", "wss://").replace("http://", "ws://")

    return JsonResponse(
        {
            "ok": True,
            "ticket": ticket,
            "expires_in": result.get("expires_in"),
            "ws_base": ws_base,
        }
    )


# ----------------------------------------------------------------------
# Ekspor ke dokumen .docx (FR-05, FR-17)
# ----------------------------------------------------------------------


@require_POST
@same_origin_json
def lecture_export_doc(request, session_id: str):
    """Ekspor transkrip + ringkasan sesi menjadi dokumen ``.docx``.

    Hasilnya dokumen **sungguhan** (file ``.docx`` yang bisa diunduh), bukan
    sekadar payload JSON: backend ``POST /documents/save`` merender model
    dokumen ke file, membuat baris ``documents``, dan mengindeksnya ke RAG.

    ``courseId`` diteruskan dari sesi rekaman supaya dokumen hasil ekspor
    nempel ke mata kuliah yang benar (FR-17).
    """
    sid = _session_id(session_id)
    if not sid:
        return JsonResponse({"ok": False, "error": "Id sesi tidak valid."}, status=400)

    try:
        exported = backend_api.request("GET", f"/lecture/{sid}/export")
    except ApiError as exc:
        logger.warning("ambil data ekspor sesi %s gagal: %s", sid, exc)
        return _error(exc)

    exported = exported if isinstance(exported, dict) else {}

    transcript = str(exported.get("transcript") or "").strip()
    summary = str(exported.get("summary") or "").strip()

    if not transcript and not summary:
        return JsonResponse(
            {"ok": False, "error": "Transkrip masih kosong — rekaman belum selesai."},
            status=400,
        )

    # Metadata sesi (judul + mata kuliah) diambil terpisah supaya dokumen
    # bawa nama yang benar dan bisa ditempelkan ke course.
    title = "Transkrip Perkuliahan"
    course_id = None
    try:
        session_info = backend_api.request("GET", f"/lecture/{sid}")
        if isinstance(session_info, dict):
            title = str(session_info.get("title") or "").strip() or title
            course_id = session_info.get("course_id")
    except ApiError:
        # Metadata tidak wajib — ekspor tetap jalan tanpa judul/course.
        logger.info("metadata sesi %s tidak terbaca, ekspor tanpa course", sid)

    model = {
        "title": f"Transkrip — {title}",
        "sections": _lecture_sections(transcript, summary),
    }

    payload = {
        "title": model["title"],
        "type": "docx",
        # ``content`` harus berupa **string JSON** model — backend
        # mem-parse-nya lewat ``document_renderer.load_model``.
        "content": json.dumps(model, ensure_ascii=False),
    }
    if course_id:
        payload["courseId"] = course_id

    try:
        document = backend_api.request(
            "POST",
            "/documents/save",
            json=payload,
            timeout=backend_api.TIMEOUT_GENERATE,
        )
    except ApiError as exc:
        logger.warning("simpan dokumen ekspor sesi %s gagal: %s", sid, exc)
        return _error(exc)

    if not isinstance(document, dict):
        document = {}

    return JsonResponse(
        {
            "ok": True,
            "document": {
                "id": document.get("id"),
                "title": document.get("title"),
                "type": document.get("type"),
                "courseId": document.get("courseId"),
                "filePath": document.get("filePath"),
            },
        }
    )


def _lecture_sections(transcript: str, summary: str) -> list[dict]:
    """Susun section model dokumen dari transkrip + ringkasan.

    Struktur ini sama dengan yang dipakai Document Creator, jadi file
    ``.docx`` yang dihasilkan punya heading dan paragraf yang benar.
    """
    sections: list[dict] = []

    if summary:
        sections.append({"type": "heading", "content": "Ringkasan Materi", "level": 1})
        sections.append({"type": "paragraph", "content": summary})

    if transcript:
        sections.append({"type": "heading", "content": "Transkrip", "level": 1})
        sections.append({"type": "paragraph", "content": transcript})

    return sections


@require_http_methods(["DELETE", "POST"])
@same_origin_json
def lecture_delete(request, session_id: str):
    """Hapus sesi rekaman beserta transkrip dan berkas audionya.

    Backend ``DELETE /lecture/{id}`` menghapus baris sesi, segmen
    transkrip, dan berkas rekaman di disk. Tanpa jalur ini, sesi rekaman
    menumpuk selamanya di backend — tidak ada UI lain yang bisa membersihkannya.
    """
    sid = _session_id(session_id)
    if not sid:
        return JsonResponse({"ok": False, "error": "Id sesi tidak valid."}, status=400)

    try:
        backend_api.request("DELETE", f"/lecture/{sid}")
    except ApiError as exc:
        logger.warning("hapus sesi %s gagal: %s", sid, exc)
        return _error(exc)

    return JsonResponse({"ok": True, "message": "Sesi rekaman dihapus."})


@require_GET
def lecture_audio_file(request, session_id: str):
    """Teruskan berkas rekaman ke browser.

    Backend menyimpan berkas rekaman di ``uploads/lectures/`` tapi tidak
    menyajakannya lewat endpoint yang bisa dipakai tag ``<audio>``. Endpoint
    ini menutup gap itu: Django menarik berkas dari backend (dengan token
    service), lalu melayanannya sebagai respons biner.

    Sengaja TIDAK memakai ``same_origin_json`` — responsnya bukan JSON, dan
    decorator itu mengharuskan header JSON di balasan. Yang melindungi
    endpoint ini adalah ``Vary: Origin`` + pemeriksaan Origin di bawah.

    Rentang byte (``Range: bytes=...``) diteruskan supaya browser bisa
    mencari posisi di dalam rekaman panjang.
    """
    sid = _session_id(session_id)
    if not sid:
        return HttpResponseBadRequest("Id sesi tidak valid.")

    # Backend hanya melayani berkas milik akun service, jadi file bocor ke
    # orang lain hanya kalau token-nya ikut bocor — tetap, cek Origin supaya
    # halaman di domain lain tidak bisa menyalin rekaman lewat <audio src>.
    if not _same_origin(request):
        return HttpResponseForbidden("Permintaan dari origin lain ditolak.")

    try:
        file = backend_api.download(
            f"/lecture/{sid}/audio",
            headers=_range_headers(request),
        )
    except ApiError as exc:
        logger.warning("unduh audio sesi %s gagal: %s", sid, exc)
        if exc.status == 404:
            return HttpResponseNotFound("Rekaman tidak tersedia.")
        return HttpResponse(
            f"Rekaman tidak bisa diambil ({exc.detail}).",
            status=502,
            content_type="text/plain; charset=utf-8",
        )

    response = HttpResponse(
        file.content,
        content_type=file.content_type,
        status=file.status,
    )

    if file.disposition:
        response["Content-Disposition"] = file.disposition

    # Teruskan header range apa adanya. Tanpa ini, browser menerima 200
    # (berkas utuh) padahal hanya sebagian yang diminta, dan seek di
    # dalam rekaman rusak.
    for key, value in file.headers.items():
        if key.lower() == "content-length":
            continue
        response[key] = value

    response["Cache-Control"] = "private, max-age=3600"
    response["Accept-Ranges"] = "bytes"

    return response


def _range_headers(request) -> dict:
    """Header ``Range`` dari browser, diteruskan ke backend."""
    header = request.META.get("HTTP_RANGE", "").strip()
    return {"Range": header} if header else {}
