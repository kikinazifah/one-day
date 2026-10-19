"""Endpoint JSON untuk halaman dashboard — jembatan ke backend FastAPI.

Alur Document Creator:

    browser ──POST /api/document/generate/──▶ Django ──▶ FastAPI /documents/generate
    browser ──POST /api/document/preview/───▶ Django ──▶ FastAPI /documents/preview
    browser ──POST /api/document/save/──────▶ Django ──▶ FastAPI /documents/save
    browser ──GET  /api/document/download/<id>──▶ Django ──▶ FastAPI /documents/<id>/export

Draft hasil generate belum tersimpan di perpustakaan; ``save`` yang
memasukkannya. Browser memegang draft (id, content, filePath) di memori dan
mengirimkannya kembali saat pratinjau/simpan — pola yang sama dengan
frontend React (``DocumentCreatorPage.tsx``).
"""
from __future__ import annotations

import json
import logging
import re
from urllib.parse import urlparse

from django.http import FileResponse, JsonResponse
from django.utils.http import content_disposition_header
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_POST

from . import backend_api
from .backend_api import ApiError

logger = logging.getLogger(__name__)


def same_origin_json(method):
    """Dekorator untuk endpoint JSON: wajib same-origin.

    Endpoint ini memakai token service milik backend FastAPI, jadi POST dari
    situs lain akan menjalankan generate/save atas nama akun tersebut. Token
    CSRF tidak cocok untuk panggilan dari origin berbeda, jadi proteksi
    digeser ke pemeriksaan ``Origin``/``Referer``:

    * request dari origin yang sama → diterima (form HTML maupun fetch).
    * request tanpa Origin (mis. curl) → diterima; kredensial tetap di server.
    * request dari origin lain → 403.
    """
    from functools import wraps

    @wraps(method)
    @csrf_exempt
    def wrapper(request, *args, **kwargs):
        origin = request.META.get("HTTP_ORIGIN")
        if origin:
            host = request.get_host()
            if urlparse(origin).netloc != host:
                return JsonResponse(
                    {"ok": False, "error": "Permintaan ditolak: origin tidak cocok."},
                    status=403,
                )
        return method(request, *args, **kwargs)

    return wrapper


# Jenis dokumen di UI (Bahasa Indonesia) → format file + template backend.
DOC_TYPES: dict[str, dict[str, str]] = {
    "Laporan akademik": {"type": "docx", "template": "report"},
    "Makalah": {"type": "docx", "template": "report"},
    "Proposal penelitian": {"type": "docx", "template": "proposal"},
    "Presentasi": {"type": "pptx", "template": "presentation"},
    "Ringkasan materi": {"type": "docx", "template": "blank"},
}

# Pilihan bahasa & panjang dirakit ke dalam prompt: backend hanya menerima
# satu field ``prompt``, jadi instruksi tambahan digabung di sini.
LANGUAGE_HINTS = {
    "Bahasa Indonesia": "Tulis seluruh isi dokumen dalam Bahasa Indonesia.",
    "Bahasa Inggris": "Write the entire document in English.",
}
LENGTH_HINTS = {
    "Singkat": "Panjang dokumen: singkat, padat, sekitar 1-2 halaman.",
    "Standar": "Panjang dokumen: standar, sekitar 3-5 halaman.",
    "Terperinci": "Panjang dokumen: terperinci dan mendalam.",
}

DOCX_MEDIA = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
)
_SAFE_DOWNLOAD_NAME = re.compile(r'filename\*?=(?:UTF-8\'\')?"?([^";]+)"?', re.IGNORECASE)


def _decode_filename(name: str) -> str:
    """Buang karakter yang tak aman dari nama file, tapi pertahankan aksara.

    Judul dokumen bisa mengandung spasi, aksara Indonesia, atau tanda baca.
    Yang berbahaya untuk header HTTP adalah newline/quote, jadi itu dibuang.
    """
    cleaned = re.sub(r'[^\w\-. ]+', "_", name, flags=re.UNICODE).strip(" ._")
    return cleaned[:120] or "dokumen"


def _json_body(request) -> dict:
    try:
        return json.loads(request.body or b"{}")
    except (ValueError, UnicodeDecodeError):
        return {}


def _error(exc: ApiError) -> JsonResponse:
    """ApiError → JSON yang bisa dibaca UI."""
    status = exc.status if 400 <= exc.status < 600 else 502
    return JsonResponse({"ok": False, "error": exc.detail}, status=status)


