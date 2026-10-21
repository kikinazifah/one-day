"""Endpoint JSON untuk RAG Assistant dan Notifikasi — jembatan ke backend FastAPI.

Alur:

    RAG         GET/POST /api/rag/documents/ , /api/rag/upload/ , /api/rag/query/
                GET /api/rag/documents/<id>/file/ → berkas sumber (bukan JSON)
    Notifikasi GET  /api/notifications/ , POST /api/notifications/<id>/read/

Pola sama seperti ``dashboard/views_api.py``: token service dipegang Django,
browser tidak pernah melihat JWT. Helper (``same_origin_json``, ``_json_body``,
``_error``) dipakai ulang supaya aturan proteksi seragam di semua halaman.

Catatan: tugas dan mata kuliah ditangani ``views_api_tasks.py`` — jangan
duplikasi di sini, supaya tiap endpoint punya satu sumber kebenaran.
"""
from __future__ import annotations

import logging

from django.http import (
    HttpResponse,
    HttpResponseBadRequest,
    HttpResponseForbidden,
    HttpResponseNotFound,
    JsonResponse,
)
from django.utils.http import content_disposition_header
from django.views.decorators.http import require_GET, require_POST, require_http_methods

from . import backend_api
from .backend_api import ApiError
from .views_api import (
    _error,
    _filename_from_disposition,
    _json_body,
    _range_headers,
    _same_origin,
    same_origin_json,
)

logger = logging.getLogger(__name__)

# Format berkas yang boleh diunggah, diambil dari backend (GET /rag/formats).
# Dicache supaya setiap unggahan tidak memanggil backend sekali lagi.
#
# Kenapa tidak ditulis di sini: kalau daftarnya ada di dua tempat, keduanya
# pasti akan berbeda. Backend menerima 22 format; salinan lokal pernah
# tertinggal di 9 — hasilnya berkas ".tsv" yang sebenarnya bisa diindeks
# ditolak dengan pesan "format tidak didukung".
#
# Kalau backend tidak bisa dihubungi, ``None`` berarti "tidak diketahui" —
# berkas diteruskan dan backend yang menilai. Menolak semua berkas saat
# backend mati akan menjauhkan pengguna dari fitur.
_RAG_FORMATS: tuple[str, ...] | None = None
_RAG_ACCEPT: str | None = None
_RAG_MAX_BYTES: int | None = None

# Batas ukuran unggahan RAG — dipakai kalau backend tidak bisa dihubungi.
# Cadangan: backend mengizinkan 20 MB. Nilai ini hanya berlaku saat daemon.
MAX_RAG_UPLOAD_BYTES = 20 * 1024 * 1024

# Panjang maksimum nama tampilan dokumen — sama dengan lebar kolom
# ``rag_documents.display_name`` di backend. Menolaknya di sini memberi
# pesan yang jelas, daripada 422 dari backend yang tidak banyak dibaca.
MAX_RAG_NAME_LENGTH = 500

# Panjang maksimum kata kunci pencarian. Backend menerima 200; batas yang
# sama dipakai supaya perilakunya konsisten dari sisi peramban.
MAX_RAG_SEARCH_LENGTH = 200


def _id_ok(value: str) -> bool:
    """Id yang aman untuk disisipkan ke path backend.

    Id dibuat backend sebagai UUID string. Menolak karakter lain mencegah
    path traversal (``/rag/documents/../../..``).
    """
    cleaned = (value or "").strip()
    if not cleaned or len(cleaned) > 64:
        return False
    return all(ch.isalnum() or ch in "-_" for ch in cleaned)


# --------------------------------------------------------------------- RAG


def _rewrite_file_url(document: dict) -> dict:
    """Arahkan ``fileUrl`` ke route BFF, bukan URL backend mentah.

    Backend mengirim ``fileUrl`` seperti ``/api/v1/rag/documents/<id>/file``
    — path menuju origin FastAPI. Kalau browser memakainya langsung, request
    tidak punya token service dan akan ditolak 401. Jadi URL-nya diganti ke
    route Django yang menarik berkasnya dari backend.
    """
    doc_id = str(document.get("id") or "").strip()
    if doc_id:
        document["fileUrl"] = f"/api/rag/documents/{doc_id}/file/"
    return document


