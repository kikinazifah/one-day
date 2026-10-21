"""Endpoint JSON untuk halaman dashboard — jembatan ke backend FastAPI.

Alur Document Creator:

    browser ──POST /api/document/generate/──▶ Django ──▶ FastAPI /documents/generate
    browser ──POST /api/document/preview/───▶ Django ──▶ FastAPI /documents/preview
    browser ──POST /api/document/save/──────▶ Django ──▶ FastAPI /documents/save
    browser ──GET  /api/document/download/<id>──▶ Django ──▶ FastAPI /documents/<id>/export

Panel editing blok (per edits per blok, byte-preserving):

    browser ──GET   /api/document/blocks/<id>/──▶ Django ──▶ FastAPI /documents/<id>/blocks
    browser ──PATCH /api/document/blocks/<id>/──▶ Django ──▶ FastAPI /documents/<id>/blocks
    browser ──POST  /api/document/agent/<id>/──▶ Django ──▶ FastAPI /documents/<id>/agent

Draft hasil generate belum tersimpan di perpustakaan; ``save`` yang
memasukkannya. Browser memegang draft (id, content, filePath) di memori dan
mengirimkannya kembali saat pratinjau/simpan — pola yang sama dengan
frontend React (``DocumentCreatorPage.tsx``).
"""
from __future__ import annotations

import json
import logging
import re
from urllib.parse import unquote, urlparse

from django.http import FileResponse, JsonResponse
from django.utils.http import content_disposition_header
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_POST, require_http_methods

from . import backend_api
from .backend_api import ApiError

logger = logging.getLogger(__name__)


def _same_origin(request) -> bool:
    """Apakah request datang dari origin yang sama dengan hosting dashboard.

    * request dengan ``Origin`` → harus cocok dengan host dashboard.
    * ``Origin`` kosong tapi ada ``Referer`` (navigasi/form biasa, klien lama)
      → ``Referer`` yang diperiksa. Tanpa ini, klien yang sengaja menghapus
      ``Origin`` lolos begitu saja.
    * keduanya tidak ada (curl, ``<audio src>``) → diterima; kredensial tetap
      di server, jadi tidak ada yang bisa diimingkit dari browser.
    """
    host = request.get_host()
    origin = request.META.get("HTTP_ORIGIN")
    if origin:
        return urlparse(origin).netloc == host

    referer = request.META.get("HTTP_REFERER")
    if referer:
        return urlparse(referer).netloc == host

    return True


def same_origin_json(method):
    """Dekorator untuk endpoint JSON: wajib same-origin.

    Endpoint ini memakai token service milik backend FastAPI, jadi POST dari
    situs lain akan menjalankan generate/save atas nama akun tersebut. Token
    CSRF tidak cocok untuk panggilan dari origin berbeda, jadi proteksi
    digeser ke pemeriksaan ``Origin``/``Referer`` — **bukan** token CSRF.
    Header ``X-CSRFToken`` yang dikirim ``api.js`` tidak divalidasi di sini.

    * ``Origin`` sama → diterima; ``Origin`` asing → 403.
    * ``Origin`` kosong tapi ``Referer`` asing → 403 (jalur cadangan).
    * keduanya kosong (curl, ``<audio src>``) → diterima; kredensial tetap di
      server, jadi browser tidak bisa dipakai untuk mengirim dari situs lain.
    """
    from functools import wraps

    @wraps(method)
    @csrf_exempt
    def wrapper(request, *args, **kwargs):
        if not _same_origin(request):
            return JsonResponse(
                {"ok": False, "error": "Permintaan ditolak: origin tidak cocok."},
                status=403,
            )
        return method(request, *args, **kwargs)

    return wrapper


