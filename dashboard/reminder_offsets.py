"""Tata bahasa offset pengingat - satu-satunya sumber kebenaran di sisi BFF.

``reminder_time`` yang dikirim ke backend adalah *offset* relatif terhadap
tenggat tugas, bukan cap waktu absolut: ``3_hours`` berarti "3 jam
sebelum tenggat". Offset ikut bergerak kalau tenggat digeser, jadi
penjadwalan selalu dihitung ulang di backend.

Bentuknya::

    <jumlah>_<satuan>

dengan satuan ``minute(s)``, ``hour(s)``, ``day(s)``, ``week(s)``. Satuan
jam dan menit diizinkan karena spesifikasi menyebut pengingat "3 jam
sebelum". Satuan bulan dan tahun **tidak** diizinkan: bulan bukan durasi
tetap, jadi penjadwal tidak bisa menghitungnya dengan benar.

**Kenapa ada salinan di sini.** Backend (``student-assistant``) punya
modul yang sama: ``app/core/reminder_offsets.py``. Dua repo terpisah
tidak bisa mengimpor modul satu sama lain tanpa paket bersama, jadi
salinan ini inevitable. Yang membuatnya aman adalah dua hal:

* tata bahasa di sini **sempit** - hanya nilai yang diizinkan BFF, dan
  backend memvalidasi ulang dengan aturannya sendiri;
* ``verify_bff.py`` membandingkan daftar preset di sini dengan yang
  diadvertorkan backend lewat ``GET /reminders/offsets`` dan gagal kalau
  berbeda. Jadi kalau satu sisi ditambah dan sisi lain lupa, selisihnya
  ketahuan saat verifikasi - bukan saat ada tugas yang diam-diam gagal
  dijadwalkan.

Satuan "custom" dari enum lama backend **tidak** diterima: itu bukan
durasi, jadi tidak ada yang bisa dihitung. Field custom di UI dikirim
sebagai durasi yang konkret (``5_hours``, ``45_minutes``).
"""
from __future__ import annotations

import re
from typing import Optional

__all__ = [
    "MAX_OFFSET_DAYS",
    "MAX_OFFSET_MINUTES",
    "OFFSET_UNITS",
    "REMINDER_PRESETS",
    "describe_offset",
    "is_valid_offset",
    "normalize_offset",
    "preset_options",
]


# Bentuk kanonik: angka positif + satuan.
#
# Panjang digit **tidak** dibatasi. Batas yang sesungguhnya adalah durasi
# (365 hari), dan durasi itu berbeda jauh antar satuan: 365 menit cuma
# 6 jam, sedangkan 365 minggu hampir 7 tahun. Membatasi panjang digit
# secara seragam berarti nilai yang sah untuk satuan kasar
# ("525600_minutes" = 365 hari) ikut ditolak — dan pesannya menyesatkan.
#
# Aturan ini harus sama persis dengan backend
# (``app/core/reminder_offsets.py``).
_OFFSET_RE = re.compile(r"^(?P<count>\d+)_([a-z]+)$")

# Durasi per satuan (menit). Hanya satuan tetap.
_UNIT_MINUTES = {
    "minute": 1,
    "minutes": 1,
    "hour": 60,
    "hours": 60,
    "day": 24 * 60,
    "days": 24 * 60,
    "week": 7 * 24 * 60,
    "weeks": 7 * 24 * 60,
}

# Bentuk kanonik per satuan: (tunggal, jamak). Jumlah 1 selalu tunggal,
# jadi "1_hours" dan "1_hour" berakhir sebagai nilai yang sama.
_CANONICAL_UNIT = {
    "minute": ("minute", "minutes"),
    "minutes": ("minute", "minutes"),
    "hour": ("hour", "hours"),
    "hours": ("hour", "hours"),
    "day": ("day", "days"),
    "days": ("day", "days"),
    "week": ("week", "weeks"),
    "weeks": ("week", "weeks"),
}

# Batas atas: 365 hari - sama seperti backend. Offset yang lebih besar
# tidak pernah berguna untuk tugas kuliah, dan menerimanya hanya menambah
# ruang untuk salah ketik.
MAX_OFFSET_DAYS = 365
MAX_OFFSET_MINUTES = MAX_OFFSET_DAYS * 24 * 60

