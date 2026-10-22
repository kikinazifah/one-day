"""Klien HTTP dari dashboard Django ke backend FastAPI (student-assistant).

Pola mengikuti ``student-assistant/web-django/portal/api.py``: Django yang
memegang JWT, browser tidak pernah melihat token.

Berbeda dari portal web-django (yang login sebagai user sungguhan), dashboard
ini belum punya halaman login sendiri, jadi kredensial service dipakai dari
environment dan token di-cache di memori proses:

    AKADEMIA_API_URL     default http://127.0.0.1:8022/api/v1
    AKADEMIA_API_EMAIL   akun service
    AKADEMIA_API_PASSWORD

Halaman Django tetap memakai proteksi CSRF standar; endpoint JSON di
``dashboard/views_api.py`` **tidak** — endpoint itu ``csrf_exempt`` dan
diproteksi lewat pemeriksaan ``Origin``/``Referer`` (lihat
``views_api.same_origin_json``). Header ``X-CSRFToken`` yang dikirim
``static/dashboard/api.js`` tidak divalidasi di server.
"""
from __future__ import annotations

import json as json_module
import logging
import os
import threading
import time
from typing import Iterator, NamedTuple

import httpx
from django.conf import settings

logger = logging.getLogger(__name__)

# Timeout per jenis pekerjaan (detik).
TIMEOUT_DEFAULT = 30.0
TIMEOUT_GENERATE = 360.0  # generate dokumen: LLM + render OfficeCLI
TIMEOUT_DOWNLOAD = 360.0
TIMEOUT_UPLOAD_AUDIO = 300.0  # unggah rekaman: transfer + Whisper di CPU
TIMEOUT_LLM = 180.0  # chat AI Dosen: LLM + (opsional) konteks RAG
# Potongan audio live: potongannya kecil (128 KB), jadi timeout-nya cukup
# pendek. Timeout panjang hanya menambah jeda saat pengguna menekan
# "Hentikan Rekaman".
TIMEOUT_CHUNK = 60.0
# Chat dokumen: satu giliran bisa melibatkan beberapa putaran LLM plus
# penyimpanan dokumen, jadi timeoutnya sama dengan generate.
TIMEOUT_CHAT = 360.0

# Access token FastAPI berumur 30 menit (ACCESS_TOKEN_EXPIRE_MINUTES di .env).
# Perbarui 60 detik lebih awal supaya tidak ada request yang memakai token
# yang kedaluwarsa di tengah jalan.
TOKEN_TTL = 29 * 60


class ApiError(Exception):
    """Error dari FastAPI, atau backend yang tidak terjangkau."""

    def __init__(self, status: int, detail: str):
        self.status = status
        self.detail = detail
        super().__init__(f"{status}: {detail}")


def error_text(detail) -> str:
    """Rapikan ``detail`` FastAPI: string, atau list validasi 422."""
    if isinstance(detail, list):
        parts = []
        for item in detail:
            if isinstance(item, dict):
                loc = ".".join(str(x) for x in item.get("loc", []))
                msg = item.get("msg", "")
                parts.append(f"{loc}: {msg}" if loc else str(msg))
            else:
                parts.append(str(item))
        return "; ".join(parts) or "Data tidak valid"
    if isinstance(detail, dict):
        return str(detail.get("message") or detail)
    return str(detail)


