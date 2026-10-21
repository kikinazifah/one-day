"""Endpoint JSON untuk perpustakaan dokumen dan ekspor materi — jembatan ke
backend FastAPI (student-assistant).

Alur:

    browser ──GET  /api/library/documents/──────────▶ Django ──▶ FastAPI GET  /documents
    browser ──GET  /api/library/documents/<id>/──────▶ Django ──▶ FastAPI GET  /documents/<id>
    browser ──POST /api/library/documents/<id>/ocr/───▶ Django ──▶ FastAPI POST /documents/<id>/ocr
    browser ──GET  /api/lecture/<id>/export/──────────▶ Django ──▶ FastAPI GET  /lecture/<id>/export
    browser ──GET  /api/schedule/conflicts/──────────▶ Django ──▶ FastAPI GET  /schedule/conflicts

Kenapa file ini terpisah:

* **Perpustakaan dokumen** (``GET /documents``) belum pernah diekspos BFF.
  Tanpa itu, hasil "Simpan" di Document Creator tidak pernah bisa dilihat
  ulang — dokumen masuk ke backend tapi tidak ada layar yang menampilkannya.
* **Ekspor lecture** (``GET /lecture/<id>/export``) adalah FR-05
  ("mengekspor transkrip dan rangkuman ke dokumen"). Endpoint-nya ada di
  backend tapi tidak pernah dipakai.
* **Bentrok jadwal** (``GET /schedule/conflicts``) punya endpoint sendiri di
  backend. Sebelumnya tidak ada rute khusus, jadi konflik hanya bisa dibaca
  lewat payload ``GET /api/schedule/``. Sekarang jalurnya ada sendiri.

Semua endpoint memakai pola yang sama seperti modul lain: token service
dipegang Django, browser tidak pernah melihat JWT.
"""
from __future__ import annotations

import logging

from django.http import JsonResponse
from django.views.decorators.http import require_GET, require_POST, require_http_methods

from . import backend_api
from .backend_api import ApiError
from .views_api import _error, same_origin_json

logger = logging.getLogger(__name__)

# Batas ukuran unggah dokumen. Backend punya ``MAX_FILE_SIZE`` sendiri
# (10 MB); nilai di sini sama supaya pesan konsisten di kedua sisi.
MAX_UPLOAD_BYTES = 10 * 1024 * 1024


def _id_ok(value: str) -> bool:
    """Id aman untuk disisipkan ke path backend.

    Id dibuat backend sebagai UUID string. Menolak karakter lain mencegah
    path traversal (``/documents/../../..``).
    """
    cleaned = (value or "").strip()
    if not cleaned or len(cleaned) > 64:
        return False
    return all(ch.isalnum() or ch in "-_" for ch in cleaned)


# ------------------------------------------------------- perpustakaan dokumen


@require_GET
@same_origin_json
def library_documents(request):
    """Daftar dokumen tersimpan di perpustakaan.

    Backend menerima filter ``course_id`` dan ``limit``/``offset``; hanya
    ``course_id`` yang diteruskan supaya UI bisa menyaring per mata kuliah.

    Catatan bentuk respons: ``GET /documents/`` di backend mengembalikan
    **list polos** (``[_serialize(doc), ...]``), bukan objek dengan key
    ``documents``. Jadi hasilnya harus dibaca dua-duanya — kalau hanya
    ``result.get("documents")``, daftarnya selalu kosong.
    """
    params: dict = {}
    course_id = request.GET.get("course_id")
    if course_id:
        params["course_id"] = course_id

    try:
        result = backend_api.request("GET", "/documents/", params=params or None)
    except ApiError as exc:
        logger.warning("daftar dokumen gagal: %s", exc)
        return _error(exc)

    if isinstance(result, list):
        documents = result
    elif isinstance(result, dict):
        documents = result.get("documents") or []
    else:
        documents = []

    return JsonResponse({"ok": True, "documents": documents})


