"""Endpoint JSON untuk gap yang belum sempat diekspos BFF — jembatan ke
backend FastAPI (student-assistant).

Alur:

    browser ──GET   /api/lecturer/reports/<id>/──▶ Django ──▶ FastAPI GET   /lecturer/reports/<id>
    browser ──GET   /api/rag/chat/sessions/──────▶ Django ──▶ FastAPI GET   /rag/chat/sessions
    browser ──POST  /api/rag/chat/sessions/──────▶ Django ──▶ FastAPI POST  /rag/chat/sessions
    browser ──GET   /api/rag/chat/<id>/──────────▶ Django ──▶ FastAPI GET   /rag/chat/<id>
    browser ──POST  /api/rag/chat/<id>/message/──▶ Django ──▶ FastAPI POST  /rag/chat/<id>/message
    browser ──DELETE /api/rag/chat/<id>/delete/──▶ Django ──▶ FastAPI DELETE /rag/chat/<id>

Kenapa file ini terpisah:

* **Detail laporan mingguan** (``GET /lecturer/reports/{id}``) ada di backend
  tapi tidak pernah dipakai. Tanpa itu, UI hanya bisa menampilkan isi
  ``content`` yang sudah ikut di daftar laporan — tidak bisa mengambil
  ``summary_data`` terbaru satu laporan tertentu.
* **Sesi chat RAG** (``/rag/chat/*``) adalah endpoint berurutan: buat sesi →
  kirim pesan → baca riwayat. Endpoint ``/rag/query/`` yang sudah ada
  menjawab satu pertanyaan tanpa menyimpan, jadi riwayat percakapan tidak
  bisa dibangun. Frontend React (``frontend/src/services/api.ts``) memakai
  endpoint yang sama, jadi kontrak BFF di sini perlu sama supaya kedua
  frontend berbagi format data.

Profil akun (``GET``/``PATCH /api/profile/``) ditangani
``views_api_profile.py`` — jangan duplikasi di sini, supaya tiap endpoint
punya satu sumber kebenaran.
"""
from __future__ import annotations

import logging

from django.http import JsonResponse
from django.views.decorators.http import require_GET, require_http_methods, require_POST

from . import backend_api
from .backend_api import ApiError
from .views_api import _error, _json_body, same_origin_json

logger = logging.getLogger(__name__)


def _id_ok(value: str) -> bool:
    """Id aman untuk disisipkan ke path backend.

    Id dibuat backend sebagai UUID string. Menolak karakter lain mencegah
    path traversal (``/rag/chat/../../..``).
    """
    cleaned = (value or "").strip()
    if not cleaned or len(cleaned) > 64:
        return False
    return all(ch.isalnum() or ch in "-_" for ch in cleaned)


# --------------------------------------------------------- detail laporan


@require_GET
@same_origin_json
def lecturer_report_detail(request, report_id: str):
    """Detail satu laporan mingguan.

    Backend mengembalikan objek ``WeeklyReport`` apa adanya. Field yang
    dipakai UI: ``id``, ``title``, ``period_start``, ``period_end``,
    ``content`` (JSON string), ``summary_data`` (dict), ``generated_at``.
    """
    if not _id_ok(report_id):
        return JsonResponse({"ok": False, "error": "Id laporan tidak valid."}, status=400)

    try:
        report = backend_api.request("GET", f"/lecturer/reports/{report_id}")
    except ApiError as exc:
        logger.warning("ambil laporan %s gagal: %s", report_id, exc)
        return _error(exc)

    return JsonResponse({"ok": True, "report": report if isinstance(report, dict) else {}})


# ----------------------------------------------------------- sesi chat RAG


@require_GET
@same_origin_json
def rag_chat_sessions(request):
    """Daftar sesi percakapan RAG milik pengguna."""
    try:
        result = backend_api.request("GET", "/rag/chat/sessions")
    except ApiError as exc:
        logger.warning("daftar sesi chat RAG gagal: %s", exc)
        return _error(exc)

    result = result if isinstance(result, dict) else {}

    return JsonResponse({"ok": True, "sessions": result.get("sessions") or []})