class _TokenCache:
    """Access token service + waktu kedaluwarsanya, aman untuk multi-thread."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._token: str | None = None
        self._expires_at: float = 0.0

    def get(self) -> str | None:
        with self._lock:
            if self._token and time.monotonic() < self._expires_at:
                return self._token
        return None

    def set(self, token: str) -> None:
        with self._lock:
            self._token = token
            self._expires_at = time.monotonic() + TOKEN_TTL

    def clear(self) -> None:
        with self._lock:
            self._token = None
            self._expires_at = 0.0


_tokens = _TokenCache()


class _SharedClient:
    """Satu ``httpx.Client`` untuk seluruh proses Django.

    Kenapa client harus dipakai ulang: ``httpx.request(...)`` adalah API
    top-level yang **membuat** ``httpx.Client`` baru untuk setiap
    pemanggilan. Membuat client memuat ulang CA bundle certifi (sekitar
    290 KB) dan Windows cert store — di mesin ini sekitar **300–550 ms**
    per panggilan:

        httpx.Client() construct:  552 ms
        client yang dipakai ulang:  1–5 ms per request

    Karena ``/api/dashboard/summary/`` memanggil backend tiga kali
    (``/tasks``, ``/schedule/``, ``/courses/``), versi lama memakan 1,2 s
    hanya untuk membangun koneksi TLS — request-nya sendiri cuma milidetik.

    Thread-safety: dokumentasi httpx menyatakan client "can be shared
    between threads", dan itu diverifikasi di sini untuk jalur upload
    juga — 24 POST multipart paralel lewat client yang sama, semuanya
    200. Setiap request Django punya fileobj-nya sendiri, jadi tidak ada
    yang berebut posisi reader.

    Catatan operasional: client ini hidup selama proses Django, jadi
    SSL context-nya ikut hidup. Kalau CA bundle sistem berubah, proses
    Django perlu di-restart supaya context barunya dipakai.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._client: httpx.Client | None = None

    def get(self) -> httpx.Client:
        with self._lock:
            if self._client is None:
                self._client = httpx.Client(
                    follow_redirects=True,
                    limits=httpx.Limits(
                        max_connections=20,
                        max_keepalive_connections=10,
                    ),
                )
            return self._client

    def close(self) -> None:
        with self._lock:
            if self._client is not None:
                self._client.close()
                self._client = None


_shared = _SharedClient()


def _client() -> httpx.Client:
    """Client HTTP yang dipakai ulang (lihat ``_SharedClient``)."""
    return _shared.get()


def base_url() -> str:
    """Base URL API backend, including the ``/api/v1`` prefix.

    Read through ``django.conf.settings`` so the value picked up from the
    project's ``.env`` file (loaded by the settings module) is used too —
    ``os.environ`` alone would miss it.
    """
    url = getattr(settings, "AKADEMIA_API_URL", "") or os.environ.get(
        "AKADEMIA_API_URL", ""
    )
    if not url:
        url = "http://127.0.0.1:8022/api/v1"
    return url.rstrip("/")


def origin_url() -> str:
    """Origin backend TANPA prefix ``/api/v1``.

    Sebagian aset backend (mis. file video ajar ``/videos/<id>.mp4``) dilayani
    dari root site, bukan dari router API. Jadi untuk aset seperti itu kita
    perlu origin saja — prefix ``/api/v1`` dibuang dari ``base_url()``.
    """
    url = base_url()
    if url.endswith("/api/v1"):
        url = url[: -len("/api/v1")]
    return url.rstrip("/")


def _service_credentials() -> tuple[str, str]:
    """Email & password of the backend service account."""
    email = getattr(settings, "AKADEMIA_API_EMAIL", "") or os.environ.get(
        "AKADEMIA_API_EMAIL", ""
    )
    password = getattr(settings, "AKADEMIA_API_PASSWORD", "") or os.environ.get(
        "AKADEMIA_API_PASSWORD", ""
    )
    return email, password