@require_POST
@same_origin_json
def library_document_upload(request):
    """Unggah berkas ke perpustakaan dokumen (PDF KRS, berkas referensi).

    Backend ``POST /documents/upload`` menyimpan berkas ke penyimpanan lokal
    dan membuat baris dokumen. Isinya belum terindeks untuk RAG - untuk itu
    jalankan OCR dulu (``/ocr/`` di bawah).

    Catatan bentuk respons: backend mengembalikan objek **flat** dengan
    ``id`` di level teratas - bukan dibungkus key ``document``. Di sini
    bentuknya dinormalkan jadi ``{"document": {...}}`` supaya konsisten
    dengan ``POST /rag/upload`` dan supaya UI bisa langsung memakai
    ``data.document.id`` untuk memicu OCR.
    """
    upload = request.FILES.get("file")
    if upload is None:
        return JsonResponse(
            {"ok": False, "error": "Berkas tidak ditemukan (field 'file')."}, status=400
        )

    if upload.size <= 0:
        return JsonResponse({"ok": False, "error": "Berkas kosong."}, status=400)

    # Batas ukuran: backend punya MAX_FILE_SIZE sendiri, tapi menolak lebih
    # awal di Django memberi pesan yang lebih jelas.
    if upload.size > MAX_UPLOAD_BYTES:
        return JsonResponse(
            {
                "ok": False,
                "error": f"Berkas terlalu besar (maksimum {MAX_UPLOAD_BYTES // (1024 * 1024)} MB).",
            },
            status=413,
        )

    name = upload.name or "dokumen"

    try:
        result = backend_api.request(
            "POST",
            "/documents/upload",
            files={"file": (name, upload, upload.content_type or "application/octet-stream")},
            timeout=backend_api.TIMEOUT_UPLOAD_AUDIO,
        )
    except ApiError as exc:
        logger.warning("unggah dokumen gagal: %s", exc)
        return _error(exc)

    result = result if isinstance(result, dict) else {}

    # Backend kirim flat; kalau suatu saat berubah ke nested, dua-duanya
    # tetap tertangani.
    document = result.get("document")
    if not isinstance(document, dict):
        document = {
            key: result[key]
            for key in (
                "id", "filename", "filePath", "size", "contentType",
                "courseId", "uploadedAt",
            )
            if key in result
        }

    return JsonResponse(
        {
            "ok": True,
            "message": result.get("message", "Dokumen tersimpan."),
            "document": document,
        },
        status=201,
    )


@require_GET
@same_origin_json
def library_document_detail(request, document_id: str):
    """Detail satu dokumen tersimpan."""
    if not _id_ok(document_id):
        return JsonResponse({"ok": False, "error": "Id dokumen tidak valid."}, status=400)

    try:
        document = backend_api.request("GET", f"/documents/{document_id}")
    except ApiError as exc:
        logger.warning("ambil dokumen %s gagal: %s", document_id, exc)
        return _error(exc)

    return JsonResponse({"ok": True, "document": document})


@require_http_methods(["DELETE", "POST"])
@same_origin_json
def library_document_delete(request, document_id: str):
    """Hapus dokumen dari perpustakaan.

    Backend ``DELETE /documents/{id}`` menghapus baris dokumen beserta
    berkas nativesnya. Tanpa jalur ini, dokumen yang terunggah dari UI
    Auto Scheduler menumpuk dan tidak bisa dibersihkan.
    """
    if not _id_ok(document_id):
        return JsonResponse({"ok": False, "error": "Id dokumen tidak valid."}, status=400)

    try:
        backend_api.request("DELETE", f"/documents/{document_id}")
    except ApiError as exc:
        logger.warning("hapus dokumen %s gagal: %s", document_id, exc)
        return _error(exc)

    return JsonResponse({"ok": True, "message": "Dokumen dihapus dari perpustakaan."})


@require_POST
@same_origin_json
def library_document_ocr(request, document_id: str):
    """Jalankan OCR untuk dokumen hasil unggahan (backend memproses di background)."""
    if not _id_ok(document_id):
        return JsonResponse({"ok": False, "error": "Id dokumen tidak valid."}, status=400)

    try:
        result = backend_api.request("POST", f"/documents/{document_id}/ocr")
    except ApiError as exc:
        logger.warning("jalankan OCR %s gagal: %s", document_id, exc)
        return _error(exc)

    result = result if isinstance(result, dict) else {}

    return JsonResponse(
        {
            "ok": True,
            "message": result.get("message", "OCR dimulai."),
            "task_id": result.get("taskId") or result.get("task_id"),
        }
    )


# ------------------------------------------------------------- ekspor lecture


@require_GET
@same_origin_json
def lecture_export(request, session_id: str):
    """Ekspor transkrip + ringkasan satu sesi rekaman (FR-05).

    Backend mengembalikan objek ``{transcript, summary}`` — bukan file. Dari
    situ UI bisa membuat dokumen lewat Document Creator.
    """
    if not _id_ok(session_id):
        return JsonResponse({"ok": False, "error": "Id sesi tidak valid."}, status=400)

    try:
        result = backend_api.request("GET", f"/lecture/{session_id}/export")
    except ApiError as exc:
        logger.warning("ekspor sesi %s gagal: %s", session_id, exc)
        return _error(exc)

    result = result if isinstance(result, dict) else {}

    return JsonResponse(
        {
            "ok": True,
            "transcript": result.get("transcript") or "",
            "summary": result.get("summary") or "",
        }
    )


# ------------------------------------------------------------ bentrok jadwal


@require_GET
@same_origin_json
def schedule_conflicts(request):
    """Daftar bentrok jadwal yang dihitung backend.

    Backend sudah mengembalikan ``conflicts`` di ``GET /schedule/``, tapi
    endpoint khusus ini berguna untuk polling bentrok saja tanpa memuat
    seluruh daftar jadwal.
    """
    try:
        result = backend_api.request("GET", "/schedule/conflicts")
    except ApiError as exc:
        logger.warning("ambil bentrok jadwal gagal: %s", exc)
        return _error(exc)

    result = result if isinstance(result, dict) else {}

    return JsonResponse({"ok": True, "conflicts": result.get("conflicts") or []})