def _rag_format_cache() -> tuple[tuple[str, ...] | None, str | None, int | None]:
    """Ambil (dan cache) daftar format + batas ukuran dari backend.

    Nilainya disimpan di modul supaya setiap unggahan tidak memanggil
    backend sekali lagi. Cache tidak punya kedaluwarsa: daftar format
    berubah sangat jarang, dan proses Django yang perlu restart memang
    wajar kalau backend-nya berubah.

    Mengembalikan ``(formats, accept, max_bytes)``:

    * ``formats`` — ekstensi yang didukung (``""`` berarti berkas tanpa
      ekstensi, yang sah di backend);
    * ``accept`` — string siap pakai untuk atribut ``accept`` di HTML,
      diteruskan apa adanya dari backend;
    * ``max_bytes`` — batas ukuran unggahan.

    Kalau backend tidak bisa dihubungi, ``(None, None, None)`` —
    pemanggil memperlakukan itu sebagai "tidak diketahui", bukan "tidak
    didukung".
    """
    global _RAG_FORMATS, _RAG_ACCEPT, _RAG_MAX_BYTES

    if _RAG_FORMATS is not None:
        return _RAG_FORMATS, _RAG_ACCEPT, _RAG_MAX_BYTES

    try:
        result = backend_api.request("GET", "/rag/formats")
    except ApiError as exc:
        logger.warning("daftar format RAG gagal: %s", exc)
        return None, None, None

    result = result if isinstance(result, dict) else {}
    formats = tuple(
        f for f in (result.get("formats") or []) if isinstance(f, str)
    )
    if not formats:
        return None, None, None

    accept = result.get("accept")
    if not isinstance(accept, str) or not accept.strip():
        accept = None

    max_bytes = result.get("max_file_bytes")
    if not isinstance(max_bytes, int) or max_bytes <= 0:
        max_bytes = MAX_RAG_UPLOAD_BYTES

    _RAG_FORMATS = formats
    _RAG_ACCEPT = accept
    _RAG_MAX_BYTES = max_bytes
    return formats, accept, max_bytes


@require_GET
@same_origin_json
def rag_formats(request):
    """Daftar format berkas yang bisa diindeks.

    Dilayani dari backend, bukan disalin di sini. Kalau daftar format
    ditulis di dua tempat, keduanya pasti akan berbeda — dan antarmuka
    menolak berkas yang sebenarnya bisa diproses.
    """
    formats, accept, max_bytes = _rag_format_cache()
    if not formats:
        # Backend tidak bisa dihubungi — lebih baik laporkan ke pengguna
        # daripada diam-diam, tapi berkas tetap boleh dicoba diunggah.
        return JsonResponse(
            {
                "ok": False,
                "error": "Daftar format tidak bisa dimuat dari backend.",
                "formats": [],
            },
            status=503,
        )
    payload = {
        "ok": True,
        "formats": list(formats),
        "maxFileBytes": max_bytes,
    }
    if accept:
        payload["accept"] = accept
    return JsonResponse(payload)


@require_GET
@same_origin_json
def rag_documents(request):
    """Daftar dokumen terindeks milik pengguna."""
    params: dict = {}
    course_id = request.GET.get("course_id")
    if course_id:
        params["course_id"] = course_id

    try:
        result = backend_api.request("GET", "/rag/documents", params=params or None)
    except ApiError as exc:
        logger.warning("daftar dokumen RAG gagal: %s", exc)
        return _error(exc)

    result = result if isinstance(result, dict) else {}

    documents = [
        _rewrite_file_url(doc) for doc in (result.get("documents") or [])
        if isinstance(doc, dict)
    ]

    return JsonResponse({"ok": True, "documents": documents})


@require_POST
@same_origin_json
def rag_upload(request):
    """Unggah berkas → backend mengekstrak, memotong, dan mengindeksnya.

    Indexing berjalan di background, jadi respons balik hanya memberi tahu
    status ``uploaded``. Browser lalu polling status dokumen sampai ``indexed``
    (atau ``failed``).
    """
    upload = request.FILES.get("file")
    if upload is None:
        return JsonResponse(
            {"ok": False, "error": "Berkas tidak ditemukan (field 'file')."}, status=400
        )

    name = upload.name or "dokumen"
    extension = "." + name.rsplit(".", 1)[-1].lower() if "." in name else ""

    formats, _accept, max_bytes = _rag_format_cache()
    limit_bytes = max_bytes or MAX_RAG_UPLOAD_BYTES

    # Kalau daftar format tidak diketahui (backend sedang mati), berkas
    # diteruskan dan backend yang menilai. Menolak semuanya di sini akan
    # membuat fitur mati total saat backend restart.
    if formats is not None and extension not in formats:
        return JsonResponse(
            {
                "ok": False,
                "error": (
                    f"Format berkas tidak didukung: {extension or 'tanpa ekstensi'}. "
                    "Yang bisa diindeks: " + ", ".join(formats) + "."
                ),
            },
            status=400,
        )

    if upload.size <= 0:
        return JsonResponse({"ok": False, "error": "Berkas kosong."}, status=400)

    if upload.size > limit_bytes:
        return JsonResponse(
            {
                "ok": False,
                "error": f"Berkas terlalu besar (maksimum {limit_bytes // (1024 * 1024)} MB).",
            },
            status=413,
        )

    data: dict = {}
    course_id = str(request.POST.get("course_id") or "").strip()
    if course_id:
        data["course_id"] = course_id

    try:
        result = backend_api.request(
            "POST",
            "/rag/upload",
            files={"file": (name, upload, upload.content_type or "application/octet-stream")},
            data=data or None,
            timeout=backend_api.TIMEOUT_UPLOAD_AUDIO,
        )
    except ApiError as exc:
        logger.warning("unggah dokumen RAG gagal: %s", exc)
        return _error(exc)

    result = result if isinstance(result, dict) else {}

    return JsonResponse(
        {
            "ok": True,
            "message": result.get("message", "Dokumen diunggah, sedang diindeks."),
            "document": result.get("document") or {},
        },
        status=201,
    )