# Satuan yang bisa dipilih di field custom, dalam urutan dari yang paling
# halus ke yang paling kasar: (nilai yang dikirim, label di UI).
OFFSET_UNITS: tuple[tuple[str, str], ...] = (
    ("minutes", "menit"),
    ("hours", "jam"),
    ("days", "hari"),
    ("weeks", "minggu"),
)

# Offset yang tampil sebagai pilihan tetap. Nilainya harus sama persis
# dengan ``PRESET_OFFSETS`` di backend (app/core/reminder_offsets.py) -
# ``verify_bff.py`` membandingkan keduanya.
REMINDER_PRESETS: tuple[tuple[str, str], ...] = (
    ("30_minutes", "30 menit sebelum tenggat"),
    ("1_hour", "1 jam sebelum tenggat"),
    ("3_hours", "3 jam sebelum tenggat"),
    ("6_hours", "6 jam sebelum tenggat"),
    ("12_hours", "12 jam sebelum tenggat"),
    ("1_day", "H-1 (1 hari sebelum tenggat)"),
    ("3_days", "H-3 (3 hari sebelum tenggat)"),
    ("1_week", "H-7 (1 minggu sebelum tenggat)"),
)


def normalize_offset(value: Optional[str]) -> Optional[str]:
    """Kembalikan bentuk kanonik dari sebuah offset.

    ``None``/``""`` -> ``None`` (tanpa pengingat). Nilai yang tidak
    dikenal melempar ``ValueError`` - tidak pernah "dibenarkan diam-diam",
    karena offset yang tidak bisa dihitung akan membuat penjadwal
    gagal menyalakan pengingatnya.
    """
    if value is None:
        return None

    cleaned = str(value).strip().lower()
    if not cleaned:
        return None

    match = _OFFSET_RE.match(cleaned)
    if not match:
        raise ValueError(
            f"Format pengingat tidak dikenal: {value!r}. "
            f"Bentuknya <jumlah>_<satuan>, mis. "
            f"{', '.join(item[0] for item in REMINDER_PRESETS)}."
        )

    count = int(match.group(1))
    unit = match.group(2)

    if unit not in _UNIT_MINUTES:
        raise ValueError(
            f"Satuan pengingat tidak dikenal: {unit!r}. "
            "Yang valid: minute(s), hour(s), day(s), week(s)."
        )

    if count <= 0:
        raise ValueError(
            "Pengingat harus berapa waktu **sebelum** tenggat - "
            "nilai 0 atau negatif tidak punya arti."
        )


    minutes = count * _UNIT_MINUTES[unit]
    if minutes > MAX_OFFSET_MINUTES:
        max_amount = MAX_OFFSET_MINUTES // _UNIT_MINUTES[unit]
        raise ValueError(
            f"Pengingat terlalu jauh: {value!r} ({minutes // 1440} hari). "
            f"Maksimal {MAX_OFFSET_DAYS} hari ({max_amount} {unit})."
        )

    singular, plural = _CANONICAL_UNIT[unit]
    canonical_unit = singular if count == 1 else plural
    return f"{count}_{canonical_unit}"


def is_valid_offset(value: Optional[str]) -> bool:
    """True kalau nilainya offset yang dikenal (atau kosong)."""
    try:
        normalize_offset(value)
    except ValueError:
        return False
    return True


def describe_offset(value: Optional[str]) -> str:
    """Label Bahasa Indonesia untuk sebuah offset - dipakai di UI."""
    if not value:
        return "Tanpa pengingat"

    cleaned = str(value).strip().lower()
    match = _OFFSET_RE.match(cleaned)
    if not match or match.group(2) not in _UNIT_MINUTES:
        return cleaned

    count = int(match.group(1))
    unit = match.group(2)

    if unit.startswith("minute"):
        return f"{count} menit sebelum tenggat"
    if unit.startswith("hour"):
        return f"{count} jam sebelum tenggat"
    if unit.startswith("week"):
        return f"H-{count * 7} ({count} minggu sebelum tenggat)"
    return f"H-{count} ({count} hari sebelum tenggat)"


def preset_options() -> list[dict[str, str]]:
    """Preset sebagai daftar dict, siap dipakai di template dan JSON.

    Bentuk dict (bukan tuple) supaya bisa diserialisasi langsung ke
    ``<script type="application/json">`` - dari situ JavaScript
    membacanya, tanpa menyalin daftar kedua di file JS.
    """
    return [
        {"value": value, "label": label}
        for value, label in REMINDER_PRESETS
    ]