def _login() -> str:
    """Login akun service dan simpan token. Raise ApiError kalau gagal."""
    email, password = _service_credentials()
    if not email or not password:
        raise ApiError(
            503,
            "Akun service backend belum dikonfigurasi "
            "(set AKADEMIA_API_EMAIL dan AKADEMIA_API_PASSWORD).",
        )

    try:
        resp = _client().post(
            f"{base_url()}/auth/login",
            json={"email": email, "password": password},
            timeout=TIMEOUT_DEFAULT,
        )
    except httpx.HTTPError as exc:
        # Backend mungkin sedang restart; coba sekali lagi sebelum gagal.
        logger.warning("login ke backend gagal: %s, mencoba lagi", exc)
        time.sleep(1.5)
        try:
            resp = _client().post(
                f"{base_url()}/auth/login",
                json={"email": email, "password": password},
                timeout=TIMEOUT_DEFAULT,
            )
        except httpx.HTTPError as exc:
            raise ApiError(503, f"Backend tidak terjangkau: {exc}") from exc

    if resp.status_code != 200:
        try:
            detail = resp.json().get("detail", resp.text[:200])
        except ValueError:
            detail = resp.text[:200]
        raise ApiError(resp.status_code, error_text(detail))

    token = resp.json()["access_token"]
    _tokens.set(token)
    logger.info("login service backend berhasil (%s)", email)
    return token


def _auth_header(force: bool = False) -> dict:
    token = None if force else _tokens.get()
    if token is None:
        token = _login()
    return {"Authorization": f"Bearer {token}"}


def _rewind_files(files: dict | None) -> None:
    """Kembalikan pointer file ke awal supaya payload multipart bisa diulang.

    Retry (401 atau koneksi terputus) mengirim ulang body yang sama, jadi
    stream file harus di-rewind dulu — kalau tidak, retry mengirim file
    kosong karena pointer sudah di akhir.
    """
    if not files:
        return

    for value in files.values():
        # Nilai bisa berupa (filename, fileobj, content_type) atau fileobj.
        fileobj = value[1] if isinstance(value, (tuple, list)) and len(value) > 1 else value
        seek = getattr(fileobj, "seek", None)
        if callable(seek):
            try:
                seek(0)
            except (OSError, ValueError):
                pass


def request(
    method: str,
    path: str,
    *,
    json=None,
    params: dict | None = None,
    data: dict | None = None,
    files: dict | None = None,
    content: bytes | None = None,
    headers: dict | None = None,
    timeout: float = TIMEOUT_DEFAULT,
    _retried: bool = False,
):
    """Panggil backend dengan token service.

    Dua jenis retry:

    * 401 → token kedaluwarsa/dicabut; ambil yang baru lalu coba lagi.
    * koneksi terputus (backend restart, socket ditutup) → coba lagi dengan
      jeda pendek. Generate dokumen memang lambat (LLM + render), jadi
      backend sering sedang restart saat development.

    Parameter ``data``/``files`` opsional: kalau ``files`` diisi, body
    dikirim sebagai multipart/form-data (``data`` jadi field biasa di
    dalamnya). Tanpa ``files``, perilaku sama seperti sebelumnya: JSON.

    ``content`` mengirim body mentah apa adanya (mis. potongan PCM).
    Berbeda dengan ``files``, byte mentah bisa dikirim ulang tanpa
    rewinding — jadi retry-nya tetap aman.
    """
    url = f"{base_url()}{path}"
    try:
        resp = _client().request(
            method, url, json=json, params=params, data=data, files=files,
            content=content,
            headers={**_auth_header(), **(headers or {})},
            timeout=timeout,
        )
    except httpx.HTTPError as exc:
        if _retried:
            raise ApiError(503, f"Backend tidak terjangkau: {exc}") from exc
        logger.warning("koneksi ke backend terputus (%s), mencoba lagi", exc)
        time.sleep(1.5)
        _rewind_files(files)
        return request(
            method, path, json=json, params=params, data=data, files=files,
            content=content, headers=headers,
            timeout=timeout, _retried=True,
        )

    if resp.status_code == 401 and not _retried:
        # Token kedaluwarsa/dicabut: ambil yang baru, coba sekali lagi.
        _tokens.clear()
        _rewind_files(files)
        return request(
            method, path, json=json, params=params, data=data, files=files,
            content=content, headers=headers,
            timeout=timeout, _retried=True,
        )

    if resp.status_code >= 400:
        try:
            payload = resp.json()
        except ValueError:
            payload = resp.text[:300]
        if isinstance(payload, dict) and "detail" in payload:
            payload = payload["detail"]
        raise ApiError(resp.status_code, error_text(payload))

    if resp.status_code == 204 or not resp.content:
        return {}
    try:
        return resp.json()
    except ValueError:
        return {}