@require_GET
@same_origin_json
def rag_document_detail(request, document_id: str):
    """Status satu dokumen — dipakai polling saat indexing berjalan."""
    if not _id_ok(document_id):
        return JsonResponse({"ok": False, "error": "Id dokumen tidak valid."}, status=400)

    try:
        document = backend_api.request("GET", f"/rag/documents/{document_id}")
    except ApiError as exc:
        logger.warning("ambil dokumen %s gagal: %s", document_id, exc)
        return _error(exc)

    if isinstance(document, dict):
        document = _rewrite_file_url(document)

    return JsonResponse({"ok": True, "document": document})


@require_GET
@same_origin_json
def rag_document_search(request):
    """Cari dokumen: nama berkas ATAU isi dokumen (FR-07 full-text search).

    Dua lapis pencarian terjadi di backend; BFF hanya meneruskan kata kunci
    dan merapikan bentuk responsnya. Bentuk responsnya tidak sama dengan
    ``rag_documents`` — di sini ada ``query`` dan ``total``, dan tiap
    dokumen membawa ``matchType`` ("name", "content", atau "both") supaya
    UI bisa menjelaskan **kenapa** dokumen itu muncul.
    """
    query = (request.GET.get("q") or "").strip()
    if not query:
        return JsonResponse(
            {"ok": False, "error": "Kata kunci pencarian wajib diisi."}, status=400
        )
    if len(query) > MAX_RAG_SEARCH_LENGTH:
        return JsonResponse(
            {
                "ok": False,
                "error": (
                    f"Kata kunci pencarian maksimal {MAX_RAG_SEARCH_LENGTH} karakter."
                ),
            },
            status=400,
        )

    params: dict = {"q": query}
    course_id = (request.GET.get("course_id") or "").strip()
    if course_id:
        params["course_id"] = course_id

    try:
        result = backend_api.request("GET", "/rag/documents/search", params=params)
    except ApiError as exc:
        logger.warning("pencarian dokumen RAG gagal: %s", exc)
        return _error(exc)

    result = result if isinstance(result, dict) else {}
    documents = [
        _rewrite_file_url(doc)
        for doc in (result.get("documents") or [])
        if isinstance(doc, dict)
    ]

    return JsonResponse(
        {
            "ok": True,
            "query": result.get("query") or query,
            "total": result.get("total") or len(documents),
            "documents": documents,
        }
    )


