"""
Server class untuk ``manage.py runserver`` yang punya antrean listen lebih
besar dari bawaan Django.

**Masalah yang diselesaikan.** ``django.core.servers.basehttp.WSGIServer``
mewarisi ``request_queue_size = 10`` dari ``socketserver.TCPServer``. Angka
itu adalah *backlog listen* di kernel -- banyaknya koneksi yang boleh
menunggu di antrean ``accept()`` sebelum server dianggap kewalahan.

Django 4.2 LTS masih memakai 10. Itu cukup untuk satu developer yang
mengeklik-klik, tapi tidak untuk beberapa browser sekaligus:

  * satu halaman dashboard memuat ~8 file statis,
  * Chromium membuka 6 koneksi per host (HTTP/1.1 keep-alive),
  * 5 skrip audit yang jalan bersamaan = 5 browser = ~40 koneksi
    dalam hitungan milidetik.

Saat antrean listen penuh, **Windows membalas RST** ke SYN yang datang.
Perilaku ini berbeda dari Linux, yang membuang SYN-nya dan menunggu --
pelanggannya komplain "timeout", bukan "refused". Chromium membaca RST itu
sebagai ``net::ERR_CONNECTION_REFUSED``, meskipun server-nya sehat dan
port-nya terbuka.

Bukti (app Django yang sama, beban yang sama, satu-satunya variabel
backlog):

    request_queue_size=10   -> 15, 19, 22 ERR_CONNECTION_REFUSED
    request_queue_size=256  ->  0,  0,  0 ERR_CONNECTION_REFUSED

Akibatnya file statis lokal gagal dimuat: halaman tampil **setengah** --
badge hilang, kartu statistik kosong -- dan audit melaporkan kegagalan
yang sebenarnya bukan bug aplikasi.

**Kenapa tidak cukup ``--noreload``.** ``--noreload`` mematikan
auto-reload, bukan backlog-nya. Yang menentukan besar antrean listen
adalah nilai ``request_queue_size`` di kelas server-nya.

**Kenapa angka 256 dan bukan yang lebih besar.** 256 cukup untuk beban
skrip audit tanpa memakai memori berarti: satu backlog 256 di Windows
memakai ratusan KB, bukan MB. Angkanya tetap bisa diubah lewat
``DJANGO_LISTEN_BACKLOG`` di ``.env`` -- lihat ``config/settings.py``.
"""

import os

from django.core.servers.basehttp import WSGIServer

#: Backlog default. Cukup untuk 5 browser audit + satu developer yang
#: sedang membuka DevTools.
DEFAULT_BACKLOG = 256


def read_backlog() -> int:
    """Baca backlog dari settings, dengan fallback ke default.

    Sumbernya ``settings.DJANGO_LISTEN_BACKLOG`` -- yang sendiri dibaca
    dari environment di ``config/settings.py``. Nilai yang tidak valid
    (bukan angka, atau <= 0) diabaikan: lebih baik pakai default yang
    sudah terbukti jalan daripada server yang gagal start karena typo di
    ``.env``.
    """
    raw = None

    try:
        from django.conf import settings

        raw = getattr(settings, "DJANGO_LISTEN_BACKLOG", None)
    except Exception:  # pragma: no cover - settings belum siap
        raw = os.environ.get("DJANGO_LISTEN_BACKLOG")

    if raw is None:
        return DEFAULT_BACKLOG
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError):
        return DEFAULT_BACKLOG
    if value <= 0:
        return DEFAULT_BACKLOG
    return value


class DevServer(WSGIServer):
    """``WSGIServer`` dengan backlog listen yang lebih besar.

    Dipakai lewat ``manage.py runserver`` -- lihat
    ``dashboard/management/commands/runserver.py``.
    """

    request_queue_size = read_backlog()