class DownloadedFile(NamedTuple):
    """Hasil unduhan berkas dari backend.

    ``status`` dan ``headers`` ikut dikembalikan supaya Intermediate
    Response bisa meneruskan ``206 Partial Content`` dan ``Content-Range``
    apa adanya. Tanpa itu, pemutar audio di browser mengira berkas utuh
    yang dikirim, dan seeking di dalam rekaman tidak bisa dilakukan.
    """

    content: bytes
    content_type: str
    disposition: str | None
    status: int = 200
    headers: dict = {}


class StreamedFile(NamedTuple):
    """Berkas besar yang **dialirkan**, bukan dibUFFER di memori.

    Bedanya dengan :class:`DownloadedFile` sangat penting untuk berkas
    video: video ajar berukuran 39 MB. Kalau BFF membacanya seluruhnya ke
    memori dulu (setelah :func:`download`), maka:

    * **1 video = 39 MB di memori** — dan halaman AI Lecturer memuat
      23 video, jadi **900 MB** terkunci di proses Django;
    * koneksi browser ke BFF **tidak pernah selesai** — server sudah
      kirim seluruh body tapi connection-nya ditahan. Akibatnya
      ``waitUntil: "networkidle"`` di browser test tidak pernah tercapai
      (terbukti: 23 video lewat BFF -> timeout; 23 video langsung ke
      backend -> **548 ms**).

    Yang benar: BFF meneruskan byte **sambil** meneruskannya ke browser
    (chunk demi chunk), lalu menutup koneksi begitu berkas habis.
    """

    status: int
    content_type: str
    headers: dict
    chunks: Iterator[bytes]


def download_stream(
    path: str,
    *,
    origin: bool = False,
    headers: dict | None = None,
    timeout: float = TIMEOUT_DOWNLOAD,
) -> StreamedFile:
    """Ambil berkas dari backend **tanpa** membacanya seluruhnya ke memori.

    Mengembalikan objek :class:`StreamedFile` yang isinya iterator byte.
    Response HTTP ke browser harus dibangun dari iterator itu (lihat
    ``StreamingHttpResponse``) — kalau tidak, seluruh berkas tetap
    terkumpul di memori.

    Header ``Range`` diteruskan apa adanya, jadi ``206 Partial Content``
    dan ``Content-Range`` dari backend ikut sampai ke browser. Tanpa itu,
    pemutar video mengira berkas utuh yang dikirim dan seek di dalam
    video rusak.
    """
    root = origin_url() if origin else base_url()
    url = f"{root}{path}"

    client = _client()
    try:
        context = client.stream(
            "GET", url, headers={**_auth_header(), **(headers or {})}, timeout=timeout
        )
        response = context.__enter__()
    except httpx.HTTPError as exc:
        raise ApiError(503, f"Backend tidak terjangkau: {exc}") from exc

    if response.status_code >= 400:
        raw = response.read()
        context.__exit__(None, None, None)
        try:
            payload = json_module.loads(raw)
        except ValueError:
            payload = raw[:300]
        if isinstance(payload, dict) and "detail" in payload:
            payload = payload["detail"]
        raise ApiError(response.status_code, error_text(payload))

    def iter_chunks() -> Iterator[bytes]:
        try:
            for chunk in response.iter_bytes():
                if chunk:
                    yield chunk
        finally:
            # Menutup koneksi ke backend saat browser selesai (atau
            # memutuskan pergi). Tanpa ini, koneksi httpx menganggur
            # sampai timeout.
            context.__exit__(None, None, None)

    return StreamedFile(
        status=response.status_code,
        content_type=response.headers.get(
            "content-type", "application/octet-stream"
        ),
        headers={
            key: value
            for key, value in response.headers.items()
            if key.lower() in ("content-range", "accept-ranges", "content-length")
        },
        chunks=iter_chunks(),
    )