@require_http_methods(["PATCH", "POST"])
@same_origin_json
def rag_document_rename(request, document_id: str):
    """Ganti nama tampilan dokumen (FR-07 "rename") dan/atau koreksi tag
    mata kuliah (FR-21 "pengguna dapat mengoreksi tag").

    Backend ``PATCH /rag/documents/{id}`` menerima ``displayName`` dan
    ``courseId``. Yang **tidak** diteruskan ke sana: id dokumen. Id itu
    kunci chunk di vector store dan kunci asing dari sesi chat — mengubah
    id akan melukai dua hal sekaligus, dan backend memang tidak
    mengizinkan.
    """
    if not _id_ok(document_id):
        return JsonResponse({"ok": False, "error": "Id dokumen tidak valid."}, status=400)

    data = _json_body(request)

    payload: dict = {}

    # Allow-list: hanya dua field yang boleh diubah. Field lain di body
    # diabaikan diam-diam, bukan diteruskan.
    if "display_name" in data or "displayName" in data:
        name = str(data.get("display_name") or data.get("displayName") or "").strip()
        if not name:
            return JsonResponse(
                {"ok": False, "error": "Nama dokumen tidak boleh kosong."}, status=400
            )
        if len(name) > MAX_RAG_NAME_LENGTH:
            return JsonResponse(
                {
                    "ok": False,
                    "error": f"Nama maksimal {MAX_RAG_NAME_LENGTH} karakter.",
                },
                status=400,
            )
        payload["displayName"] = name

    if "course_id" in data or "courseId" in data:
        course_id = str(data.get("course_id") or data.get("courseId") or "").strip()
        # String kosong berarti "lepaskan tag" — backend menerima itu dan
        # menyetel ``course_id`` menjadi NULL. Menolaknya di sini membuat
        # pengguna tidak bisa membetulkan tag yang keliru (FR-21).
        if course_id and not _id_ok(course_id):
            return JsonResponse(
                {"ok": False, "error": "Id mata kuliah tidak valid."}, status=400
            )
        payload["courseId"] = course_id

    if not payload:
        return JsonResponse(
            {"ok": False, "error": "Tidak ada field yang diubah."}, status=400
        )

    try:
        document = backend_api.request(
            "PATCH", f"/rag/documents/{document_id}", json=payload
        )
    except ApiError as exc:
        logger.warning("ubah dokumen %s gagal: %s", document_id, exc)
        return _error(exc)

    if isinstance(document, dict):
        document = _rewrite_file_url(document)

    return JsonResponse({"ok": True, "document": document})


@require_POST
@same_origin_json
def rag_query(request):
    """Tanya-jawab berbasis dokumen → jawaban + sumber."""
    data = _json_body(request)

    question = str(data.get("question") or "").strip()
    if not question:
        return JsonResponse(
            {"ok": False, "error": "Pertanyaan tidak boleh kosong."}, status=400
        )

    payload: dict = {"question": question[:2000]}

    course_id = str(data.get("course_id") or "").strip()
    if course_id:
        payload["courseId"] = course_id

    # ``documentId`` membatasi retrieval ke satu dokumen (sesi chat yang
    # terikat dokumen). Divalidasi dulu supaya tidak ada string bebas
    # yang ikut diteruskan ke backend.
    document_id = str(data.get("document_id") or data.get("documentId") or "").strip()
    if document_id:
        if not _id_ok(document_id):
            return JsonResponse(
                {"ok": False, "error": "Id dokumen tidak valid."}, status=400
            )
        payload["documentId"] = document_id

    try:
        n_results = int(data.get("n_results") or 5)
    except (TypeError, ValueError):
        n_results = 5
    payload["nResults"] = max(1, min(20, n_results))

    try:
        result = backend_api.request(
            "POST", "/rag/query", json=payload, timeout=backend_api.TIMEOUT_LLM
        )
    except ApiError as exc:
        logger.warning("tanya RAG gagal: %s", exc)
        return _error(exc)

    result = result if isinstance(result, dict) else {}

    return JsonResponse(
        {
            "ok": True,
            "answer": result.get("answer") or "",
            "sources": result.get("sources") or [],
            "confidence": result.get("confidence") or 0.0,
            # "document" atau "task" — UI melabeli sumber sesuai jenisnya.
            "kind": result.get("kind") or "document",
        }
    )


@require_http_methods(["DELETE", "POST"])
@same_origin_json
def rag_document_delete(request, document_id: str):
    """Hapus dokumen dari indeks."""
    if not _id_ok(document_id):
        return JsonResponse({"ok": False, "error": "Id dokumen tidak valid."}, status=400)

    try:
        backend_api.request("DELETE", f"/rag/documents/{document_id}")
    except ApiError as exc:
        logger.warning("hapus dokumen %s gagal: %s", document_id, exc)
        return _error(exc)

    return JsonResponse({"ok": True, "message": "Dokumen dihapus dari indeks."})


