"""Endpoint JSON untuk profil pengguna — identitas dari backend FastAPI.

Alur:

    browser ──GET   /api/profile/─▶ Django ──▶ FastAPI GET   /auth/me
    browser ──PATCH /api/profile/─▶ Django ──▶ FastAPI PATCH /auth/me

Sidebar dan topbar menampilkan nama, NIM, dan kampus sebagai data statis di
template. Endpoint ini menggantinya dengan data akun yang benar-benar
dipakai backend, sehingga tidak ada lagi identitas fiktif di layar.

Backend ``/auth/me`` tidak punya field NIM, jadi angka NIM di UI dihapus
begitu saja — lebih baik kosong daripada menampilkan angka palsu.

PATCH dipakai supaya mahasiswa bisa mengoreksi nama / semester / jurusan
sendiri lewat UI, alih-alih memakai akun service bersama.
"""
from __future__ import annotations

import logging

from django.http import JsonResponse
from django.views.decorators.http import require_http_methods

from . import backend_api
from .backend_api import ApiError
from .views_api import _error, _json_body, same_origin_json

logger = logging.getLogger(__name__)

# Field profil yang boleh diubah lewat PATCH. Sama dengan ``UserUpdate`` di
# backend (app/schemas/auth.py).
PROFILE_FIELDS = ("name", "email", "semester", "major", "avatar")

# Batas panjang per field — sama dengan schema backend, supaya penolakan
# terjadi di sisi yang sama dengan pesan yang konsisten.
PROFILE_LIMITS = {
    "name": (2, 255),
    "email": (3, 254),
    "semester": (0, 50),
    "major": (0, 100),
    "avatar": (0, 500),
}


def _profile_payload(user: dict) -> dict:
    """Ambil subset field profil dari respons ``/auth/me``."""
    return {
        "name": user.get("name") or "",
        "email": user.get("email") or "",
        "semester": user.get("semester") or "",
        "major": user.get("major") or "",
        "avatar": user.get("avatar") or "",
    }


@require_http_methods(["GET", "PATCH"])
@same_origin_json
def profile(request):
    """Profil akun (GET) atau ubah profil (PATCH).

    GET juga mengembalikan daftar mata kuliah, dipakai sidebar & topbar.
    PATCH meneruskan field yang diubah ke backend lewat ``PATCH /auth/me``.
    """
    if request.method == "PATCH":
        return _patch_profile(request)

    try:
        user = backend_api.request("GET", "/auth/me")
    except ApiError as exc:
        logger.warning("ambil profil gagal: %s", exc)
        return _error(exc)

    user = user if isinstance(user, dict) else {}

    courses = user.get("courses")
    courses = courses if isinstance(courses, list) else []

    return JsonResponse(
        {
            "ok": True,
            "profile": _profile_payload(user),
            "courses": courses,
        }
    )


def _patch_profile(request) -> JsonResponse:
    """Ubah profil akun di backend."""
    data = _json_body(request)

    payload: dict = {}

    for field in PROFILE_FIELDS:
        if field not in data:
            continue

        value = data[field]

        # null berarti "kosongkan field ini" — backend menerimanya.
        if value is None:
            payload[field] = None
            continue

        text = str(value).strip()
        minimum, maximum = PROFILE_LIMITS[field]

        if len(text) < minimum:
            return JsonResponse(
                {"ok": False, "error": f"{field} minimal {minimum} karakter."},
                status=400,
            )

        if len(text) > maximum:
            return JsonResponse(
                {"ok": False, "error": f"{field} maksimal {maximum} karakter."},
                status=400,
            )

        payload[field] = text

    if not payload:
        return JsonResponse(
            {"ok": False, "error": "Tidak ada field profil yang diperbarui."},
            status=400,
        )

    try:
        user = backend_api.request("PATCH", "/auth/me", json=payload)
    except ApiError as exc:
        logger.warning("ubah profil gagal: %s", exc)
        return _error(exc)

    user = user if isinstance(user, dict) else {}

    return JsonResponse({"ok": True, "profile": _profile_payload(user)})