def stream(
    method: str,
    path: str,
    *,
    json=None,
    timeout: float = TIMEOUT_CHAT,
) -> Iterator[bytes]:
    """Panggil backend dan kembalikan isi stream-nya apa adanya.

    Dipakai untuk Server-Sent Events: chat dokumen mengirim event
    (``text``, ``tool_start``, ``document``, ``done``) sambil permintaannya
    masih berjalan, dan browser harus menerimanya **satu per satu**. Jadi
    respons tidak boleh dibaca seluruhnya di awal — itu akan mengembalikan
    chat ke bentuk "form dengan langkah tambahan".

    Errornya dilempar sebagai :class:`ApiError` seperti pada
    :func:`request`, supaya pemanggil bisa menampilkan pesannya. Event
    ``data:`` apa adanya diteruskan, tanpa diurai: formatnya adalah
    kontrak antara backend dan browser.
    """
    url = f"{base_url()}{path}"
    try:
        with _client().stream(
            method,
            url,
            json=json,
            headers={**_auth_header()},
            timeout=timeout,
        ) as response:
            if response.status_code >= 400:
                # The body is still unread, so it has to be read explicitly
                # before the error can be reported.
                raw = response.read()
                try:
                    payload = json_module.loads(raw)
                except ValueError:
                    payload = raw[:300]
                if isinstance(payload, dict) and "detail" in payload:
                    payload = payload["detail"]
                raise ApiError(response.status_code, error_text(payload))

            for chunk in response.iter_bytes():
                if chunk:
                    yield chunk
    except ApiError:
        raise
    except httpx.HTTPError as exc:
        raise ApiError(503, f"Backend tidak terjangkau: {exc}") from exc


def download(
    path: str,
    params: dict | None = None,
    *,
    origin: bool = False,
    headers: dict | None = None,
) -> DownloadedFile:
    """Ambil file penuh dari backend.

    Retry sekali saat koneksi terputus atau token ditolak.

    ``origin=True`` membangun URL dari origin backend (tanpa prefix
    ``/api/v1``) — dipakai untuk aset yang dilayani dari root site, misalnya
    file video ajar di ``/videos/<id>.mp4``.

    ``headers`` dipakai untuk meneruskan header dari browser, mis. ``Range``
    supaya pemutar audio bisa mencari posisi dalam rekaman panjang.
    """
    root = origin_url() if origin else base_url()
    url = f"{root}{path}"
    last_error: Exception | None = None

    for attempt in range(2):
        try:
            resp = _client().get(
                url, params=params, headers={**_auth_header(), **(headers or {})},
                timeout=TIMEOUT_DOWNLOAD,
            )
            if resp.status_code == 401:
                resp = _client().get(
                    url, params=params,
                    headers={**_auth_header(force=True), **(headers or {})},
                    timeout=TIMEOUT_DOWNLOAD,
                )
        except httpx.HTTPError as exc:
            last_error = exc
            logger.warning("unduhan gagal: %s, mencoba lagi", exc)
            time.sleep(1.5)
            continue

        if resp.status_code >= 400:
            raise ApiError(resp.status_code, f"HTTP {resp.status_code}")

        return DownloadedFile(
            content=resp.content,
            content_type=resp.headers.get("content-type", "application/octet-stream"),
            disposition=resp.headers.get("content-disposition"),
            status=resp.status_code,
            headers={
                key: value
                for key, value in resp.headers.items()
                if key.lower() in ("content-range", "accept-ranges", "content-length")
            },
        )

    raise ApiError(503, f"Backend tidak terjangkau: {last_error}")