@require_GET
def rag_document_file(request, document_id: str):
    """Unduh berkas sumber dari dokumen yang terindeks.

    Backend menyimpan berkas asli di ``uploads/rag/`` dan menyediakannya
    lewat ``GET /rag/documents/<id>/file`` (lihat ``app/api/routes/rag.py``).
    Endpoint ini menutup jalur itu: Django menarik berkas dari backend
    memakai token service, lalu melayanannya ke browser sebagai respons
    biner — browser tidak pernah melihat URL backend mentah.

    Sengaja TIDAK memakai ``same_origin_json`` karena responsnya bukan
    JSON. Yang melindungi endpoint ini: ``Vary: Origin`` + pemeriksaan
    Origin di bawah.

    Header ``Range`` diteruskan supaya unduhan sebagian (mis. viewer PDF)
    tetap bisa jalan.
    """
    if not _id_ok(document_id):
        return HttpResponseBadRequest("Id dokumen tidak valid.")

    if not _same_origin(request):
        return HttpResponseForbidden("Permintaan dari origin lain ditolak.")

    try:
        file = backend_api.download(
            f"/rag/documents/{document_id}/file",
            headers=_range_headers(request),
        )
    except ApiError as exc:
        logger.warning("unduh berkas dokumen %s gagal: %s", document_id, exc)
        if exc.status == 404:
            return HttpResponseNotFound("Berkas dokumen tidak tersedia.")
        return HttpResponse(
            f"Berkas tidak bisa diambil ({exc.detail}).",
            status=502,
            content_type="text/plain; charset=utf-8",
        )

    # Nama asli dikembalikan backend lewat Content-Disposition; pakai itu
    # supaya unduhan bernama "modul-1.pdf", bukan id dokumen.
    filename = _filename_from_disposition(file.disposition, f"{document_id}.bin")

    response = HttpResponse(
        file.content,
        content_type=file.content_type or "application/octet-stream",
        status=file.status,
    )
    response["Content-Disposition"] = content_disposition_header(True, filename)

    # Teruskan header range apa adanya supaya respons 206 tetap konsisten
    # dengan isinya.
    for key, value in file.headers.items():
        if key.lower() == "content-length":
            continue
        response[key] = value

    response["Cache-Control"] = "private, max-age=3600"
    response["Accept-Ranges"] = "bytes"
    # Respons berbeda tergantung Origin (403 untuk origin lain), jadi cache
    # tidak boleh memakai satu jawaban untuk semua pemanggil.
    response["Vary"] = "Origin"

    return response


# -------------------------------------------------------------- notifikasi


@require_GET
@same_origin_json
def notification_list(request):
    """Daftar notifikasi — terbaru lebih dulu."""
    params: dict = {}
    if request.GET.get("unread_only") in ("1", "true", "yes"):
        params["unread_only"] = "true"

    try:
        notifications = backend_api.request(
            "GET", "/notifications/", params=params or None
        )
    except ApiError as exc:
        logger.warning("daftar notifikasi gagal: %s", exc)
        return _error(exc)

    return JsonResponse(
        {"ok": True, "notifications": notifications if isinstance(notifications, list) else []}
    )


@require_GET
@same_origin_json
def notification_pending(request):
    """Notifikasi yang belum sempat ditampilkan ke peramban.

    Ujung dari kanal "polling + Service Worker": peramban meng polled
    endpoint ini, lalu meneruskan hasilnya ke Service Worker yang
    memunculkan notifikasi sistem.

    Parameter ``since`` diisi peramban dengan cap waktu notifikasi
    terakhir yang sudah dilihatnya. Karena begitu, "sudah ditampilkan"
    dilacak di sisi peramban — tidak perlu kolom baru di database, dan
    panel web serta peramban membaca baris yang **sama**.
    """
    params: dict = {}
    since = (request.GET.get("since") or "").strip()
    if since:
        params["since"] = since

    try:
        notifications = backend_api.request(
            "GET", "/notifications/pending", params=params or None
        )
    except ApiError as exc:
        logger.warning("notifikasi tertunda gagal: %s", exc)
        return _error(exc)

    return JsonResponse(
        {"ok": True, "notifications": notifications if isinstance(notifications, list) else []}
    )


@require_POST
@same_origin_json
def notification_read(request, notification_id: str):
    """Tandai satu notifikasi sudah dibaca."""
    if not _id_ok(notification_id):
        return JsonResponse(
            {"ok": False, "error": "Id notifikasi tidak valid."}, status=400
        )

    try:
        result = backend_api.request("POST", f"/notifications/{notification_id}/read")
    except ApiError as exc:
        logger.warning("tandai notifikasi %s dibaca gagal: %s", notification_id, exc)
        return _error(exc)

    result = result if isinstance(result, dict) else {}

    return JsonResponse(
        {"ok": True, "message": result.get("message", "Notifikasi ditandai dibaca.")}
    )


@require_POST
@same_origin_json
def notification_read_all(request):
    """Tandai semua notifikasi sudah dibaca."""
    try:
        result = backend_api.request("POST", "/notifications/read-all")
    except ApiError as exc:
        logger.warning("tandai semua notifikasi dibaca gagal: %s", exc)
        return _error(exc)

    result = result if isinstance(result, dict) else {}

    return JsonResponse(
        {"ok": True, "message": result.get("message", "Semua notifikasi ditandai dibaca.")}
    )
