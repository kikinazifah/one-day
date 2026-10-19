"""Klien HTTP dari dashboard Django ke backend FastAPI (student-assistant).

Pola mengikuti ``student-assistant/web-django/portal/api.py``: Django yang
memegang JWT, browser tidak pernah melihat token.

Berbeda dari portal web-django (yang login sebagai user sungguhan), dashboard
ini belum punya halaman login sendiri, jadi kredensial service dipakai dari
environment dan token di-cache di memori proses:

    AKADEMIA_API_URL     default http://127.0.0.1:8002/api/v1
    AKADEMIA_API_EMAIL   akun service
    AKADEMIA_API_PASSWORD

Halaman Django tetap memakai proteksi CSRF standar; endpoint JSON di
``dashboard/views_api.py`` wajib dikirim dengan header ``X-CSRFToken``.
"""
from __future__ import annotations

import logging
import os
import threading
import time

import httpx

logger = logging.getLogger(__name__)

# Timeout per jenis pekerjaan (detik).
TIMEOUT_DEFAULT = 30.0
TIMEOUT_GENERATE = 360.0  # generate dokumen: LLM + render OfficeCLI
TIMEOUT_DOWNLOAD = 360.0

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


def base_url() -> str:
    return os.environ.get("AKADEMIA_API_URL", "http://127.0.0.1:8002/api/v1").rstrip("/")


def _login() -> str:
    """Login akun service dan simpan token. Raise ApiError kalau gagal."""
    email = os.environ.get("AKADEMIA_API_EMAIL", "")
    password = os.environ.get("AKADEMIA_API_PASSWORD", "")
    if not email or not password:
        raise ApiError(
            503,
            "Akun service backend belum dikonfigurasi "
            "(set AKADEMIA_API_EMAIL dan AKADEMIA_API_PASSWORD).",
        )

    try:
        resp = httpx.post(
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


def request(
    method: str,
    path: str,
    *,
    json=None,
    params: dict | None = None,
    timeout: float = TIMEOUT_DEFAULT,
    _retried: bool = False,
):
    """Panggil backend dengan token service; retry sekali saat 401."""
    url = f"{base_url()}{path}"
    try:
        resp = httpx.request(
            method, url, json=json, params=params,
            headers=_auth_header(), timeout=timeout,
        )
    except httpx.HTTPError as exc:
        raise ApiError(503, f"Backend tidak terjangkau: {exc}") from exc

    if resp.status_code == 401 and not _retried:
        # Token kedaluwarsa/dicabut: ambil yang baru, coba sekali lagi.
        _tokens.clear()
        return request(
            method, path, json=json, params=params, timeout=timeout, _retried=True,
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


def download(path: str, params: dict | None = None) -> tuple[bytes, str, str | None]:
    """Ambil file penuh → (content, content_type, content_disposition)."""
    url = f"{base_url()}{path}"
    try:
        resp = httpx.get(
            url, params=params, headers=_auth_header(), timeout=TIMEOUT_DOWNLOAD,
        )
        if resp.status_code == 401:
            resp = httpx.get(
                url, params=params, headers=_auth_header(force=True),
                timeout=TIMEOUT_DOWNLOAD,
            )
    except httpx.HTTPError as exc:
        raise ApiError(503, f"Backend tidak terjangkau: {exc}") from exc

    if resp.status_code >= 400:
        raise ApiError(resp.status_code, f"HTTP {resp.status_code}")
    return (
        resp.content,
        resp.headers.get("content-type", "application/octet-stream"),
        resp.headers.get("content-disposition"),
    )