def _build_prompt(data: dict) -> str:
    """Gabungkan instruksi bebas + bahasa + panjang jadi satu prompt."""
    parts = [(data.get("description") or "").strip()]
    if data.get("subject"):
        parts.append(f"Mata kuliah: {data['subject'].strip()}.")
    hint = LANGUAGE_HINTS.get(data.get("language"))
    if hint:
        parts.append(hint)
    hint = LENGTH_HINTS.get(data.get("length"))
    if hint:
        parts.append(hint)
    return "\n".join(p for p in parts if p)


@require_POST
@same_origin_json
def generate_document(request):
    """Form Document Creator → draft dokumen dari backend."""
    data = _json_body(request)
    title = (data.get("title") or "").strip()
    prompt = _build_prompt(data)

    if not title:
        return JsonResponse({"ok": False, "error": "Judul dokumen wajib diisi."}, status=400)
    if not prompt:
        return JsonResponse(
            {"ok": False, "error": "Instruksi atau isi dokumen wajib diisi."}, status=400
        )

    kind = DOC_TYPES.get(data.get("type"), DOC_TYPES["Laporan akademik"])
    payload = {"title": title, "prompt": prompt, "type": kind["type"]}
    if kind["template"] != "blank":
        payload["templateId"] = kind["template"]

    try:
        document = backend_api.request(
            "POST", "/documents/generate", json=payload, timeout=backend_api.TIMEOUT_GENERATE,
        )
    except ApiError as exc:
        logger.warning("generate dokumen gagal: %s", exc)
        return _error(exc)

    return JsonResponse({"ok": True, "document": document})


@require_POST
@same_origin_json
def preview_document(request):
    """Draft/isi dokumen → HTML siap ditampilkan di panel pratinjau."""
    data = _json_body(request)
    payload = {
        "documentId": data.get("documentId"),
        "filePath": data.get("filePath"),
        "type": data.get("type"),
        "content": data.get("content"),
    }
    if not any(payload.values()):
        return JsonResponse(
            {"ok": False, "error": "Belum ada dokumen untuk dipratinjau."}, status=400
        )

    try:
        rendered = backend_api.request(
            "POST", "/documents/preview", json=payload, timeout=backend_api.TIMEOUT_GENERATE,
        )
    except ApiError as exc:
        logger.warning("pratinjau dokumen gagal: %s", exc)
        return _error(exc)

    return JsonResponse(
        {
            "ok": True,
            "html": rendered.get("html", ""),
            "format": rendered.get("format", ""),
            "renderer": rendered.get("renderer", ""),
        }
    )


@require_POST
@same_origin_json
def save_document(request):
    """Draft → perpustakaan dokumen milik akun service."""
    data = _json_body(request)
    payload = {
        "documentId": data.get("documentId"),
        "title": data.get("title"),
        "type": data.get("type"),
        "content": data.get("content"),
        "filePath": data.get("filePath"),
    }
    if not payload["content"]:
        return JsonResponse(
            {"ok": False, "error": "Dokumen belum di-generate."}, status=400
        )

    try:
        document = backend_api.request(
            "POST", "/documents/save", json=payload, timeout=backend_api.TIMEOUT_GENERATE,
        )
    except ApiError as exc:
        logger.warning("simpan dokumen gagal: %s", exc)
        return _error(exc)

    return JsonResponse({"ok": True, "document": document})


@require_GET
@same_origin_json
def download_document(request, document_id: str):
    """Unduh dokumen tersimpan sebagai docx/pptx/xlsx/pdf."""
    fmt = request.GET.get("format", "docx")
    if fmt not in ("docx", "pptx", "xlsx", "pdf"):
        return JsonResponse({"ok": False, "error": f"Format tidak didukung: {fmt}"}, status=400)

    try:
        content, content_type, disposition = backend_api.download(
            f"/documents/{document_id}/export", params={"format": fmt}
        )
    except ApiError as exc:
        logger.warning("unduh dokumen gagal: %s", exc)
        return _error(exc)

    # Ambil nama file dari Content-Disposition backend supaya hasil unduhan
    # memakai judul dokumen, bukan id.
    filename = f"dokumen.{fmt}"
    if disposition:
        match = _SAFE_DOWNLOAD_NAME.search(disposition)
        if match:
            filename = _decode_filename(match.group(1).strip())

    response = FileResponse(
        iter([content]),
        content_type=content_type or DOCX_MEDIA,
        filename=filename,
        as_attachment=True,
    )
    # FileResponse hanya menulis Content-Disposition kalau isinya file-like
    # (punya .read()); di sini isinya iterator byte, jadi header diset manual.
    response["Content-Disposition"] = content_disposition_header(True, filename)
    return response
