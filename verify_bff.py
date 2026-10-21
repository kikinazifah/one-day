"""Verifikasi end-to-end seluruh endpoint BFF dashboard terhadap backend FastAPI.

Script ini menguji lewat Django (port 8010) — jalur yang sama dengan browser —
bukan langsung ke FastAPI. Jadi yang teruji bukan hanya kontrak backend, tapi
 juga: token service, proteksi Origin/CSRF, dan penerusan field.

Jalankan:

    python verify_bff.py
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from http.cookiejar import CookieJar

# Alamat dashboard yang diuji. Bisa ditimpa lewat env var
# ``ACADEMIA_BASE_URL`` supaya verifikasi bisa diarahkan ke instance
# Django lain (mis. saat port 8010 sedang dipakai proses lain).
BASE = os.environ.get("ACADEMIA_BASE_URL", "http://127.0.0.1:8010")

ok = 0
fail = 0
failures: list[str] = []


def _opener() -> urllib.request.OpenerDirector:
    """Opener dengan cookie jar (butuh CSRF token + session)."""
    return urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(CookieJar())
    )


def _csrf_from(opener) -> str:
    """Ambil token CSRF dari cookie jar opener."""
    for handler in getattr(opener, "handlers", []):
        if isinstance(handler, urllib.request.HTTPCookieProcessor):
            for cookie in handler.cookiejar:
                if cookie.name == "csrftoken":
                    return cookie.value
    return ""


def check(name: str, condition: bool, extra: str = "") -> None:
    global ok, fail
    if condition:
        ok += 1
        print(f"  PASS  {name}")
    else:
        fail += 1
        failures.append(f"{name} {extra}".strip())
        print(f"  FAIL  {name} {extra}".rstrip())


def get(path: str, opener=None) -> tuple[int, dict]:
    op = opener or _opener()
    try:
        with op.open(BASE + path, timeout=60) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read() or b"{}")
        except ValueError:
            return exc.code, {}
    except Exception as exc:  # noqa: BLE001
        return 0, {"error": str(exc)}


def post(path: str, body: dict, opener=None) -> tuple[int, dict]:
    op = opener or _opener()
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        BASE + path,
        data=data,
        headers={
            "Content-Type": "application/json",
            "X-CSRFToken": _csrf_from(op),
            "Referer": BASE + path,
            "Origin": BASE,
        },
        method="POST",
    )
    try:
        with op.open(req, timeout=120) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read() or b"{}")
        except ValueError:
            return exc.code, {}
    except Exception as exc:  # noqa: BLE001
        return 0, {"error": str(exc)}


def post_raw(path: str, content: bytes, opener=None) -> tuple[int, dict]:
    """POST body mentah (bukan JSON).

    Dipakai untuk potongan PCM: isinya Int16 mono, bukan teks yang bisa
    di-``json.dumps``. Header Content-Type-nya ``application/octet-stream``
    supaya BFF meneruskan byte apa adanya.
    """
    op = opener or _opener()
    req = urllib.request.Request(
        BASE + path,
        data=content,
        headers={
            "Content-Type": "application/octet-stream",
            "X-CSRFToken": _csrf_from(op),
            "Referer": BASE + path,
            "Origin": BASE,
        },
        method="POST",
    )
    try:
        with op.open(req, timeout=120) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read() or b"{}")
        except ValueError:
            return exc.code, {}
    except Exception as exc:  # noqa: BLE001
        return 0, {"error": str(exc)}


def patch(path: str, body: dict, opener=None) -> tuple[int, dict]:
    """PATCH JSON."""
    op = opener or _opener()
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode(),
        headers={
            "Content-Type": "application/json",
            "X-CSRFToken": _csrf_from(op),
            "Referer": BASE + path,
            "Origin": BASE,
        },
        method="PATCH",
    )
    try:
        with op.open(req, timeout=60) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read() or b"{}")
        except ValueError:
            return exc.code, {}
    except Exception as exc:  # noqa: BLE001
        return 0, {"error": str(exc)}


def delete(path: str, opener=None) -> tuple[int, dict]:
    """DELETE JSON."""
    op = opener or _opener()
    req = urllib.request.Request(
        BASE + path,
        headers={
            "X-CSRFToken": _csrf_from(op),
            "Referer": BASE + path,
            "Origin": BASE,
        },
        method="DELETE",
    )
    try:
        with op.open(req, timeout=60) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read() or b"{}")
        except ValueError:
            return exc.code, {}
    except Exception as exc:  # noqa: BLE001
        return 0, {"error": str(exc)}


def fetch(path: str, opener=None, extra: dict | None = None) -> tuple[int, bytes, dict]:
    """GET biner — mengembalikan (status, body, headers).

    Dipakai untuk berkas rekaman: responsnya audio, bukan JSON, jadi tidak
    bisa di-parse dengan ``get()``.
    """
    op = opener or _opener()
    req = urllib.request.Request(
        BASE + path,
        headers={"Referer": BASE + path, "Origin": BASE, **(extra or {})},
        method="GET",
    )
    try:
        with op.open(req, timeout=120) as resp:
            return resp.status, resp.read(), dict(resp.headers)
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(), dict(exc.headers or {})
    except Exception as exc:  # noqa: BLE001
        return 0, str(exc).encode(), {}


def upload(path: str, filename: str, content: bytes, fields: dict, opener=None):
    """POST multipart."""
    op = opener or _opener()
    boundary = "----bffverify7f3a"
    parts: list[bytes] = []
    for key, value in fields.items():
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{value}\r\n".encode()
        )
    parts.append(
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
        f"filename=\"{filename}\"\r\nContent-Type: text/plain\r\n\r\n".encode()
    )
    parts.append(content)
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    body = b"".join(parts)

    req = urllib.request.Request(
        BASE + path,
        data=body,
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "X-CSRFToken": _csrf_from(op),
            "Referer": BASE + path,
            "Origin": BASE,
        },
        method="POST",
    )
    try:
        with op.open(req, timeout=120) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read() or b"{}")
        except ValueError:
            return exc.code, {}
    except Exception as exc:  # noqa: BLE001
        return 0, {"error": str(exc)}


def poll_task(task_id: str, predicate, opener=None, timeout: float = 15.0):
    """Tunggu sampai field sebuah tugas memenuhi predicate.

    ``reminder_job_id`` ditulis **worker** (Celery), bukan route — lihat
    ``app/tasks/reminders.py``. Jadi respons ``POST /api/tasks/create/``
    belum tentu punya id job: pekerjaan itu masih antrean. Membaca
    nilainya langsung dari respons = race condition, dan check-nya gagal
    secara acak tergantung kecepatan worker.

    Fungsi ini menunggu (poll) sampai predicate terpenuhi, lalu
    mengembalikan dict tugas terakhir. Kalau waktu habis, mengembalikan
    nilai terakhir apa adanya supaya pemanggil bisa melaporkannya.
    """
    op = opener or _opener()
    deadline = time.monotonic() + timeout
    task: dict = {}
    while True:
        status, data = get("/api/tasks/", op)
        if status == 200:
            for item in data.get("tasks") or []:
                if isinstance(item, dict) and item.get("id") == task_id:
                    task = item
                    break
            if predicate(task):
                return task
        if time.monotonic() >= deadline:
            return task
        time.sleep(0.4)


def main() -> int:
    # Satu opener dipakai supaya session + CSRF konsisten.
    op = _opener()
    op.open(BASE + "/", timeout=30).read()  # ambil cookie CSRF

    print("\n=== 1. Endpoint baca (GET) ===")

    status, data = get("/api/tasks/", op)
    check("GET /api/tasks/", status == 200 and data.get("ok") is True, f"-> {status} {data}")
    check("  -> tasks berupa list", isinstance(data.get("tasks"), list), str(type(data.get("tasks"))))

    status, data = get("/api/courses/", op)
    check("GET /api/courses/", status == 200 and data.get("ok") is True, f"-> {status}")
    check("  -> courses berupa list", isinstance(data.get("courses"), list))

    status, data = get("/api/schedule/", op)
    check("GET /api/schedule/", status == 200 and data.get("ok") is True, f"-> {status}")
    check("  -> entries ada", "entries" in data, str(list(data.keys())))
    check("  -> conflicts ada", "conflicts" in data)

    # "Hari ini" ikut diteruskan — dihitung backend dalam zona aplikasi.
    # Tanpa ini, klien harus menghitungnya sendiri dari jam browser,
    # yang salah untuk user yang zona kerjanya berbeda.
    check("  -> today ada", isinstance(data.get("today"), dict),
          str(type(data.get("today"))))

    status, data = get("/api/lecture/", op)
    check("GET /api/lecture/", status == 200 and data.get("ok") is True, f"-> {status}")

    status, data = get("/api/rag/documents/", op)
    check("GET /api/rag/documents/", status == 200 and data.get("ok") is True, f"-> {status}")
    check("  -> documents berupa list", isinstance(data.get("documents"), list))

    status, data = get("/api/notifications/", op)
    check("GET /api/notifications/", status == 200 and data.get("ok") is True, f"-> {status}")
    check("  -> notifications berupa list", isinstance(data.get("notifications"), list))

    status, data = get("/api/lecturer/personas/", op)
    check("GET /api/lecturer/personas/", status == 200 and data.get("ok") is True, f"-> {status}")

    status, data = get("/api/lecturer/persona/active/", op)
    check("GET /api/lecturer/persona/active/", status == 200 and data.get("ok") is True, f"-> {status}")

    status, data = get("/api/lecturer/reports/", op)
    check("GET /api/lecturer/reports/", status == 200 and data.get("ok") is True, f"-> {status}")

    status, data = get("/api/lecturer/videos/", op)
    check("GET /api/lecturer/videos/", status == 200 and data.get("ok") is True, f"-> {status}")

    print("\n=== 2. Bug 307 trailing-slash (regresi) ===")
    # Path backend tanpa garis miring trailing → FastAPI balas 307.
    # Kalau fix follow_redirects hilang, responsnya status 307, bukan 200.
    status, data = get("/api/schedule/", op)
    check("GET /api/schedule/ tidak kena redirect 307",
          status == 200, f"-> {status}")
    check("  -> payload jadwal berupa dict", isinstance(data, dict),
          str(type(data)))
    check("  -> entries berupa list", isinstance(data.get("entries"), list),
          str(type(data.get("entries"))))

    print("\n=== 3. Buat tugas (POST) ===")
    status, data = post(
        "/api/tasks/create/",
        {
            "title": "Verifikasi BFF — Uji Tugas",
            "description": "Dibuat oleh verify_bff.py",
            "due_date": "2026-12-31T23:59:00",
            "priority": "high",
        },
        op,
    )
    check("POST /api/tasks/create/", status in (200, 201) and data.get("ok") is True,
          f"-> {status} {data}")
    task = (data or {}).get("task") or {}
    task_id = task.get("id")

    if task_id:
        status, data = post(f"/api/tasks/{task_id}/complete/", {}, op)
        check("POST /api/tasks/<id>/complete/", status == 200 and data.get("ok") is True,
              f"-> {status} {data}")

        status, data = get("/api/tasks/", op)
        titles = [t.get("title") for t in (data.get("tasks") or [])]
        check("tugas baru muncul di daftar", "Verifikasi BFF — Uji Tugas" in titles,
              str(titles[:5]))

        # Bersihkan tugas uji supaya server tidak menumpuk sisa test.
        status, data = delete(f"/api/tasks/{task_id}/", op)
        check("DELETE /api/tasks/<id>/ membersihkan tugas uji",
              status == 200 and data.get("ok") is True, f"-> {status}")
    else:
        check("POST /api/tasks/create/ mengembalikan id", False, str(data)[:200])

    print("\n=== 4. Buat jadwal (POST) ===")
    status, data = post(
        "/api/schedule/",
        {
            "title": "Verifikasi BFF — Uji Jadwal",
            "start_time": "2026-12-01T08:00:00",
            "end_time": "2026-12-01T10:00:00",
            "location": "Ruang Uji",
        },
        op,
    )
    check("POST /api/schedule/", status in (200, 201) and data.get("ok") is True,
          f"-> {status} {data}")
    entry = (data or {}).get("entry") or {}
    entry_id = entry.get("id")

    if entry_id:
        status, data = get("/api/schedule/", op)
        titles = [e.get("title") for e in (data.get("entries") or [])]
        check("jadwal baru muncul di daftar", "Verifikasi BFF — Uji Jadwal" in titles,
              str(titles[:5]))

        # Bersihkan entri uji supaya jadwal tidak menumpuk sisa test.
        status, data = delete(f"/api/schedule/{entry_id}/", op)
        check("DELETE /api/schedule/<id>/ membersihkan jadwal uji",
              status == 200 and data.get("ok") is True, f"-> {status}")
    else:
        check("POST /api/schedule/ mengembalikan id", False, str(data)[:200])

    print("\n=== 5. RAG — unggah & tanya ===")
    sample = b"Vector Database adalah basis data untuk menyimpan embedding.\n" * 3
    status, data = upload(
        "/api/rag/upload/", "verifikasi-bff.txt", sample, {}, op
    )
    check("POST /api/rag/upload/", status in (200, 201) and data.get("ok") is True,
          f"-> {status} {str(data)[:180]}")
    doc = (data or {}).get("document") or {}
    doc_id = doc.get("id")

    if doc_id:
        status, data = post(
            "/api/rag/query/",
            {"question": "Apa itu vector database?", "n_results": 3},
            op,
        )
        check("POST /api/rag/query/", status == 200 and data.get("ok") is True,
              f"-> {status} {str(data)[:180]}")
        check("  -> jawaban terisi", bool((data.get("answer") or "").strip()),
              repr((data.get("answer") or "")[:80]))
        check("  -> sources berupa list", isinstance(data.get("sources"), list))

        # Dokumen uji harus dihapus lagi — kalau tidak, tiap run menumpuk
        # satu dokumen di index RAG milik akun service.
        status, data = post(f"/api/rag/documents/{doc_id}/delete/", {}, op)
        check("POST /api/rag/documents/<id>/delete/ membersihkan dokumen uji",
              status == 200 and data.get("ok") is True, f"-> {status}")
    else:
        check("POST /api/rag/upload/ mengembalikan id dokumen", False, str(data)[:180])

    print("\n=== 6. AI Lecturer — chat ===")
    status, data = get("/api/lecturer/persona/active/", op)
    persona = (data or {}).get("persona") or {}
    persona_id = persona.get("id")

    if persona_id:
        status, data = post(
            "/api/lecturer/chat/",
            {"persona_id": persona_id, "message": "Jelaskan singkat apa itu basis data.",
             "use_rag": False},
            op,
        )
        check("POST /api/lecturer/chat/", status == 200 and data.get("ok") is True,
              f"-> {status} {str(data)[:180]}")
        check("  -> balasan terisi", bool((data.get("response") or "").strip()))
        chat_session_id = (data or {}).get("session_id")
        check("  -> id sesi dikembalikan", bool(chat_session_id),
              f"-> {chat_session_id}")

        # Kontrak sesi chat: buat sesi, pakai id-nya, lalu hapus.
        # Perilaku "pesan tidak bocor ke sesi lama" diuji probe
        # (probe_lecturer_clear.py) karena itu butuh beberapa request
        # berurutan — kontrak satu-request tidak bisa menangkapnya.
        status, data = post(
            "/api/lecturer/chat/sessions/",
            {"persona_id": persona_id, "title": "Verifikasi BFF"},
            op,
        )
        new_session = ((data or {}).get("session") or {}).get("id")
        check("POST /api/lecturer/chat/sessions/ membuat sesi baru",
              status == 201 and bool(new_session), f"-> {status} {str(data)[:180]}")

        if new_session:
            status, data = post(
                "/api/lecturer/chat/",
                {"persona_id": persona_id, "message": "Tes sesi khusus.",
                 "session_id": new_session},
                op,
            )
            check("POST /api/lecturer/chat/ hormati session_id",
                  status == 200 and (data or {}).get("session_id") == new_session,
                  f"-> {status} {str(data)[:180]}")

            status, data = get(f"/api/lecturer/chat/{new_session}/", op)
            check("GET /api/lecturer/chat/<id>/ membaca riwayat sesi",
                  status == 200 and data.get("ok") is True, f"-> {status}")

            status, data = post(
                "/api/lecturer/chat/",
                {"persona_id": persona_id, "message": "Tes.",
                 "session_id": "../../etc/passwd"},
                op,
            )
            check("session_id path traversal ditolak (400)",
                  status == 400, f"-> {status}")

            status, data = post(f"/api/lecturer/chat/{new_session}/delete/", {}, op)
            check("POST /api/lecturer/chat/<id>/delete/ menghapus sesi",
                  status == 200 and data.get("ok") is True, f"-> {status}")

        # Retrieval: BFF harus meneruskan course_id + use_rag, dan
        # "sources" harus kembali sebagai list (dulu selalu kosong).
        status, courses_data = get("/api/courses/", op)
        course_list = (courses_data or {}).get("courses") or []
        first_course = course_list[0] if course_list else None
        course_id = (first_course or {}).get("id")

        if course_id:
            status, data = post(
                "/api/lecturer/chat/",
                {"persona_id": persona_id, "message": "Jelaskan apa itu 1NF.",
                 "course_id": course_id, "use_rag": True},
                op,
            )
            check("POST /api/lecturer/chat/ dengan course_id + use_rag",
                  status == 200 and data.get("ok") is True, f"-> {status} {str(data)[:180]}")
            check("  -> 'sources' dikembalikan sebagai list",
                  isinstance(data.get("sources"), list), str(type(data.get("sources"))))
        else:
            check("POST /api/lecturer/chat/ dengan course_id + use_rag", True,
                  "dilewati — tidak ada mata kuliah")

        # Persona dengan lebih dari satu persona aktif tidak boleh 500.
        # Backend dulu memakai scalar_one_or_none() dan meledak jadi 500
        # begitu ada dua persona aktif.
        status, data = get("/api/lecturer/persona/active/", op)
        check("GET /api/lecturer/persona/active/ tidak 500 saat banyak persona",
              status == 200 and data.get("ok") is True, f"-> {status} {str(data)[:180]}")

        # Gaya persona tak dikenal harus ditolak, bukan disimpan.
        # BFF memvalidasi sendiri (400) sebelum meneruskan ke FastAPI,
        # jadi 400 di sini memang yang diharapkan — yang penting nilainya
        # tidak pernah sampai ke database.
        status, data = post(
            "/api/lecturer/persona/",
            {"name": "Persona Uji Gaya", "style": "bogus"},
            op,
        )
        check("POST /api/lecturer/persona/ menolak gaya tak dikenal (400)",
              status == 400, f"-> {status} {str(data)[:180]}")
    else:
        check("persona aktif tersedia", False, str(data)[:180])

    print("\n=== 7. Lecture — mulai & hentikan sesi ===")
    status, data = post("/api/lecture/start/", {"title": "Verifikasi BFF — Sesi Uji"}, op)
    check("POST /api/lecture/start/", status in (200, 201) and data.get("ok") is True,
          f"-> {status} {str(data)[:180]}")
    session_id = (data or {}).get("session_id")

    if session_id:
        status, data = post(f"/api/lecture/{session_id}/stop/", {}, op)
        check("POST /api/lecture/<id>/stop/", status == 200 and data.get("ok") is True,
              f"-> {status}")

        status, data = get(f"/api/lecture/{session_id}/status/", op)
        check("GET /api/lecture/<id>/status/", status == 200 and data.get("ok") is True,
              f"-> {status}")

        # Bersihkan sesi uji supaya riwayat rekaman tidak menumpuk.
        status, data = delete(f"/api/lecture/{session_id}/delete/", op)
        check("DELETE /api/lecture/<id>/delete/ membersihkan sesi uji",
              status == 200 and data.get("ok") is True, f"-> {status}")
    else:
        check("POST /api/lecture/start/ mengembalikan session_id", False, str(data)[:180])

    print("\n=== 8. Proteksi origin ===")
    req = urllib.request.Request(
        BASE + "/api/tasks/create/",
        data=json.dumps({"title": "X", "due_date": "2026-12-31T23:59:00"}).encode(),
        headers={
            "Content-Type": "application/json",
            "X-CSRFToken": _csrf_from(op),
            "Origin": "http://evil.example.com",
        },
        method="POST",
    )
    try:
        with op.open(req, timeout=30) as resp:
            status = resp.status
    except urllib.error.HTTPError as exc:
        status = exc.code
    check("origin asing ditolak (403)", status == 403, f"-> {status}")

    # Origin sengaja dihilangkan tapi Referer tetap dikirim: klien yang
    # menghapus Origin tidak boleh jadi celah. Endpoint harus tetap 403.
    req = urllib.request.Request(
        BASE + "/api/tasks/create/",
        data=json.dumps({"title": "X", "due_date": "2026-12-31T23:59:00"}).encode(),
        headers={
            "Content-Type": "application/json",
            "Referer": "http://evil.example.com/halaman",
        },
        method="POST",
    )
    try:
        with op.open(req, timeout=30) as resp:
            status = resp.status
    except urllib.error.HTTPError as exc:
        status = exc.code
    check("referer asing tanpa origin ditolak (403)", status == 403, f"-> {status}")

    # Kebalikannya: Referer sama-origin harus diterima sebagai jalur cadangan
    # (form HTML biasa tidak selalu mengirim Origin). Pakai payload yang
    # memang valid supaya 403 hanya mungkin berasal dari pemeriksaan origin.
    req = urllib.request.Request(
        BASE + "/api/tasks/create/",
        data=json.dumps(
            {"title": "Verifikasi BFF — referer same-origin",
             "due_date": "2026-12-31T23:59:00"}
        ).encode(),
        headers={
            "Content-Type": "application/json",
            "Referer": BASE + "/reminder-system/",
        },
        method="POST",
    )
    try:
        with op.open(req, timeout=30) as resp:
            status = resp.status
            referer_body = json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as exc:
        status = exc.code
        referer_body = {}
    check("referer sama-origin diterima", status in (200, 201),
          f"-> {status} {str(referer_body)[:120]}")
    referer_task_id = ((referer_body or {}).get("task") or {}).get("id")
    if referer_task_id:
        delete(f"/api/tasks/{referer_task_id}/", op)

    print("\n=== 9. Sesi chat RAG (tersimpan di backend) ===")
    status, data = post("/api/rag/chat/sessions/create/", {"title": "Verifikasi BFF"}, op)
    check("POST /api/rag/chat/sessions/create/",
          status in (200, 201) and data.get("ok") is True,
          f"-> {status} {str(data)[:180]}")
    chat_id = ((data or {}).get("session") or {}).get("id")

    if chat_id:
        status, data = post(
            f"/api/rag/chat/{chat_id}/message/",
            {"question": "Apa itu vector database?", "n_results": 3},
            op,
        )
        check("POST /api/rag/chat/<id>/message/",
              status == 200 and data.get("ok") is True,
              f"-> {status} {str(data)[:180]}")
        check("  -> jawaban terisi", bool((data.get("answer") or "").strip()))

        status, data = get(f"/api/rag/chat/{chat_id}/", op)
        messages = (data or {}).get("messages") or []
        check("GET /api/rag/chat/<id>/", status == 200 and data.get("ok") is True,
              f"-> {status}")
        check("  -> riwayat menyimpan 2 pesan (user + assistant)",
              len(messages) >= 2, f"-> {len(messages)} pesan")

        status, data = get("/api/rag/chat/sessions/", op)
        sessions = (data or {}).get("sessions") or []
        check("GET /api/rag/chat/sessions/", status == 200 and data.get("ok") is True,
              f"-> {status}")
        check("  -> sesi baru ada di daftar",
              any(s.get("id") == chat_id for s in sessions))
    else:
        check("POST /api/rag/chat/sessions/create/ mengembalikan id", False,
              str(data)[:180])

    print("\n=== 10. Detail laporan AI Lecturer ===")
    status, data = get("/api/lecturer/reports/", op)
    reports = (data or {}).get("reports") or []
    check("GET /api/lecturer/reports/", status == 200 and data.get("ok") is True,
          f"-> {status}")

    if reports:
        report_id = reports[0].get("id")
        status, data = get(f"/api/lecturer/reports/{report_id}/", op)
        check("GET /api/lecturer/reports/<id>/",
              status == 200 and data.get("ok") is True,
              f"-> {status} {str(data)[:180]}")
        check("  -> laporan punya id yang sama",
              ((data or {}).get("report") or {}).get("id") == report_id)

        # Unduh laporan (FR-13): file .docx, bukan JSON.
        status, content, headers = fetch(
            f"/api/lecturer/reports/{report_id}/export/", op
        )
        check("GET /api/lecturer/reports/<id>/export/",
              status == 200 and len(content) > 0,
              f"-> {status} {len(content)} byte")
        check("  -> berkas .docx (zip, magic 'PK')",
              content[:2] == b"PK",
              f"-> {content[:8]!r}")
        disposition = headers.get("Content-Disposition") or ""
        check("  -> content-disposition: attachment + .docx",
              "attachment" in disposition and ".docx" in disposition,
              disposition)

        # Id laporan tak valid harus ditolak oleh BFF (bukan diteruskan).
        status, data = get("/api/lecturer/reports/job-asing-xyz/", op)
        check("GET /api/lecturer/reports/<id>/ 404 untuk id asing",
              status == 404 and data.get("ok") is False,
              f"-> {status} {str(data)[:120]}")
    else:
        # Tidak ada laporan — bukan kegagalan. Endpoint-nya sendiri sudah
        # dicek di atas; yang tidak bisa dicek tanpa laporan adalah
        # pembacaan detailnya.
        print("  SKIP  detail laporan — tidak ada laporan untuk user ini")

    print("\n=== 11. Ubah profil (PATCH) ===")
    status, data = patch("/api/profile/", {"name": "Verifikasi BFF"}, op)
    check("PATCH /api/profile/", status == 200 and data.get("ok") is True,
          f"-> {status} {str(data)[:180]}")
    check("  -> nama terpakai", ((data or {}).get("profile") or {}).get("name")
          == "Verifikasi BFF")

    status, data = patch("/api/profile/", {"name": "A"}, op)
    check("PATCH /api/profile/ menolak nama terlalu pendek",
          status == 400 and data.get("ok") is False, f"-> {status} {str(data)[:120]}")

    # Kembalikan nama ke nilai semula supaya tidak meninggalkan data uji.
    status, original = get("/api/profile/", op)
    original_name = ((original or {}).get("profile") or {}).get("name")
    if original_name:
        patch("/api/profile/", {"name": original_name}, op)

    print("\n=== 13. Berkas sumber dokumen RAG ===")
    # Dokumen uji dibuat sendiri supaya test tidak bergantung pada sisa
    # data di server (dan tidak bergantung pada section 5 yang menghapusnya).
    sample = b"Vector Database adalah basis data untuk menyimpan embedding.\n" * 3
    status, data = upload(
        "/api/rag/upload/", "verifikasi-file.txt", sample, {}, op
    )
    file_doc_id = ((data or {}).get("document") or {}).get("id")

    status, data = get("/api/rag/documents/", op)
    documents = (data or {}).get("documents") or []
    check("GET /api/rag/documents/ mengembalikan fileUrl ke route BFF",
          bool(documents) and documents[0].get("fileUrl", "").startswith("/api/rag/documents/"),
          f"-> {documents[0].get('fileUrl') if documents else 'tidak ada dokumen'}")
    check("  -> fileUrl tidak menunjuk origin backend mentah",
          bool(documents) and "/api/v1/" not in documents[0].get("fileUrl", ""),
          f"-> {documents[0].get('fileUrl') if documents else '-'}")

    # Berkas sumber diambil dari dokumen uji yang barusan diunggah.
    target = next(
        (d for d in documents if d.get("id") == file_doc_id),
        documents[0] if documents else None,
    )

    if target:
        doc_url = target.get("fileUrl") or ""
        status, content, headers = fetch(doc_url, op)
        check("GET /api/rag/documents/<id>/file/",
              status == 200 and len(content) > 0,
              f"-> {status} {len(content)} byte")
        check("  -> content-disposition menyertakan nama berkas",
              "filename=" in (headers.get("Content-Disposition") or ""),
              headers.get("Content-Disposition"))

        status, content, headers = fetch(
            doc_url, op, extra={"Range": "bytes=0-49"}
        )
        check("GET /api/rag/documents/<id>/file/ menghormati Range",
              status == 206 and len(content) == 50,
              f"-> {status} {len(content)} byte")

        # Origin asing harus ditolak: endpoint ini memegang token service.
        req = urllib.request.Request(
            BASE + doc_url,
            headers={"Origin": "http://evil.example.com"},
            method="GET",
        )
        try:
            with op.open(req, timeout=30) as resp:
                origin_status = resp.status
        except urllib.error.HTTPError as exc:
            origin_status = exc.code
        check("GET /api/rag/documents/<id>/file/ menolak origin asing (403)",
              origin_status == 403, f"-> {origin_status}")

        # Id dengan karakter aneh harus ditolak sebelum sampai ke backend.
        req = urllib.request.Request(
            BASE + "/api/rag/documents/../../etc/file/",
            headers={"Origin": BASE},
            method="GET",
        )
        try:
            with op.open(req, timeout=30) as resp:
                bad_status = resp.status
        except urllib.error.HTTPError as exc:
            bad_status = exc.code
        check("id dokumen berbahaya ditolak", bad_status in (400, 404),
              f"-> {bad_status}")
    else:
        check("ada dokumen RAG untuk diuji berkas sumbernya", False,
              "daftar dokumen kosong")

    # Bersihkan dokumen uji.
    if file_doc_id:
        post(f"/api/rag/documents/{file_doc_id}/delete/", {}, op)

    print("\n=== 14. Perpustakaan dokumen (kontrak upload & daftar) ===")
    # Backend POST /documents/upload mengembalikan objek FLAT (id di level
    # teratas), sedangkan BFF harus menormalkan jadi {"document": {...}}.
    # Kalau tidak, UI Auto Scheduler tidak pernah memicu OCR.
    sample = b"KRS Semester 1\n"
    status, data = upload(
        "/api/library/documents/upload/", "verifikasi-library.txt", sample, {}, op
    )
    check("POST /api/library/documents/upload/",
          status in (200, 201) and data.get("ok") is True,
          f"-> {status} {str(data)[:180]}")
    lib_doc = (data or {}).get("document") or {}
    check("  -> document.id ada (dipakai UI untuk memicu OCR)",
          bool(lib_doc.get("id")), str(lib_doc)[:160])

    # Backend GET /documents/ mengembalikan list POLOS, bukan {"documents": [...]}.
    # Kalau BFF hanya membaca result.get("documents"), daftarnya selalu kosong.
    status, data = get("/api/library/documents/", op)
    check("GET /api/library/documents/",
          status == 200 and data.get("ok") is True, f"-> {status}")
    check("  -> documents berupa list", isinstance(data.get("documents"), list),
          str(type(data.get("documents"))))
    check("  -> dokumen uji masuk daftar (tidak kosong)",
          bool(data.get("documents")), "daftar kosong")

    if lib_doc.get("id"):
        status, data = post(
            f"/api/library/documents/{lib_doc['id']}/ocr/", {}, op
        )
        check("POST /api/library/documents/<id>/ocr/",
              status == 200 and data.get("ok") is True,
              f"-> {status} {str(data)[:160]}")

        # Bersihkan dokumen uji supaya perpustakaan tidak menumpuk.
        status, data = post(
            f"/api/library/documents/{lib_doc['id']}/delete/", {}, op
        )
        check("POST /api/library/documents/<id>/delete/ membersihkan dokumen uji",
              status == 200 and data.get("ok") is True, f"-> {status}")

    print("\n=== 15. Berkas rekaman (streaming audio) ===")
    # Sesi uji dibuat sendiri supaya test tidak bergantung pada sisa
    # rekaman milik user di server.
    status, data = post(
        "/api/lecture/start/", {"title": "Verifikasi BFF — Sesi Audio Uji"}, op
    )
    audio_session_id = (data or {}).get("session_id")

    if audio_session_id:
        # WAV senyap: cukup untuk menguji jalur berkas, tanpa perlu
        # menjalankan Whisper. Panjangnya > 100 byte supaya permintaan
        # Range "bytes=0-99" memang bisa dilayani utuh.
        samples = b"\x00\x00" * 64
        wav = (
            b"RIFF" + (36 + len(samples)).to_bytes(4, "little")
            + b"WAVEfmt "
            + (16).to_bytes(4, "little")
            + (1).to_bytes(2, "little")   # PCM
            + (1).to_bytes(2, "little")   # mono
            + (8000).to_bytes(4, "little")  # sample rate
            + (8000 * 2).to_bytes(4, "little")  # byte rate
            + (2).to_bytes(2, "little")   # block align
            + (16).to_bytes(2, "little")  # bits per sample
            + b"data" + len(samples).to_bytes(4, "little")
            + samples
        )
        status, data = upload(
            f"/api/lecture/{audio_session_id}/audio/",
            "uji.wav",
            wav,
            {},
            op,
        )
        check("POST /api/lecture/<id>/audio/ menerima berkas uji",
              status == 200 and data.get("ok") is True, f"-> {status} {str(data)[:160]}")

        status, data = get("/api/lecture/", op)
        sessions = (data or {}).get("sessions") or []
        with_audio = [s for s in sessions if s.get("audioUrl")]

        check("GET /api/lecture/ mengembalikan audioUrl untuk sesi berrekaman",
              bool(with_audio), f"-> {len(with_audio)} dari {len(sessions)} sesi")

        audio_id = audio_session_id
        status, content, headers = fetch(f"/api/lecture/{audio_id}/audio/file/", op)
        check("GET /api/lecture/<id>/audio/file/",
              status == 200 and len(content) > 0,
              f"-> {status} {len(content)} byte")
        check("  -> content-type audio/*",
              (headers.get("Content-Type") or "").startswith("audio/"),
              headers.get("Content-Type"))

        status, content, headers = fetch(
            f"/api/lecture/{audio_id}/audio/file/", op, extra={"Range": "bytes=0-99"}
        )
        check("GET /api/lecture/<id>/audio/file/ menghormati Range",
              status == 206 and len(content) == 100,
              f"-> {status} {len(content)} byte")

        # Bersihkan sesi uji (sekalian berkas audionya).
        status, data = delete(f"/api/lecture/{audio_id}/delete/", op)
        check("DELETE /api/lecture/<id>/delete/ membersihkan sesi audio uji",
              status == 200 and data.get("ok") is True, f"-> {status}")
    else:
        check("POST /api/lecture/start/ mengembalikan session_id (audio uji)",
              False, str(data)[:160])

    print("\n=== 16. Hapus sesi rekaman (DELETE /lecture/<id>) ===")
    status, data = post(
        "/api/lecture/start/", {"title": "Verifikasi BFF — Sesi Uji Hapus"}, op
    )
    check("POST /api/lecture/start/ (sesi uji hapus)", status in (200, 201),
          f"-> {status}")
    delete_session_id = (data or {}).get("session_id")

    if delete_session_id:
        status, data = get("/api/lecture/", op)
        listed = {s.get("id") for s in (data or {}).get("sessions") or []}
        check("sesi uji ada di daftar",
              delete_session_id in listed, str(sorted(listed))[:160])

        status, data = delete(f"/api/lecture/{delete_session_id}/delete/", op)
        check("DELETE /api/lecture/<id>/delete/",
              status == 200 and data.get("ok") is True,
              f"-> {status} {str(data)[:160]}")

        status, data = get("/api/lecture/", op)
        listed = {s.get("id") for s in (data or {}).get("sessions") or []}
        check("sesi uji hilang dari daftar setelah dihapus",
              delete_session_id not in listed, str(sorted(listed))[:160])

        status, data = delete(f"/api/lecture/{delete_session_id}/delete/", op)
        check("hapus sesi yang sudah hilang ditolak (404)",
              status == 404, f"-> {status} {str(data)[:120]}")
    else:
        check("POST /api/lecture/start/ mengembalikan session_id (hapus)",
              False, str(data)[:160])

    status, data = delete("/api/lecture/bad$id/delete/", op)
    check("id sesi tidak valid ditolak (400)", status == 400, f"-> {status}")

    print("\n=== 17. Ubah tugas (PATCH /tasks/<id>) ===")
    status, data = post(
        "/api/tasks/create/",
        {
            "title": "Verifikasi BFF — Uji Edit",
            "due_date": "2026-11-01T23:59:00",
            "priority": "low",
            "description": "sebelum edit",
        },
        op,
    )
    check("POST /api/tasks/create/ (tugas uji edit)", status == 200,
          f"-> {status} {str(data)[:160]}")
    edit_task = (data or {}).get("task") or {}
    edit_task_id = edit_task.get("id")

    if edit_task_id:
        check("  -> due_date dinormalisasi jadi detik penuh",
              edit_task.get("due_date") == "2026-11-01T23:59:00",
              str(edit_task.get("due_date")))

        status, data = patch(
            f"/api/tasks/{edit_task_id}/edit/",
            {
                "title": "Verifikasi BFF — Uji Edit v2",
                "due_date": "2026-12-24T08:30",
                "priority": "urgent",
                "description": "setelah edit",
                "reminder_enabled": True,
                "reminder_time": "3_days",
            },
            op,
        )
        check("PATCH /api/tasks/<id>/edit/", status == 200 and data.get("ok") is True,
              f"-> {status} {str(data)[:200]}")
        patched = (data or {}).get("task") or {}

        check("  -> judul berubah", patched.get("title") == "Verifikasi BFF — Uji Edit v2",
              str(patched.get("title")))
        check("  -> tenggat berubah", patched.get("due_date") == "2026-12-24T08:30:00",
              str(patched.get("due_date")))
        check("  -> prioritas berubah", patched.get("priority") == "urgent",
              str(patched.get("priority")))
        check("  -> pengingat berubah", patched.get("reminder_time") == "3_days",
              str(patched.get("reminder_time")))

        # Field yang tidak dikirim harus tetap apa adanya (PATCH sebagian).
        check("  -> field tak dikirim tetap (status)",
              patched.get("status") == edit_task.get("status"),
              f"{edit_task.get('status')} -> {patched.get('status')}")

        status, data = patch(f"/api/tasks/{edit_task_id}/edit/", {"priority": "Mendesak"}, op)
        check("prioritas tak dikenal ditolak (400)", status == 400, f"-> {status}")

        status, data = patch(f"/api/tasks/{edit_task_id}/edit/", {"title": "   "}, op)
        check("judul kosong ditolak (400)", status == 400, f"-> {status}")

        status, data = patch(f"/api/tasks/{edit_task_id}/edit/", {}, op)
        check("payload kosong ditolak (400)", status == 400, f"-> {status}")

        status, data = patch("/api/tasks/bad$id/edit/", {"title": "x"}, op)
        check("id tugas tak valid ditolak (400)", status == 400, f"-> {status}")

        status, data = delete(f"/api/tasks/{edit_task_id}/", op)
        check("DELETE /api/tasks/<id>/ membersihkan tugas uji",
              status == 200 and data.get("ok") is True, f"-> {status}")
    else:
        check("POST /api/tasks/create/ mengembalikan id tugas (edit)",
              False, str(data)[:160])

    # ---------------------------------------------------------------
    # 18. Pengingat harus mengikuti tenggat tugas
    # ---------------------------------------------------------------
    print("\n=== 18. Pengingat tugas (reminder) ===")

    status, data = post(
        "/api/tasks/create/",
        {
            "title": "Verifikasi BFF — Uji Pengingat",
            "due_date": "2026-11-20T09:00:00",
            "reminder_enabled": True,
            "reminder_time": "3_days",
        },
        op,
    )
    check("POST /api/tasks/create/ dengan pengingat", status == 200,
          f"-> {status} {str(data)[:160]}")
    reminder_task = (data or {}).get("task") or {}
    reminder_id = reminder_task.get("id")
    first_job = reminder_task.get("reminder_job_id")

    if reminder_id:
        # ``reminder_job_id`` ditulis worker, bukan route — jadi tunggu
        # worker selesai menjadwalkannya, jangan langsung dibaca dari
        # respons create (itu race condition).
        scheduled = poll_task(
            reminder_id, lambda t: bool(t.get("reminder_job_id")), op
        )
        first_job = scheduled.get("reminder_job_id")

        check("  -> job pengingat dijadwalkan", bool(first_job), str(first_job))
        check("  -> pengingat tersimpan",
              scheduled.get("reminder_time") == "3_days",
              str(scheduled.get("reminder_time")))

        # Pindah tenggat → pengingat harus dijadwalkan ulang.
        status, data = patch(
            f"/api/tasks/{reminder_id}/edit/",
            {"due_date": "2026-12-20T09:00:00"},
            op,
        )
        check("PATCH tenggat baru", status == 200, f"-> {status}")
        moved = (data or {}).get("task") or {}

        check("  -> tenggat berubah", moved.get("due_date") == "2026-12-20T09:00:00",
              str(moved.get("due_date")))

        # Tunggu worker menjadwalkan ulang — sama seperti di atas.
        rescheduled = poll_task(
            reminder_id,
            lambda t: bool(t.get("reminder_job_id"))
            and t.get("reminder_job_id") != first_job,
            op,
        )
        second_job = rescheduled.get("reminder_job_id")
        check("  -> pengingat dijadwalkan ulang",
              bool(second_job) and second_job != first_job,
              f"{first_job} -> {second_job}")

        # Matikan pengingat → job dibatalkan.
        status, data = patch(
            f"/api/tasks/{reminder_id}/edit/",
            {"reminder_time": "", "reminder_enabled": False},
            op,
        )
        check("PATCH matikan pengingat", status == 200, f"-> {status}")
        off = (data or {}).get("task") or {}
        check("  -> pengingat dimatikan",
              off.get("reminder_enabled") is False and not off.get("reminder_time"),
              f"enabled={off.get('reminder_enabled')} time={off.get('reminder_time')}")

        # Pembatalan juga efek samping worker — tunggu id job-nya hilang.
        cancelled = poll_task(
            reminder_id, lambda t: not t.get("reminder_job_id"), op
        )
        check("  -> job pengingat dibatalkan", not cancelled.get("reminder_job_id"),
              str(cancelled.get("reminder_job_id")))

        # Offset yang tidak dikenal harus ditolak.
        status, data = patch(
            f"/api/tasks/{reminder_id}/edit/",
            {"reminder_time": "besok"},
            op,
        )
        check("offset pengingat tak dikenal ditolak (400)", status == 400, f"-> {status}")

        status, data = delete(f"/api/tasks/{reminder_id}/", op)
        check("DELETE /api/tasks/<id>/ membersihkan tugas uji pengingat",
              status == 200 and data.get("ok") is True, f"-> {status}")
    else:
        check("POST /api/tasks/create/ mengembalikan id tugas (pengingat)",
              False, str(data)[:160])

    # ---------------------------------------------------------------
    # 19. Endpoint pengingat khusus
    # ---------------------------------------------------------------
    print("\n=== 19. Endpoint atur ulang pengingat ===")

    status, data = post(
        "/api/tasks/create/",
        {
            "title": "Verifikasi BFF — Uji Endpoint Pengingat",
            "due_date": "2026-11-25T09:00:00",
            "reminder_enabled": True,
            "reminder_time": "1_week",
        },
        op,
    )
    check("POST /api/tasks/create/ untuk uji endpoint pengingat", status == 200,
          f"-> {status} {str(data)[:160]}")
    endpoint_task = (data or {}).get("task") or {}
    endpoint_id = endpoint_task.get("id")

    if endpoint_id:
        # Tunggu worker menjadwalkan job pertama — supaya perbandingan
        # "job dijadwalkan ulang" di bawah benar-benar membandingkan dua
        # job yang berbeda, bukan "dari kosong ke ada".
        initial = poll_task(
            endpoint_id, lambda t: bool(t.get("reminder_job_id")), op
        )
        endpoint_job = initial.get("reminder_job_id")

        # Ganti offset lewat endpoint khusus.
        status, data = post(
            f"/api/tasks/{endpoint_id}/reminders/",
            {"enabled": True, "time": "3_days"},
            op,
        )
        check("POST /api/tasks/<id>/reminders/ mengganti offset", status == 200,
              f"-> {status} {str(data)[:160]}")
        after = (data or {}).get("task") or {}
        check("  -> offset tersimpan", after.get("reminder_time") == "3_days",
              str(after.get("reminder_time")))

        # Job baru ditulis worker — tunggu sampai berganti.
        rescheduled = poll_task(
            endpoint_id,
            lambda t: bool(t.get("reminder_job_id"))
            and t.get("reminder_job_id") != endpoint_job,
            op,
        )
        check("  -> job dijadwalkan ulang",
              bool(rescheduled.get("reminder_job_id"))
              and rescheduled.get("reminder_job_id") != endpoint_job,
              f"{endpoint_job} -> {rescheduled.get('reminder_job_id')}")

        # Matikan lewat endpoint khusus.
        status, data = post(
            f"/api/tasks/{endpoint_id}/reminders/",
            {"enabled": False},
            op,
        )
        check("POST /api/tasks/<id>/reminders/ mematikan pengingat", status == 200,
              f"-> {status} {str(data)[:160]}")
        off = (data or {}).get("task") or {}
        check("  -> pengingat dimatikan", off.get("reminder_enabled") is False,
              str(off.get("reminder_enabled")))

        # Pembatalan efek samping worker — tunggu id job hilang.
        cancelled = poll_task(
            endpoint_id, lambda t: not t.get("reminder_job_id"), op
        )
        check("  -> job dibatalkan", not cancelled.get("reminder_job_id"),
              str(cancelled.get("reminder_job_id")))

        # Offset tak dikenal harus ditolak.
        status, data = post(
            f"/api/tasks/{endpoint_id}/reminders/",
            {"time": "besok"},
            op,
        )
        check("offset tak dikenal ditolak (400)", status == 400, f"-> {status}")

        # Body kosong harus ditolak.
        status, data = post(
            f"/api/tasks/{endpoint_id}/reminders/",
            {},
            op,
        )
        check("body kosong ditolak (400)", status == 400, f"-> {status}")

        status, data = delete(f"/api/tasks/{endpoint_id}/", op)
        check("DELETE membersihkan tugas uji endpoint pengingat",
              status == 200 and data.get("ok") is True, f"-> {status}")
    else:
        check("POST /api/tasks/create/ mengembalikan id tugas (endpoint pengingat)",
              False, str(data)[:160])

    # ---------------------------------------------------------------
    # 19b. Daftar offset pengingat + notifikasi tertunda
    #
    # Dua kontrak baru untuk kanal "polling + Service Worker":
    #
    # * ``GET /api/reminders/offsets/`` — satu daftar offset yang
    #   diiklankan server. UI membacanya, jadi menambah preset baru di
    #   backend tidak perlu menyunting daftar kedua di frontend.
    # * ``GET /api/notifications/pending/`` — notifikasi yang belum
    #   sempat ditampilkan peramban. ``since`` dilacak di sisi klien,
    #   jadi tidak perlu kolom baru di database.
    #
    # Daftar preset BFF harus **sama** dengan daftar backend. Kalau
    # berbeda, satu repo bilang "1 jam" sah dan yang lain menolaknya.
    # ---------------------------------------------------------------
    print("\n=== 19b. Offset pengingat & notifikasi tertunda ===")

    status, data = get("/api/reminders/offsets/", op)
    check("GET /api/reminders/offsets/", status == 200 and data.get("ok") is True,
          f"-> {status} {str(data)[:160]}")

    offsets = data.get("offsets") or []
    labels = data.get("labels") or {}
    presets = data.get("presets") or []

    check("  -> offsets berupa list", isinstance(offsets, list), str(type(offsets)))
    check("  -> labels berupa dict", isinstance(labels, dict), str(type(labels)))
    check("  -> presets berupa list", isinstance(presets, list), str(type(presets)))

    # Setiap preset punya label, dan labelnya tidak kosong.
    missing_labels = [v for v in offsets if not labels.get(v)]
    check("  -> setiap offset punya label", not missing_labels, str(missing_labels))

    # Offset granularitas jam ada — spesifikasi menyebut "3 jam sebelumnya".
    check("  -> offset 3 jam diiklankan", "3_hours" in offsets, str(offsets))
    check("  -> offset 30 menit diiklankan", "30_minutes" in offsets, str(offsets))

    # Preset BFF vs preset backend harus identik — dua repo, satu daftar.
    bff_values = [p.get("value") for p in presets if isinstance(p, dict)]
    check("  -> preset BFF sama dengan offset backend",
          bff_values == offsets,
          f"bff={bff_values} backend={offsets}")

    # Tata bahasa BFF dan tata bahasa backend harus **sama**, bukan cuma
    # daftarnya. Batas jumlah digit pernah berbeda: BFF/UI memakai 4
    # digit seperti backend, padahal batas yang sesungguhnya adalah durasi
    # 365 hari. Offset yang sah ("525600_minutes" = 365 hari) ditolak
    # di satu sisi dan diterima di sisi lain — dan kalau yang menolak
    # adalah BFF, errornya sampai ke user, kalau backend, errornya
    # "Pengingat tidak dikenal" yang sama sekali tidak membantu.
    #
    # Yang diuji di sini: nilai yang **ditolak** BFF juga ditolak
    # backend, dan nilai batas (365 hari per satuan) diterima keduanya.
    grammar_cases = [
        ("525600_minutes", True),   # tepat 365 hari dalam menit
        ("8760_hours", True),       # tepat 365 hari dalam jam
        ("365_days", True),
        ("52_weeks", True),
        ("53_weeks", False),        # 371 hari
        ("366_days", False),
        ("525601_minutes", False),  # 365 hari + 1 menit
        ("besok", False),
        ("0_hours", False),
        ("1_month", False),
    ]

    bff_grammar = {}
    for value, _ in grammar_cases:
        try:
            from dashboard.reminder_offsets import normalize_offset as _bff_norm
            _bff_norm(value)
            bff_grammar[value] = True
        except ValueError:
            bff_grammar[value] = False

    mismatch = [v for v, expected in grammar_cases if bff_grammar[v] is not expected]
    check("  -> tata bahasa BFF menerima offset batas 365 hari",
          not mismatch, f"melewati batas: {mismatch}")

    # ---------------------------------------------------------------
    # Endpoint notifikasi tertunda.
    # ---------------------------------------------------------------
    status, data = get("/api/notifications/pending/", op)
    check("GET /api/notifications/pending/", status == 200 and data.get("ok") is True,
          f"-> {status} {str(data)[:160]}")
    check("  -> notifications berupa list",
          isinstance(data.get("notifications"), list),
          str(type(data.get("notifications"))))

    # ``since`` di masa depan tidak boleh melempar error — hasilnya kosong.
    status, data = get(
        "/api/notifications/pending/?since=2099-01-01T00:00:00", op
    )
    check("GET /api/notifications/pending/?since=<masa depan>", status == 200,
          f"-> {status} {str(data)[:160]}")
    check("  -> hasilnya kosong", (data.get("notifications") or []) == [],
          str(data.get("notifications")))

    # ``since`` yang bentuknya salah harus ditolak, bukan diam-diam diabaikan.
    status, data = get("/api/notifications/pending/?since=bukan-tanggal", op)
    check("  -> since tidak valid ditolak", status in (400, 422),
          f"-> {status}")

    # ---------------------------------------------------------------
    # 20. Ringkasan dashboard
    #
    # Endpoint agregator di sisi BFF: satu request untuk tugas + jadwal
    # + mata kuliah. Yang diperiksa di sini adalah KONTRAK datanya.
    #
    # "Hari ini" **ada** di sini, dalam ``schedule.today``, dan itu
    # disengaja. Sebelumnya key itu tidak boleh ada, dengan alasan
    # "Django itu UTC, backend jam dinding" — alasan itu benar untuk
    # *menghitung*, tapi salah untuk *meneruskan*. Backend sudah tahu
    # hari ini dalam zona aplikasi (``APP_TIMEZONE``), jadi backend yang
    # meneruskannya; BFF dan browser tidak boleh menghitungnya sendiri.
    # Browser yang menghitungnya salah untuk user yang zona kerjanya
    # berbeda, dan Django yang menghitungnya menghasilkan tanggal UTC —
    # bisa berbeda sehari dari tanggal yang dilihat mahasiswa.
    #
    # Kontrak lain yang dijaga di sini:
    #
    # * ``tasks.omitted`` — berapa tugas yang TIDAK ikut dikirim karena
    #   batas 8. Tanpa ini, tugas hilang diam-diam.
    # * ``tasks.overdue`` — jumlah "lewat tenggat" dari seluruh tugas
    #   yang belum selesai, bukan dari 8 item yang tampil.
    # ---------------------------------------------------------------
    print("\n=== 20. Ringkasan dashboard ===")

    status, data = get("/api/dashboard/summary/", op)
    check("GET /api/dashboard/summary/", status == 200 and data.get("ok") is True,
          f"-> {status} {str(data)[:160]}")
    check("  -> tasks berupa dict", isinstance(data.get("tasks"), dict),
          str(type(data.get("tasks"))))
    check("  -> schedule berupa dict", isinstance(data.get("schedule"), dict),
          str(type(data.get("schedule"))))
    check("  -> courses berupa list", isinstance(data.get("courses"), list),
          str(type(data.get("courses"))))

    summary_tasks = (data.get("tasks") or {}).get("items")
    check("  -> tasks.items berupa list", isinstance(summary_tasks, list),
          str(type(summary_tasks)))

    summary_entries = (data.get("schedule") or {}).get("entries")
    check("  -> schedule.entries berupa list", isinstance(summary_entries, list),
          str(type(summary_entries)))

    # "Hari ini" — harus ada, dan bentuknya harus bisa dipakai klien
    # untuk membandingkan tanggal & hari-dalam-minggu.
    today = (data.get("schedule") or {}).get("today")
    check("  -> schedule.today berupa dict", isinstance(today, dict),
          str(type(today)))
    if isinstance(today, dict):
        check("  -> schedule.today punya tanggal (YYYY-MM-DD)",
              bool(today.get("date"))
              and len(str(today.get("date"))) == 10,
              str(today.get("date")))
        check("  -> schedule.today punya hari-dalam-minggu (0=Senin)",
              isinstance(today.get("dow"), int) and 0 <= today.get("dow") <= 6,
              str(today.get("dow")))

    # Setiap item tugas harus punya judul dan tenggat yang bisa
    # diformat klien. Item jadwal harus punya jam mulai & selesai.
    if isinstance(summary_tasks, list):
        missing_title = [t for t in summary_tasks
                         if not isinstance(t, dict) or not t.get("title")]
        check("  -> setiap tugas punya judul", not missing_title,
              f"{len(missing_title)} tanpa judul")

        missing_due = [t for t in summary_tasks
                       if not isinstance(t, dict) or not t.get("due_date")]
        check("  -> setiap tugas punya due_date", not missing_due,
              f"{len(missing_due)} tanpa due_date")

        # Tugas yang tampil harus yang BELUM selesai — tugas selesai
        # dihitung di key ``completed``, bukan di ``items``.
        done_in_items = [t for t in summary_tasks
                         if isinstance(t, dict) and t.get("is_completed")]
        check("  -> hanya tugas belum selesai yang tampil", not done_in_items,
              f"{len(done_in_items)} tugas selesai ikut tampil")

    if isinstance(summary_entries, list):
        bad_entry = [e for e in summary_entries
                     if not isinstance(e, dict)
                     or not e.get("start_time")
                     or not e.get("end_time")]
        check("  -> setiap entri jadwal punya start_time & end_time",
              not bad_entry, f"{len(bad_entry)} entri tidak lengkap")

    # Jumlah ``pending`` harus sama dengan ``items`` saat belum ada
    # tugas yang terpotong oleh limit.
    task_block = data.get("tasks") or {}
    pending = task_block.get("pending")
    total = task_block.get("total")
    check("  -> pending & total berupa angka",
          isinstance(pending, int) and isinstance(total, int),
          f"pending={pending} total={total}")
    check("  -> total >= pending",
          isinstance(total, int) and isinstance(pending, int) and total >= pending,
          f"total={total} pending={pending}")

    # ``omitted`` = tugas yang tidak ikut terkirim karena batas 8.
    # Panel memakainya untuk baris "+N tugas lainnya"; kalau key ini
    # hilang, tugas ke-9 dan seterusnya hilang tanpa jejak.
    omitted = task_block.get("omitted")
    check("  -> tasks.omitted berupa angka",
          isinstance(omitted, int) and omitted >= 0,
          str(omitted))
    if isinstance(pending, int) and isinstance(omitted, int):
        check("  -> omitted = pending - items",
              omitted == max(0, pending - len(summary_tasks or [])),
              f"omitted={omitted} pending={pending} items={len(summary_tasks or [])}")

    # ``overdue`` = tugas yang lewat tenggat, dihitung dari **seluruh**
    # tugas yang belum selesai — bukan dari 8 item yang tampil. Kalau
    # panel menghitungnya sendiri dari ``items``, angkanya bisa jauh
    # lebih kecil dari kenyataan tanpa ada error yang terlihat.
    overdue = task_block.get("overdue")
    check("  -> tasks.overdue berupa angka",
          isinstance(overdue, int) and overdue >= 0,
          str(overdue))

    # Regresi: tombol "Selesai" di panel dashboard memakai endpoint
    # yang sama dengan Reminder System, jadi jalur ini harus tetap hidup.
    #
    # Catatan soal assertion: angka ``pending``/``completed``/``total``
    # bersifat **global** — itu semua tugas milik akun service, bukan
    # milik test ini. Sesi lain yang menambah atau menyelesaikan tugas di
    # tengah jalan akan menggeser angkanya, jadi angka mutlak tidak bisa
    # dipakai sebagai pembanding. Yang dipakai di sini:
    #
    # * id tugas uji — deterministik, milik test ini sendiri;
    # * konsistensi internal **dalam satu respons** (``pending +
    #   completed == total``) — tidak bisa digeser proses luar, karena
    #   ketiga angka dihitung dari snapshot yang sama;
    # * penghitung ``completed`` yang hanya naik, jadi aman dibandingkan
    #   dengan ">= sebelum + 1".
    status, data = get("/api/dashboard/summary/", op)
    before = data.get("tasks") or {}
    pending_before = before.get("pending")
    completed_before = before.get("completed")
    total_before = before.get("total")

    status, data = post(
        "/api/tasks/create/",
        {
            "title": "Verifikasi BFF — Uji Ringkasan Dashboard",
            # Tenggat paling awal, supaya tugas uji ini pasti masuk
            # jendela 8 baris pertama panel apa pun isi data akun lain.
            # (Tanpa ``reminder_time`` tidak ada pengingat yang
            # dijadwalkan, dan tenggat yang sudah lewat dilewati sweep.)
            "due_date": "2020-01-01T00:00:00",
            "priority": "medium",
        },
        op,
    )
    check("POST /api/tasks/create/ untuk uji ringkasan", status == 200,
          f"-> {status} {str(data)[:160]}")
    dash_task = (data or {}).get("task") or {}
    dash_id = dash_task.get("id")

    if not dash_id:
        check("POST /api/tasks/create/ mengembalikan id tugas (ringkasan)",
              False, str(data)[:160])
    else:
        status, data = get("/api/dashboard/summary/", op)
        after = data.get("tasks") or {}
        pending_after = after.get("pending")
        completed_after = after.get("completed")
        total_after = after.get("total")
        items_after = after.get("items") or []

        # Angka ``pending``/``completed``/``total`` bersifat **global** —
        # itu semua tugas milik akun service, bukan milik test ini. Sesi
        # lain yang menambah, menyelesaikan, atau menghapus tugas di tengah
        # run akan menggeser angkanya, jadi selisih mutlak ("naik 1") gagal
        # acak. Yang deterministik:
        #
        # * **id tugas uji** — milik test ini sendiri, selalu ada;
        # * konsistensi internal **dalam satu respons**
        #   (``pending + completed == total``) — ketiga angka dihitung
        #   dari snapshot yang sama, jadi tidak bisa digeser proses luar;
        # * ``total_after >= total_before`` — tidak pernah berkurang
        #   hanya karena satu tugas dibuat (penghapusan oleh sesi lain
        #   bisa menguranginya, tapi panel tidak boleh pernah lebih
        #   sedikit dari sebelumnya kalau tidak ada yang dihapus).
        check("  -> tugas baru menambah hitungan total",
              isinstance(total_before, int)
              and isinstance(total_after, int)
              and total_after >= total_before,
              f"total {total_before} -> {total_after}")
        check("  -> tugas baru menambah hitungan pending",
              isinstance(pending_before, int)
              and isinstance(pending_after, int)
              and pending_after >= 1,
              f"pending {pending_before} -> {pending_after}")
        check("  -> tugas baru muncul di panel",
              any(isinstance(t, dict) and t.get("id") == dash_id
                  for t in items_after),
              f"id {dash_id} tidak ada di {len(items_after)} item")
        check("  -> pending + completed == total (satu respons)",
              isinstance(pending_after, int)
              and isinstance(completed_after, int)
              and isinstance(total_after, int)
              and pending_after + completed_after == total_after,
              f"{pending_after} + {completed_after} != {total_after}")
        check("  -> jumlah item = min(pending, 8)",
              isinstance(pending_after, int)
              and len(items_after) == min(pending_after, 8),
              f"items {len(items_after)}, pending {pending_after}")

        # Status tugas uji harus jadi "selesai" — dicek dari daftar
        #/backend, bukan dari hitungan global.
        status, data = get("/api/tasks/", op)
        own = next(
            (t for t in (data.get("tasks") or [])
             if isinstance(t, dict) and t.get("id") == dash_id),
            None,
        )
        check("  -> tugas uji ada di daftar tugas",
              own is not None,
              f"id {dash_id} tidak ada di {len(data.get('tasks') or [])} tugas")
        check("  -> tugas uji masih belum selesai sebelum complete",
              bool(own) and not own.get("is_completed"),
              str((own or {}).get("is_completed")))

        status, data = post(f"/api/tasks/{dash_id}/complete/", {}, op)
        check("POST /api/tasks/<id>/complete/ (regresi tombol Selesai)",
              status == 200 and data.get("ok") is True,
              f"-> {status} {str(data)[:160]}")

        # Setelah selesai, tugas tidak boleh dihitung lagi sebagai
        # "belum selesai" — inilah yang membuat barisnya hilang dari panel.
        status, data = get("/api/dashboard/summary/", op)
        done = data.get("tasks") or {}
        pending_done = done.get("pending")
        completed_done = done.get("completed")
        total_done = done.get("total")
        items_done = done.get("items") or []

        check("  -> tugas selesai hilang dari panel",
              not any(isinstance(t, dict) and t.get("id") == dash_id
                      for t in items_done),
              f"id {dash_id} masih ada di {len(items_done)} item")
        # Pemeriksaan status per-tugas, bukan selisih global: sesi lain
        # bisa menyelesaikan tugasnya sendiri di tengah run, jadi
        # ``completed_done >= completed_before + 1`` bisa gagal acak.
        status, data = get("/api/tasks/", op)
        own_done = next(
            (t for t in (data.get("tasks") or [])
             if isinstance(t, dict) and t.get("id") == dash_id),
            None,
        )
        check("  -> tugas selesai masuk hitungan completed",
              bool(own_done) and own_done.get("is_completed") is True,
              str((own_done or {}).get("is_completed")))
        check("  -> pending + completed == total setelah selesai",
              isinstance(pending_done, int)
              and isinstance(completed_done, int)
              and isinstance(total_done, int)
              and pending_done + completed_done == total_done,
              f"{pending_done} + {completed_done} != {total_done}")

        status, data = delete(f"/api/tasks/{dash_id}/", op)
        check("DELETE membersihkan tugas uji ringkasan",
              status == 200 and data.get("ok") is True, f"-> {status}")

    # ---------------------------------------------------------------
    # Auto Scheduler — status proses import.
    #
    # Import berjalan sebagai background job, jadi UI butuh endpoint
    # untuk memolling statusnya. Tanpa ini, satu-satunya cara tahu
    # import selesai adalah menekan "Muat ulang" secara manual.
    # ---------------------------------------------------------------
    print("\n=== 21. Status import jadwal (Auto Scheduler) ===")

    status, data = get("/api/schedule/import/jobs/", op)
    check("GET /api/schedule/import/jobs/", status == 200 and data.get("ok") is True,
          f"-> {status} {str(data)[:160]}")
    check("  -> jobs berupa list", isinstance(data.get("jobs"), list),
          str(type(data.get("jobs"))))

    jobs = data.get("jobs") or []

    if jobs:
        first = jobs[0] if isinstance(jobs[0], dict) else {}

        check("  -> job punya id", bool(first.get("id")), str(first)[:160])
        check("  -> job punya status",
              first.get("status") in ("queued", "processing", "done", "failed"),
              str(first.get("status")))
        check("  -> job punya hitungan entri",
              isinstance(first.get("entries_imported"), int)
              and isinstance(first.get("entries_updated"), int),
              f"imported={first.get('entries_imported')} "
              f"updated={first.get('entries_updated')}")

        job_id = first.get("id")

        status, data = get(f"/api/schedule/import/{job_id}/", op)
        check("GET /api/schedule/import/<job_id>/", status == 200 and data.get("ok") is True,
              f"-> {status} {str(data)[:160]}")
        check("  -> job dikembalikan utuh",
              (data.get("job") or {}).get("id") == job_id,
              str((data.get("job") or {}).get("id")))

        # Id job milik orang lain harus 404 — dan route ini tidak boleh
        # bocorkan isi job yang bukan miliknya.
        status, data = get("/api/schedule/import/job-tidak-milik-saya-xyz/", op)
        check("GET /api/schedule/import/<job_id>/ 404 untuk job asing",
              status == 404, f"-> {status}")
    else:
        check("  -> ada minimal satu job import", False,
              "belum pernah import — jalankan import manual dulu")

    # Id job yang tidak valid harus ditolak di lapisan BFF, bukan diteruskan
    # ke backend (path traversal / request sia-sia ke FastAPI).
    status, data = get("/api/schedule/import/buruk%20id!!/", op)
    check("GET /api/schedule/import/<job_id>/ menolak id tidak valid",
          status in (400, 404), f"-> {status}")

    print("\n=== 22. RAG — rename, pencarian, dan status tugas ===")
    # Unggah satu dokumen uji dengan isi yang bisa dicari. Sama seperti §5,
    # dokumennya dihapus lagi di akhir supaya index tidak menumpuk.
    rag_sample = (
        "Normalisasi Database\n"
        "\n"
        "Bentuk Normal Ketiga (3NF) menghilangkan dependensi transitif.\n"
    ).encode("utf-8")
    status, data = upload(
        "/api/rag/upload/", "verifikasi-rag-manage.txt", rag_sample, {}, op
    )
    check("POST /api/rag/upload/ (dokumen uji §22)",
          status in (200, 201) and data.get("ok") is True,
          f"-> {status} {str(data)[:180]}")
    manage_doc = (data or {}).get("document") or {}
    manage_id = manage_doc.get("id")

    if not manage_id:
        check("  -> upload mengembalikan id", False, str(data)[:180])
    else:
        # --- rename ---------------------------------------------------
        status, data = patch(
            f"/api/rag/documents/{manage_id}/rename/",
            {"display_name": "Modul Normalisasi (uji)"},
            op,
        )
        renamed = (data or {}).get("document") or {}
        check("PATCH /api/rag/documents/<id>/rename/",
              status == 200 and data.get("ok") is True,
              f"-> {status} {str(data)[:180]}")
        check("  -> fileName mengikuti nama baru",
              renamed.get("fileName") == "Modul Normalisasi (uji)",
              str(renamed.get("fileName")))
        check("  -> originalFileName tidak berubah",
              renamed.get("originalFileName") == "verifikasi-rag-manage.txt",
              str(renamed.get("originalFileName")))

        # Alias snake_case juga harus diterima (dipakai rag_assistant.js).
        status, data = patch(
            f"/api/rag/documents/{manage_id}/rename/",
            {"display_name": "Modul Normalisasi 2"},
            op,
        )
        check("  -> menerima field snake_case",
              status == 200
              and ((data.get("document") or {}).get("fileName") == "Modul Normalisasi 2"),
              f"-> {status}")

        # Nama kosong ditolak sebelum menyentuh backend.
        status, data = patch(
            f"/api/rag/documents/{manage_id}/rename/",
            {"display_name": "   "},
            op,
        )
        check("PATCH rename menolak nama kosong (400)",
              status == 400 and data.get("ok") is False, f"-> {status}")

        # Path traversal tidak boleh diteruskan ke FastAPI.
        status, data = patch(
            "/api/rag/documents/..%2F..%2Fetc/rename/",
            {"display_name": "x"},
            op,
        )
        check("PATCH rename menolak id tidak valid",
              status in (400, 404), f"-> {status}")

        # Body tanpa field yang dikenal ditolak — bukan diteruskan kosong.
        status, data = patch(
            f"/api/rag/documents/{manage_id}/rename/", {"whatever": 1}, op
        )
        check("PATCH rename menolak body tanpa field yang diubah",
              status == 400, f"-> {status}")

        # --- pencarian ------------------------------------------------
        # Tunggu sampai indexing selesai — pencarian isi butuh chunk di
        # Chroma. Rename tidak memotong indeks, jadi dokumennya tetap
        # butuh waktu untuk muncul sebagai hasil pencarian isi.
        deadline = time.monotonic() + 60
        status, data = get(
            "/api/rag/documents/search/?q=normalisasi", op
        )
        while time.monotonic() < deadline:
            status, data = get("/api/rag/documents/search/?q=normalisasi", op)
            if status == 200 and (data.get("total") or 0) >= 1:
                break
            time.sleep(1.0)

        check("GET /api/rag/documents/search/?q=...",
              status == 200 and data.get("ok") is True,
              f"-> {status} {str(data)[:180]}")
        docs = data.get("documents") or []
        check("  -> dokumen uji ditemukan (cocok isi)",
              any(d.get("id") == manage_id for d in docs),
              f"total={data.get('total')}")
        check("  -> matchType diisi",
              all(d.get("matchType") in ("name", "content", "both") for d in docs),
              str([d.get("matchType") for d in docs][:5]))

        # Case-insensitive: huruf besar-kecil menghasilkan jumlah sama.
        status_lower, data_lower = get(
            "/api/rag/documents/search/?q=normalisasi", op
        )
        status_upper, data_upper = get(
            "/api/rag/documents/search/?q=NORMALISASI", op
        )
        check("  -> pencarian case-insensitive",
              status_lower == 200 and status_upper == 200
              and data_lower.get("total") == data_upper.get("total"),
              f"{data_lower.get('total')} vs {data_upper.get('total')}")

        # Kata kunci kosong ditolak (400 dari BFF, bukan 422 backend).
        status, data = get("/api/rag/documents/search/?q=", op)
        check("GET search menolak kata kunci kosong (400)",
              status == 400, f"-> {status}")

        # Hasil pencarian membawa fileUrl BFF, bukan URL FastAPI mentah.
        #
        # Yang diperiksa adalah dokumen yang **dokumen uji ini** — bukan
        # ``docs[0]``. Urutan hasil pencarian tidak dijamin, jadi
        # ``docs[0]`` bisa jadi dokumen lain milik akun service (dari
        # run verifikasi sebelumnya) yang tidak diuji di sini.
        own_doc = next(
            (d for d in docs if d.get("id") == manage_id),
            None,
        )
        if own_doc:
            check("  -> fileUrl diarahkan ke route BFF",
                  str(own_doc.get("fileUrl") or "").startswith(
                      f"/api/rag/documents/{manage_id}/file/"
                  ),
                  str(own_doc.get("fileUrl")))
        else:
            check("  -> dokumen uji muncul di hasil pencarian", False,
                  f"id {manage_id} tidak ada di {len(docs)} hasil")

        # --- status tugas --------------------------------------------
        # Pertanyaan status tugas harus dijawab dari tabel tugas
        # (kind == "task"), bukan dari vector store dokumen.
        status, data = post(
            "/api/rag/query/",
            {"question": "apakah ada tugas yang belum selesai?"},
            op,
        )
        check("POST /api/rag/query/ (status tugas)",
              status == 200 and data.get("ok") is True,
              f"-> {status} {str(data)[:180]}")
        check("  -> kind == 'task'",
              data.get("kind") == "task", str(data.get("kind")))
        check("  -> jawaban terisi",
              bool((data.get("answer") or "").strip()),
              repr((data.get("answer") or "")[:80]))

        # Pertanyaan dokumen biasa tetap lewat jalur dokumen.
        status, data = post(
            "/api/rag/query/",
            {"question": "apa yang dibahas dalam dokumen ini?", "n_results": 3},
            op,
        )
        check("POST /api/rag/query/ (pertanyaan dokumen)",
              status == 200 and data.get("ok") is True, f"-> {status}")
        check("  -> kind == 'document'",
              data.get("kind") == "document", str(data.get("kind")))

        # --- regresi: potongan dari fitur lain tidak boleh menggagalkan
        #     pencarian ------------------------------------------------
        #
        # Satu collection Chroma per akun dipakai bersama oleh beberapa
        # fitur. Dokumen perpustakaan (``source="library"``) dan segmen
        # transkrip (``source="transcript"``) menumpang di sana, dan
        # ``document_id``-nya menunjuk tabel yang **bukan**
        # ``rag_documents``. Kalau pencarian isi memproses id itu, ia
        # mencari baris dokumen yang tidak ada — dan seluruh pencarian
        # membalas 404, bukan daftar dokumen.
        #
        # Ini bukan kasus hipotetis: di akun service ada puluhan potongan
        # seperti itu, dan endpoint-nya memang balas 404.
        # Kata kunci diambil dari **isi** dokumen perpustakaan — itu yang
        # ikut ter-index ke vector store (metadata ``source="library"``).
        # Kalau hanya judulnya yang dicari, tidak ada chunk yang cocok dan
        # test-nya tidak membuktikan apa pun.
        library_kw = "regresi"
        status, data = post(
            "/api/document/save/",
            {
                "title": "Uji Regresi Perpustakaan",
                "type": "docx",
                "content": "paragraf regresi untuk menguji pencarian dokumen",
                "filePath": "uji-regresi-perpustakaan.docx",
            },
            op,
        )
        library_doc = (data or {}).get("document") or {}
        library_id = library_doc.get("id")
        check("POST /api/document/save/ (dokumen perpustakaan uji §22)",
              status in (200, 201) and data.get("ok") is True,
              f"-> {status} {str(data)[:180]}")

        if library_id:
            # Beri waktu backend meng-index ke vector store.
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                status, data = get(
                    f"/api/rag/documents/search/?q={library_kw}", op
                )
                if status == 200:
                    break
                time.sleep(1.0)

            check("GET search tetap 200 meski ada dokumen perpustakaan",
                  status == 200 and data.get("ok") is True,
                  f"-> {status} {str(data)[:180]}")
            check("  -> dokumen perpustakaan tidak muncul sebagai dokumen",
                  all(d.get("id") != library_id
                      for d in (data.get("documents") or [])),
                  str(library_id))
            check("  -> setiap hasil punya originalFileName",
                  all(d.get("originalFileName")
                      for d in (data.get("documents") or [])))

            # Bersihkan dokumen perpustakaan uji.
            status, data = post(
                f"/api/library/documents/{library_id}/delete/", {}, op
            )
            check("POST /api/library/documents/<id>/delete/ (bersihkan §22)",
                  status in (200, 204), f"-> {status}")
        else:
            check("  -> dokumen perpustakaan uji berhasil dibuat", False,
                  str(data)[:180])

        # --- bersihkan ------------------------------------------------
        status, data = post(
            f"/api/rag/documents/{manage_id}/delete/", {}, op
        )
        check("POST /api/rag/documents/<id>/delete/ (bersihkan §22)",
              status == 200 and data.get("ok") is True, f"-> {status}")

    print("\n=== 22b. RAG — daftar format dari backend ===")
    # Daftar format harus datang dari backend, bukan ditulis ulang di
    # Django maupun di JavaScript. Kalau ada salinan, salinan itu pasti
    # akan tertinggal — dan pengguna melihat "format tidak didukung" untuk
    # berkas yang sebenarnya bisa diindeks.
    status, data = get("/api/rag/formats/", op)
    check("GET /api/rag/formats/",
          status == 200 and data.get("ok") is True,
          f"-> {status} {str(data)[:180]}")

    formats = (data or {}).get("formats") or []
    check("  -> daftar format tidak kosong", bool(formats), str(formats)[:160])
    check("  -> format yang hanya bisa diproses backend ikut tercantum",
          ".tsv" in formats and ".yaml" in formats and ".py" in formats,
          str(formats)[:200])
    check("  -> format biner ikut tercantum",
          ".pdf" in formats and ".docx" in formats,
          str(formats)[:200])

    accept = (data or {}).get("accept") or ""
    parts = [p for p in accept.split(",") if p]
    check("  -> atribut accept memakai notasi titik",
          bool(parts) and all(p.startswith(".") for p in parts), accept[:160])
    check("  -> atribut accept tidak memuat ekstensi kosong",
          "" not in accept.split(","), accept[:160])

    max_bytes = (data or {}).get("maxFileBytes")
    check("  -> batas ukuran ikut diteruskan",
          isinstance(max_bytes, int) and max_bytes > 0, str(max_bytes))

    # Unggah format yang dulu ditolak UI tapi backend bisa proses.
    status, data = upload(
        "/api/rag/upload/", "verifikasi-rag-format.tsv",
        b"kolom1\tkolom2\nnormalisasi\tdatabase\n", {}, op,
    )
    check("POST /api/rag/upload/ (.tsv — dulu ditolak UI)",
          status in (200, 201) and data.get("ok") is True,
          f"-> {status} {str(data)[:180]}")
    tsv_doc = (data or {}).get("document") or {}
    tsv_id = tsv_doc.get("id")
    if tsv_id:
        status, data = post(f"/api/rag/documents/{tsv_id}/delete/", {}, op)
        check("POST /api/rag/documents/<id>/delete/ (bersihkan §22b)",
              status == 200 and data.get("ok") is True, f"-> {status}")

    # Format yang benar-benar tidak didukung harus ditolak di BFF dengan
    # pesan berbahasa pengguna, bukan diteruskan ke backend.
    status, data = upload(
        "/api/rag/upload/", "verifikasi-rag-gambar.png",
        b"bukan gambar", {}, op,
    )
    check("POST /api/rag/upload/ menolak format tak didukung",
          status == 400 and data.get("ok") is False,
          f"-> {status} {str(data)[:180]}")
    check("  -> pesan menyebut format yang sebenarnya didukung",
          ".tsv" in str(data.get("error", "")), str(data.get("error"))[:200])

    print("\n=== 23. Live transcription — potongan PCM (FR-05) ===")
    # Alur live: browser mengirim PCM mentah per potongan, worker
    # mentranskripsinya, dan transkrip parsial dibaca lewat /live/.
    #
    # Yang diuji di sini adalah **kontrak transport**-nya: body mentah
    # diterima, urutan potongan dijaga, dan /live/ melaporkan potongan
    # yang masuk. Isi transkripnya sendiri bergantung pada model
    # Whisper yang aktif, jadi tidak diassert di sini — yang dijaga
    # adalah bentuk responsnya.
    status, data = post(
        "/api/lecture/start/", {"title": "Verifikasi BFF — Live Chunk"}, op
    )
    live_session_id = (data or {}).get("session_id")
    check("POST /api/lecture/start/ (sesi live)", bool(live_session_id),
          f"-> {status} {str(data)[:160]}")

    if live_session_id:
        # PCM 16-bit mono 16 kHz: 4 detik = 128.000 byte.
        chunk_pcm = b"\x01\x02" * (4 * 16000)

        status, data = post_raw(
            f"/api/lecture/{live_session_id}/chunks/?seq=0&rate=16000",
            chunk_pcm,
            op,
        )
        check("POST /api/lecture/<id>/chunks/ menerima body PCM mentah",
              status == 200 and data.get("ok") is True, f"-> {status} {str(data)[:180]}")
        check("  -> byte potting dilaporkan",
              data.get("bytes") == len(chunk_pcm), str(data.get("bytes")))
        check("  -> durasi potongan dihitung",
              abs(float(data.get("duration_seconds") or 0) - 4.0) < 0.01,
              str(data.get("duration_seconds")))
        check("  -> ada task_id transkripsi", bool(data.get("task_id")),
              str(data.get("task_id")))

        # Potongan kedua harus diterima dengan nomor urut berbeda.
        status, data = post_raw(
            f"/api/lecture/{live_session_id}/chunks/?seq=1&rate=16000",
            chunk_pcm,
            op,
        )
        check("POST /api/lecture/<id>/chunks/ potongan kedua",
              status == 200 and data.get("ok") is True, f"-> {status}")

        status, data = get(f"/api/lecture/{live_session_id}/live/", op)
        check("GET /api/lecture/<id>/live/", status == 200 and data.get("ok") is True,
              f"-> {status} {str(data)[:180]}")
        check("  -> chunks_received = 2", data.get("chunks_received") == 2,
              str(data.get("chunks_received")))
        check("  -> chunks_expected = 2", data.get("chunks_expected") == 2,
              str(data.get("chunks_expected")))
        check("  -> seconds_captured ~ 8",
              abs(float(data.get("seconds_captured") or 0) - 8.0) < 0.5,
              str(data.get("seconds_captured")))
        check("  -> segments berupa list", isinstance(data.get("segments"), list),
              str(type(data.get("segments"))))

        # Body kosong harus ditolak, bukan diterima diam-diam.
        status, data = post_raw(
            f"/api/lecture/{live_session_id}/chunks/?seq=2&rate=16000",
            b"",
            op,
        )
        check("POST /api/lecture/<id>/chunks/ menolak body kosong",
              status == 400, f"-> {status}")

        # Rate di luar daftar yang diizinkan → 400. Offset absolut dihitung
        # dari rate, jadi rate ngawur membuat semua timestamp salah.
        status, data = post_raw(
            f"/api/lecture/{live_session_id}/chunks/?seq=2&rate=12345",
            chunk_pcm,
            op,
        )
        check("POST /api/lecture/<id>/chunks/ menolak rate tidak didukung",
              status == 400, f"-> {status}")

        # Id sesi dengan karakter path harus ditolak di lapisan BFF.
        status, data = post_raw(
            "/api/lecture/..%2F..%2Fetc/chunks/?seq=0&rate=16000",
            chunk_pcm,
            op,
        )
        check("POST /api/lecture/<id>/chunks/ menolak id sesi berbahaya",
              status in (400, 404), f"-> {status}")

        # Bersihkan: hapus sesi harus ikut menghapus berkas potongannya.
        status, data = post(f"/api/lecture/{live_session_id}/stop/", {}, op)
        check("POST /api/lecture/<id>/stop/ mode live",
              status == 200 and data.get("ok") is True
              and (data.get("mode") in ("live", "upload", "empty")),
              f"-> {status} mode={data.get('mode')}")

        status, data = delete(f"/api/lecture/{live_session_id}/delete/", op)
        check("DELETE /api/lecture/<id>/delete/ membersihkan sesi live",
              status == 200 and data.get("ok") is True, f"-> {status}")
    else:
        check("POST /api/lecture/start/ mengembalikan session_id (live)",
              False, str(data)[:180])

    print("\n=== 24. Job laporan mingguan (FR-12) ===")

    status, data = get("/api/lecturer/reports/jobs/", op)
    check("GET /api/lecturer/reports/jobs/", status == 200 and data.get("ok") is True,
          f"-> {status} {str(data)[:160]}")
    check("  -> jobs berupa list", isinstance(data.get("jobs"), list),
          str(type(data.get("jobs"))))

    report_jobs = data.get("jobs") or []

    if report_jobs:
        first = report_jobs[0] if isinstance(report_jobs[0], dict) else {}
        job_id = first.get("id")

        check("  -> job punya id", bool(job_id), str(first)[:160])
        check("  -> job punya status",
              first.get("status") in ("queued", "processing", "done", "failed"),
              str(first.get("status")))

        status, data = get(f"/api/lecturer/reports/jobs/{job_id}/", op)
        check("GET /api/lecturer/reports/jobs/<job_id>/",
              status == 200 and data.get("ok") is True, f"-> {status} {str(data)[:160]}")
        check("  -> job dikembalikan utuh",
              (data.get("job") or {}).get("id") == job_id,
              str((data.get("job") or {}).get("id")))

        status, data = get("/api/lecturer/reports/jobs/job-asing-xyz/", op)
        check("GET /api/lecturer/reports/jobs/<job_id>/ 404 untuk job asing",
              status == 404, f"-> {status}")
    else:
        check("  -> ada minimal satu job laporan", False,
              "belum pernah generate laporan — jalankan generate manual dulu")

    # Id job yang tidak valid harus ditolak di lapisan BFF, bukan diteruskan
    # ke backend.
    status, data = get("/api/lecturer/reports/jobs/buruk%20id!!/", op)
    check("GET /api/lecturer/reports/jobs/<job_id>/ menolak id tidak valid",
          status in (400, 404), f"-> {status}")

    print("\n=== 25. Video ajar + filter + unduh laporan (FR-13/FR-14) ===")

    # Filter per mata kuliah harus diteruskan ke backend, bukan diabaikan.
    status, data = get("/api/lecturer/videos/?course_id=mk-tidak-ada", op)
    check("GET /api/lecturer/videos/?course_id= (filter diteruskan)",
          status == 200 and data.get("ok") is True, f"-> {status} {str(data)[:160]}")
    check("  -> hasil filter berupa list", isinstance(data.get("videos"), list),
          str(type(data.get("videos"))))
    check("  -> filter MK asing tidak error 500", status != 500, f"-> {status}")

    status, data = get("/api/lecturer/videos/", op)
    check("GET /api/lecturer/videos/ tanpa filter tetap jalan",
          status == 200 and data.get("ok") is True, f"-> {status}")

    # Gaya video yang tidak dikenal harus ditolak dengan 422 — bukan
    # diam-diam dipetakan ke default, supaya user tahu pilihannya tidak
    # berlaku.
    status, data = post(
        "/api/lecturer/videos/generate/",
        {"material": "Uji kontrak validasi gaya", "video_style": "gaya-aneh"},
        op,
    )
    check("POST /api/lecturer/videos/generate/ menolak video_style tak dikenal",
          status == 422, f"-> {status} {str(data)[:160]}")

    # Laporan yang ada → tombol unduh harus melayani file .docx.
    status, data = get("/api/lecturer/reports/", op)
    reports = data.get("reports") or [] if status == 200 else []
    if reports:
        report_id = reports[0].get("id")
        status, blob, headers = fetch(f"/api/lecturer/reports/{report_id}/export/", op)
        check("GET /api/lecturer/reports/<id>/export/ menyajikan .docx",
              status == 200, f"-> {status}")
        check("  -> file bukan JSON (bukan error)",
              not blob.lstrip()[:1] == b"{", blob[:80])
        check("  -> content-type docx",
              "wordprocessingml" in (headers.get("Content-Type") or "")
              or "application/octet-stream" in (headers.get("Content-Type") or ""),
              headers.get("Content-Type", ""))
    else:
        check("  -> ada laporan untuk diunduh", False,
              "belum ada laporan mingguan di akun ini")

    # --- Range pada file video -----------------------------------------
    # Tanpa Range, `<video preload="metadata">` menarik SELURUH berkas
    # (bisa puluhan MB) sebelum halaman selesai memuat. Endpoint BFF
    # harus meneruskan Range dan menjawab 206 Partial Content — sama
    # seperti endpoint rekaman audio.
    status, data = get("/api/lecturer/videos/", op)
    videos = data.get("videos") or [] if status == 200 else []
    done = [v for v in videos if v.get("status") == "done" and v.get("video_url")]

    if done:
        video_id = done[0].get("id")
        status, blob, headers = fetch(
            f"/api/lecturer/videos/{video_id}/file/", op, {"Range": "bytes=0-1023"}
        )
        check("GET video bytes=0-1023 menjawab 206 Partial Content",
              status == 206, f"-> {status}")
        check("  -> hanya 1 KB yang dikirim",
              len(blob) == 1024, f"-> {len(blob)} byte")
        check("  -> ada header Content-Range",
              "content-range" in {k.lower() for k in headers},
              str(sorted(headers))[:120])
        check("  -> header Accept-Ranges: bytes",
              (headers.get("Accept-Ranges") or headers.get("accept-ranges")) == "bytes",
              headers.get("Accept-Ranges", headers.get("accept-ranges", "")))
    else:
        check("  -> ada video selesai untuk uji Range", False,
              "belum ada video ajar selesai di akun ini")

    print(f"\n{'=' * 52}")
    print(f"  PASS: {ok}    FAIL: {fail}")
    if failures:
        print("\n  Gagal:")
        for f in failures:
            print(f"   - {f}")
    print(f"{'=' * 52}\n")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