@require_POST
@same_origin_json
def rag_chat_session_create(request):
    """Buat sesi percakapan RAG baru.

    Backend membaca ``rag_document_id`` dan ``title`` sebagai field form
    (multipart/form-urlencoded), jadi request dikirim sebagai form — bukan
    JSON.
    """
    data = _json_body(request)

    title = str(data.get("title") or "").strip()[:500] or "Percakapan baru"
    document_id = str(data.get("rag_document_id") or "").strip()

    if document_id and not _id_ok(document_id):
        return JsonResponse(
            {"ok": False, "error": "Id dokumen tidak valid."}, status=400
        )

    form = {"title": title}
    if document_id:
        form["rag_document_id"] = document_id

    try:
        session = backend_api.request(
            "POST", "/rag/chat/sessions", data=form, timeout=backend_api.TIMEOUT_DEFAULT
        )
    except ApiError as exc:
        logger.warning("buat sesi chat RAG gagal: %s", exc)
        return _error(exc)

    return JsonResponse(
        {"ok": True, "session": session if isinstance(session, dict) else {}},
        status=201,
    )


@require_GET
@same_origin_json
def rag_chat_history(request, session_id: str):
    """Riwayat pesan satu sesi percakapan RAG.

    Setiap pesan membawa ``kind`` ("document" / "task") — UI memakainya
    untuk melabeli sumber jawaban ("Sumber" vs "Tugas terkait").
    """
    if not _id_ok(session_id):
        return JsonResponse({"ok": False, "error": "Id sesi tidak valid."}, status=400)

    try:
        result = backend_api.request("GET", f"/rag/chat/{session_id}")
    except ApiError as exc:
        logger.warning("ambil riwayat chat RAG gagal: %s", exc)
        return _error(exc)

    result = result if isinstance(result, dict) else {}

    messages = []
    for message in result.get("messages") or []:
        if not isinstance(message, dict):
            continue
        # Pesan lama (sebelum backend menyimpan ``kind``) dianggap
        # jawaban dokumen — sama seperti perilaku default backend.
        message.setdefault("kind", "document")
        messages.append(message)

    return JsonResponse({"ok": True, "messages": messages})


@require_http_methods(["DELETE", "POST"])
@same_origin_json
def rag_chat_session_delete(request, session_id: str):
    """Hapus satu sesi percakapan RAG beserta pesannya.

    Backend ``DELETE /rag/chat/{id}`` milik sesi yang sedang dipakai saja
    (backend memeriksa ``user_id``). Sesi milik akun lain → 404, jadi
    endpoint ini tidak bisa dipakai untuk menebak-nebak id milik orang.

    Kenapa perlu ada di BFF: tanpa ini, satu-sesi chat yang salah tidak
    bisa dibuang dari UI. Sesi itu tetap menumpuk di server, dan setiap
    kali halaman di-refresh, ``sessionStorage`` memuat ulang id yang sama —
    jadi user tidak pernah bisa lepas dari riwayat yang salah.
    """
    if not _id_ok(session_id):
        return JsonResponse({"ok": False, "error": "Id sesi tidak valid."}, status=400)

    try:
        backend_api.request("DELETE", f"/rag/chat/{session_id}")
    except ApiError as exc:
        # 404 = sesi sudah tidak ada (mis. dihapus dari tab lain, atau
        # sudah dibersihkan sebelumnya). Estado akhir yang diinginkan sudah
        # tercapai, jadi ini **bukan** kegagalan — hasilnya idempoten.
        # Kalau 404 diteruskan apa adanya, user menekan "hapus" lagi
        # akan selalu melihat error padahal tidak ada yang perlu dihapus.
        if exc.status == 404:
            return JsonResponse(
                {"ok": True, "message": "Riwayat percakapan sudah tidak ada."}
            )
        logger.warning("hapus sesi chat RAG %s gagal: %s", session_id, exc)
        return _error(exc)

    return JsonResponse({"ok": True, "message": "Riwayat percakapan dihapus."})


@require_POST
@same_origin_json
def rag_chat_message(request, session_id: str):
    """Kirim pertanyaan ke dalam sesi percakapan RAG.

    Backend ``POST /rag/chat/{id}/message`` menerima body yang sama dengan
    ``/rag/query`` (``question``, ``courseId``, ``nResults``) dan mengembalikan
    ``{answer, sources, confidence}``. Berbeda dengan ``/rag/query/``, pesan ini
    DISIMPAN di riwayat sesi.
    """
    if not _id_ok(session_id):
        return JsonResponse({"ok": False, "error": "Id sesi tidak valid."}, status=400)

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

    # ``documentId`` membatasi retrieval ke satu dokumen. Sesi yang dibuat
    # dengan ``rag_document_id`` sudah punya scope-nya sendiri di backend,
    # tapi peramban juga boleh mengirim ini secara eksplisit supaya
    # jawabannya dijaga tetap dari satu dokumen saja.
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
            "POST",
            f"/rag/chat/{session_id}/message",
            json=payload,
            timeout=backend_api.TIMEOUT_LLM,
        )
    except ApiError as exc:
        logger.warning("kirim pesan chat RAG gagal: %s", exc)
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