# Jenis dokumen di UI (Bahasa Indonesia) → format file + template backend.
# Backend menerima tiga format native: docx, pptx, xlsx (lihat
# app/services/document_generator.py — DOC_TYPES). Excel dipakai untuk
# "Tabel/Sheet" sesuai FR-01 (Word, PowerPoint, dan Excel).
DOC_TYPES: dict[str, dict[str, str]] = {
    "Laporan akademik": {"type": "docx", "template": "report"},
    "Makalah": {"type": "docx", "template": "report"},
    "Proposal penelitian": {"type": "docx", "template": "proposal"},
    "Presentasi": {"type": "pptx", "template": "presentation"},
    "Ringkasan materi": {"type": "docx", "template": "blank"},
    "Tabel data": {"type": "xlsx", "template": "blank"},
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


def _filename_from_disposition(disposition: str | None, fallback: str) -> str:
    """Ambil nama file dari header ``Content-Disposition`` backend.

    Backend FastAPI (Starlette) mengirim ``filename="nama.pdf"`` untuk nama
    ASCII dan ``filename*=utf-8''nama.pdf`` untuk nama beraksara. Dua-duanya
    harus ditangani, kalau tidak nama file Indonesia jadi ``_`` semua.
    """
    if not disposition:
        return _decode_filename(fallback)

    # Varian RFC 5987 (nama beraksara) lebih didahulukan karena nilainya
    # sudah ter-percent-encode.
    match = _SAFE_DOWNLOAD_NAME.search(disposition)
    if not match:
        return _decode_filename(fallback)

    raw = match.group(1).strip()
    if "filename*=utf-8''" in disposition.lower():
        raw = unquote(raw)
    return _decode_filename(raw)


def _range_headers(request) -> dict:
    """Header ``Range`` dari browser, diteruskan ke backend.

    Dipakai untuk berkas yang dilayani backend lewat ``FileResponse``:
    FastAPI lebih dulu menjawab ``206 Partial Content`` kalau header ini
    diteruskan.
    """
    header = request.META.get("HTTP_RANGE", "").strip()
    return {"Range": header} if header else {}


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
        # Dokumen yang diedit per blok punya file lebih baru dari model
        # JSON-nya. Tanpa diteruskan, backend merender `content` lama dan
        # pratinjau tidak pernah menunjukkan hasil edit.
        "preferFile": bool(data.get("preferFile")),
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
        file = backend_api.download(
            f"/documents/{document_id}/export", params={"format": fmt}
        )
    except ApiError as exc:
        logger.warning("unduh dokumen gagal: %s", exc)
        return _error(exc)

    # Ambil nama file dari Content-Disposition backend supaya hasil unduhan
    # memakai judul dokumen, bukan id.
    filename = f"dokumen.{fmt}"
    if file.disposition:
        match = _SAFE_DOWNLOAD_NAME.search(file.disposition)
        if match:
            filename = _decode_filename(match.group(1).strip())

    response = FileResponse(
        iter([file.content]),
        content_type=file.content_type or DOCX_MEDIA,
        filename=filename,
        as_attachment=True,
    )
    # FileResponse hanya menulis Content-Disposition kalau isinya file-like
    # (punya .read()); di sini isinya iterator byte, jadi header diset manual.
    response["Content-Disposition"] = content_disposition_header(True, filename)
    return response


# ---------------------------------------------------------------------------
# PANEL EDITING BLOK
#
# Blok dokumen di-back-end memakai bahasa operasi yang sama dengan agent:
# ``{"op": "replaceText", "docxIndex": 3, "text": "..."}``. Panel dan agent
# bicara bahasa yang sama, jadi perbaikan di salah satunya berlaku di yang
# lain.
# ---------------------------------------------------------------------------

#: Jumlah operasi per permintaan. Panel mengirim satu operasi per interaksi
#: (edit satu blok, hapus satu blok), jadi batas ini longgar — tapi tetap ada,
#: supaya satu request tidak bisa membanjiri engine.
MAX_BLOCK_OPERATIONS = 50


@require_http_methods(["GET", "PATCH", "POST"])
@same_origin_json
def document_blocks(request, document_id: str):
    """Daftar blok dokumen (GET) atau edit blok (PATCH/POST).

    Tiap blok membawa ``docxIndex``: anchor-nya di dalam ``word/document.xml``.
    Anchor itulah yang dipakai setiap edit berikutnya.
    """
    if request.method == "GET":
        return _list_blocks(document_id)
    return _update_blocks(request, document_id)


def _list_blocks(document_id: str) -> JsonResponse:
    """Blok-blok dokumen, untuk panel "Struktur Dokumen"."""
    try:
        payload = backend_api.request("GET", f"/documents/{document_id}/blocks")
    except ApiError as exc:
        logger.warning("ambil blok dokumen gagal: %s", exc)
        return _error(exc)

    return JsonResponse({"ok": True, **payload})


def _update_blocks(request, document_id: str) -> JsonResponse:
    """Terapkan edit blok — penyimpanan byte-preserving.

    Blok yang tidak disentuh tetap memakai byte aslinya, jadi layout dokumen
    selamat dari edit. Balasan berisi blok-blok terbaru plus ``log``: apa
    yang benar-benar terjadi, termasuk penolakan (blok terproteksi, anchor
    yang tidak ada).
    """
    data = _json_body(request)
    operations = data.get("operations")
    if not isinstance(operations, list) or not operations:
        return JsonResponse(
            {"ok": False, "error": "Tidak ada operasi yang dikirim."}, status=400
        )
    if len(operations) > MAX_BLOCK_OPERATIONS:
        return JsonResponse(
            {
                "ok": False,
                "error": f"Maksimal {MAX_BLOCK_OPERATIONS} operasi sekaligus.",
            },
            status=400,
        )

    try:
        payload = backend_api.request(
            "PATCH",
            f"/documents/{document_id}/blocks",
            json={"operations": operations},
            timeout=backend_api.TIMEOUT_GENERATE,
        )
    except ApiError as exc:
        logger.warning("edit blok dokumen gagal: %s", exc)
        return _error(exc)

    return JsonResponse({"ok": True, **payload})


@require_POST
@same_origin_json
def document_agent(request, document_id: str):
    """Jalankan agen dokumen dengan instruksi bahasa alami.

    "Tambah bagian metodologi" → agen membaca dokumen, memanggil tool yang
    dibutuhkannya, dan edit-nya diterapkan lewat patch-save yang sama dengan
    panel. Run yang gagal tidak mengubah dokumen.
    """
    data = _json_body(request)
    instruction = (data.get("instruction") or "").strip()
    if not instruction:
        return JsonResponse(
            {"ok": False, "error": "Instruksi untuk agen wajib diisi."}, status=400
        )

    try:
        payload = backend_api.request(
            "POST",
            f"/documents/{document_id}/agent",
            json={"instruction": instruction},
            # Agennya adalah loop LLM — bisa banyak putaran, jadi timeoutnya
            # sama dengan generate, bukan default 30 detik.
            timeout=backend_api.TIMEOUT_GENERATE,
        )
    except ApiError as exc:
        logger.warning("agen dokumen gagal: %s", exc)
        return _error(exc)

    return JsonResponse({"ok": True, **payload})
