"""
``manage.py runserver`` dengan antrean listen yang lebih besar.

Perintah ini **menggantikan** perintah ``runserver`` bawaan Django untuk
proyek ini. Yang diganti cuma satu hal: kelas server-nya -- supaya
backlog listen-nya bisa lebih dari 10 (lihat ``dashboard/dev_server.py``
untuk alasannya).

Semua opsi lain (``--noreload``, ``--nostatic``, ``--insecure``,
``--ipv6``, dan lain-lain) tetap apa adanya, karena perintah ini mewarisi
perintah bawaan Django.

**Kenapa perintah terpisah, bukan patch di tempat lain.** Django
mengambil kelas server dari atribut kelas ``Command.server_cls``, yang
tidak bisa dibaca dari ``settings``. Jadi kelas server hanya bisa
diganti lewat subclass perintah -- itu sebabnya file ini ada.

**Kenapa app ``dashboard`` harus yang pertama di ``INSTALLED_APPS``.**
Django mencari perintah dengan menelusuri app dalam urutan terbalik dan
menimpa perintah dengan nama yang sama. Artinya perintah dari app yang
**pertama** di ``INSTALLED_APPS`` yang menang. ``dashboard`` karena itu
harus berada di urutan pertama -- lihat ``config/settings.py``.
"""

from django.core.management.commands.runserver import (
    Command as CoreRunserverCommand,
)

from dashboard.dev_server import DevServer

try:  # pragma: no cover - staticfiles selalu ada di settings proyek ini
    from django.contrib.staticfiles.management.commands.runserver import (
        Command as StaticfilesRunserverCommand,
    )
except ImportError:  # pragma: no cover
    StaticfilesRunserverCommand = CoreRunserverCommand


class Command(StaticfilesRunserverCommand):
    """``runserver`` dengan ``request_queue_size`` yang lebih besar."""

    server_cls = DevServer
