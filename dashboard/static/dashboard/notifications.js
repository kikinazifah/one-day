/**
 * Notifikasi - satu tempat untuk semua halaman.
 *
 * Dua hal yang harus ada di mana-mana:
 *
 *   1. **Panel web.** Lonceng di topbar membuka daftar notifikasi; item
 *      bisa ditandai sudah dibaca satu per satu atau sekaligus. Panelnya
 *      sendiri ada di ``_notification_panel.html`` (include di
 *      ``base.html``), jadi markup-nya tidak ditulis ulang per halaman.
 *
 *   2. **Notifikasi peramban.** Spesifikasi §3.3 minta notifikasi dikirim
 *      ke "panel web dan peramban". Kanal perambannya: polling
 *      ``GET /api/notifications/pending/`` -> Service Worker ->
 *      ``showNotification()``. Polling (bukan Web Push) karena tidak
 *      butuh VAPID, tidak butuh tabel subscription, dan tidak menambah
 *      dependensi - dengan harga tab harus terbuka.
 *
 * Modul ini memasang dirinya sendiri di seluruh halaman (auto-mount di
 * akhir file ini). Dulu mount() dipanggil dari home.js dan
 * reminder_system.js — akibatnya lonceng di lima halaman lain (Document
 * Creator, Lecture Listener, AI Lecturer, RAG, Auto Scheduler) terlihat
 * tapi tidak bisa diklik dan polling perambannya tidak pernah jalan.
 *
 * Perbedaan dari home.js sebelumnya: modul ini **tidak** memakai
 * ``toast()`` lokal, dan tidak menyimpan badge di template.
 */
(function (global) {
  "use strict";

  // Berapa sering polling mencari notifikasi baru. 20 detik: cukup cepat
  // supaya pengingat terasa segera, cukup lambat supaya tidak membebani
  // server.
  const POLL_INTERVAL_MS = 20000;

  // Kunci penanda "sudah pernah ditampilkan" di sessionStorage.
  // sessionStorage, bukan localStorage: penanda ini tidak boleh bertahan
  // setelah tab ditutup — kalau tetap, notifikasi lama bisa muncul
  // lagi di sesi berikutnya.
  const SEEN_KEY = "akademia.notifications.seen";

  // ---------------------------------------------------------------
  // STATE
  // ---------------------------------------------------------------

  let notifications = [];
  // Jumlah notifikasi belum dibaca **dari server** — bukan dihitung dari
  // daftar yang dimuat.
  //
  // Daftar notifikasi dipaginasi (backend membatasi jumlahnya), jadi
  // menghitung dari daftar hanya menghitung halaman pertama. Kalau ada
  // 30 notifikasi belum dibaca di halaman kedua, lonceng akan
  // menampilkan "0 belum dibaca" — dan tombol "Tandai semua dibaca"
  // ikut nonaktif, padahal masih ada yang belum dibaca.
  //
  // Nilai ini di-cache supaya render() (yang dipanggil sering) tidak
  // perlu menghitung ulang, dan `null` menandai "belum pernah dimuat"
  // supaya kode bisa jatuh ke perhitungan lokal saat backend lama
  // tidak mengirim metadata.
  let serverUnreadCount = null;
  let seenAt = null;
  let pollTimer = null;
  let permissionAsked = false;
  // Penanda mount() sudah jalan — dipanggil dua kali (auto-mount + pemanggil
  // lama) tidak boleh memasang listener ganda atau timer ganda.
  let mounted = false;

  const panel = () => document.getElementById("notificationPanel");
  const list = () => document.getElementById("notificationList");
  const bell = () => document.getElementById("notificationBell");
  const readAllButton = () => document.getElementById("notificationReadAll");

  function unreadCount() {
    if (serverUnreadCount !== null) return serverUnreadCount;
    return notifications.filter((notification) => !notification.is_read).length;
  }

  // ---------------------------------------------------------------
  // PANEL WEB
  // ---------------------------------------------------------------

  function render() {
    const listNode = list();
    if (!listNode) return;

    // Status tombol "tandai semua dibaca" selalu mengikuti data terbaru,
    // walau daftar notifikasinya sendiri tidak berubah.
    const readAll = readAllButton();
    if (readAll) {
      const unread = unreadCount();
      readAll.disabled = unread === 0;
      readAll.textContent = unread
        ? "Tandai semua dibaca (" + unread + ")"
        : "Tandai semua dibaca";
    }

    // Kalau data tidak berubah, jangan render ulang — mengganti elemen
    // saat pengguna sedang mengklik notifikasi akan membuat kliknya hilang.
    const signature = JSON.stringify(
      notifications.map((n) => [n.id, n.is_read, n.title, n.message]),
    );

    if (listNode.dataset.signature === signature) return;
    listNode.dataset.signature = signature;

    listNode.replaceChildren();

    if (!notifications.length) {
      const empty = document.createElement("p");
      empty.className = "notification-empty";
      empty.textContent = "Belum ada notifikasi.";
      listNode.appendChild(empty);
      return;
    }

    notifications.forEach((notification) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "notification-item";

      // Notifikasi yang belum dibaca ditandai kelasnya, bukan hanya
      // teks — supaya berbeda secara visual.
      if (!notification.is_read) item.classList.add("unread");

      const dot = document.createElement("span");
      dot.className = "notification-dot";

      const body = document.createElement("div");
      body.className = "notification-item-body";

      const title = document.createElement("strong");
      title.textContent = notification.title || "Notifikasi";

      const message = document.createElement("span");
      message.textContent = notification.message || "";

      body.append(title, message);
      item.append(dot, body);

      item.addEventListener("click", () => markRead(notification));

      listNode.appendChild(item);
    });
  }

  function refreshBell() {
    const bellNode = bell();
    if (!bellNode) return;

    const dot = bellNode.querySelector("i");
    if (dot) {
      const unread = unreadCount();
      dot.style.display = unread ? "" : "none";
    }
    bellNode.title = unreadCount() + " notifikasi belum dibaca";
  }

  async function load() {
    const api = global.AkademiaApi;
    if (!api) return;

    try {
      const data = await api.get("/api/notifications/");
      notifications = data.notifications || [];
      // Server menghitung jumlah belum dibaca dari **seluruh** hasil
      // filter, bukan dari halaman yang dikirim. Kalau metadata-nya tidak
      // ada (backend lama), `null` membuat hitungan jatuh ke daftar
      // lokal.
      serverUnreadCount =
        typeof data.unread_count === "number" ? data.unread_count : null;
    } catch (error) {
      console.warn("Notifikasi gagal dimuat:", error);
      notifications = [];
      serverUnreadCount = null;
    }
  }

  async function markRead(notification) {
    const api = global.AkademiaApi;
    if (!api || notification.is_read) return;

    try {
      await api.request(
        "POST",
        "/api/notifications/" + encodeURIComponent(notification.id) + "/read/",
      );

      // Muat ulang dari server, jangan cuma mengubah objek lokal:
      // objek yang diklik bisa saja sudah digantikan array baru dari
      // request sebelumnya, sehingga perubahan lokal hilang.
      await load();
      render();
      refreshBell();
    } catch (error) {
      console.warn("Gagal menandai notifikasi:", error);
    }
  }

  async function markAllRead() {
    const api = global.AkademiaApi;
    if (!api) return;

    try {
      await api.request("POST", "/api/notifications/read-all/");
      await load();
      render();
      refreshBell();
    } catch (error) {
      console.warn("Gagal menandai semua notifikasi:", error);
    }
  }

  async function open() {
    const panelNode = panel();
    if (!panelNode) return;

    // Muat data DULU, baru tampilkan. Kalau panelnya lebih dulu dibuka
    // lalu diisi belakangan, pengguna sempat melihat daftar kosong atau
    // data lama — dan klik mereka bisa jatuh pada elemen yang sudah
    // diganti.
    await load();
    render();
    refreshBell();

    panelNode.hidden = false;
    bell()?.setAttribute("aria-expanded", "true");
  }

  function close() {
    const panelNode = panel();
    if (!panelNode) return;

    panelNode.hidden = true;
    bell()?.setAttribute("aria-expanded", "false");
  }

  // ---------------------------------------------------------------
  // NOTIFIKASI PERAMBAN (polling + Service Worker)
  // ---------------------------------------------------------------

  /**
   * Cap waktu notifikasi terakhir yang sudah seen, dalam format naive UTC.
   *
   * `created_at` di database adalah UTC naive, jadi string-nya dikirim
   * apa adanya — tanpa sufiks "Z", supaya tetap cocok dengan kolomnya.
   *
   * Catatan: sufiks "Z" kebetulan juga diterima sekarang, tapi hanya
   * karena kolomnya `DateTime` tanpa zona waktu. Kalau kolomnya nanti
   * jadi timezone-aware, nilai yang dialiri timezone akan dibandingkan
   * dengan naive dan bisa bergeser. Kirim apa adanya — tidak ada
   * gunanya menambah sufiks yang tidak dipakai kolom aslinya.
   */
  function readSeenAt() {
    try {
      return global.sessionStorage?.getItem(SEEN_KEY) || null;
    } catch {
      // sessionStorage bisa diblokir (mode privat, iframe tanpa izin).
      // Bukan alasan untuk mematikan fitur — tandanya saja tidak
      // tersimpan.
      return null;
    }
  }

  function writeSeenAt(value) {
    try {
      global.sessionStorage?.setItem(SEEN_KEY, value);
    } catch {
      // Diabaikan — lihat readSeenAt.
    }
  }

  /**
   * Daftarkan Service Worker.
   *
   * Worker disajikan dari ``/sw.js`` (akar situs), bukan dari
   * ``/static/`` — scope default Service Worker hanya mencakup direktori
   * tempat file-nya dilayani, dan worker di ``/static/dashboard/`` tidak
   * bisa mengendalikan halaman ``/reminder-system/``.
   *
   * Kegagalan pendaftaran **tidak boleh** menggagalkan halaman: notifikasi
   * sistem adalah tambahan, bukan syarat halaman bisa dipakai.
   */
  async function registerWorker() {
    if (!("serviceWorker" in global.navigator)) return null;

    try {
      return await global.navigator.serviceWorker.register("/sw.js", {
        scope: "/",
      });
    } catch (error) {
      console.warn("Pendaftaran Service Worker gagal:", error);
      return null;
    }
  }

  /**
   * Minta izin notifikasi peramban.
   *
   * Permission hanya diminta setelah ada interaksi pengguna, dan hanya
   * sekali per sesi — browser akan mengabaikan permintaan kedua.
   */
  async function ensurePermission() {
    if (!("Notification" in global)) return "unsupported";
    if (global.Notification.permission === "granted") return "granted";
    if (global.Notification.permission === "denied") return "denied";
    if (permissionAsked) return "default";
    permissionAsked = true;

    try {
      return await global.Notification.requestPermission();
    } catch (error) {
      console.warn("Izin notifikasi gagal diminta:", error);
      return "default";
    }
  }

  /**
   * Tampilkan notifikasi sistem lewat Service Worker.
   *
   * `showNotification()` hanya boleh dipanggil dari konteks Service
   * Worker — pemanggilan langsung dari halaman hanya bekerja di sebagian
   * browser. Jadi halamannya mengirim pesan ke worker, worker yang
   * memunculkan notifikasinya.
   */
  async function showSystemNotification(payload) {
    const registration = await registerWorker();
    if (!registration) return false;

    try {
      const worker =
        registration.active ||
        global.navigator.serviceWorker.controller ||
        (await registration.ready);

      worker.postMessage({
        type: "show-notification",
        title: payload.title,
        body: payload.body,
        tag: payload.tag,
        data: { url: payload.url || fallbackUrl(payload.notificationType) },
      });
      return true;
    } catch (error) {
      console.warn("Gagal mengirim notifikasi ke Service Worker:", error);
      return false;
    }
  }

  // Judul cadangan dan tujuan klik per tipe notifikasi — dipakai saat
  // server tidak mengirim title/url spesifik. Tujuannya halaman fitur
  // tempat notifikasi itu bisa ditindaklanjuti. Kuncinya huruf besar;
  // nilai ``type`` dari server dinormalisasi dulu (enum di DB huruf kecil).
  const FALLBACK_BY_TYPE = {
    TASK_REMINDER: { title: "Pengingat tugas", url: "/reminder-system/" },
    LECTURE_REMINDER: { title: "Pengingat kuliah", url: "/auto-scheduler/" },
    VIDEO_READY: { title: "Video ajar", url: "/ai-lecturer/" },
    REPORT_READY: { title: "Laporan mingguan", url: "/ai-lecturer/" },
    RAG_ANSWER: { title: "Jawaban RAG", url: "/rag-assistant/" },
    DOCUMENT_READY: { title: "Dokumen siap", url: "/document-creator/" },
  };

  function normalizeType(notificationType) {
    return typeof notificationType === "string"
      ? notificationType.toUpperCase()
      : "";
  }

  function fallbackUrl(notificationType) {
    return (FALLBACK_BY_TYPE[normalizeType(notificationType)] || {}).url || "/";
  }

  function fallbackTitle(notificationType) {
    return (
      (FALLBACK_BY_TYPE[normalizeType(notificationType)] || {}).title ||
      "Notifikasi"
    );
  }

  /**
   * Satu putaran polling: cari notifikasi baru, tampilkan sebagai
   * notifikasi sistem, lalu perbarui penanda "sudah seen".
   *
   * Penanda disimpan sebagai ``created_at`` notifikasi terakhir yang
   * diproses. Ini yang membuat kanal ini **tanpa kolom baru**: database
   * tidak perlu tahu peramban mana yang sudah melihat notifikasi mana.
   */
  async function pollOnce() {
    const api = global.AkademiaApi;
    if (!api) return;

    let pending = [];
    try {
      const data = await api.notificationsPending(readSeenAt());
      pending = data.notifications || [];
    } catch (error) {
      // Polling gagal (backend restart, jaringan putus) — coba lagi di
      // putaran berikutnya. Jangan spam error ke console tiap 20 detik.
      return;
    }

    if (!pending.length) return;

    // Izin diminta setelah ada notifikasi yang benar-benar mau
    // ditampilkan, bukan saat halaman dibuka — meminta izin tanpa
    // alasan yang jelas adalah cara pasti ditolak.
    const permission = await ensurePermission();
    if (permission === "granted") {
      for (const notification of pending) {
        await showSystemNotification({
          title: notification.title || fallbackTitle(notification.type),
          body: notification.message || "",
          tag: notification.id,
          notificationType: notification.type,
        });
      }
    }

    // Penanda diperbarui **setelah** notifikasi diproses, jadi kalau
    // tab tertutup di tengah jalan, notifikasi yang belum sempat
    // diproses akan muncul lagi di sesi berikutnya — lebih baik muncul
    // dua kali daripada hilang.
    const latest = pending[pending.length - 1];
    if (latest?.created_at) {
      writeSeenAt(latest.created_at);
    }
  }

  function startPolling() {
    if (pollTimer) return;

    // Jalankan sekali segera, lalu setiap POLL_INTERVAL_MS.
    pollOnce();
    pollTimer = global.setInterval(pollOnce, POLL_INTERVAL_MS);

    // Polling di tab yang tersembunyi boros tanpa guna — notifikasi
    // peramban butuh tab terlihat supaya pengguna sempat melihatnya.
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) pollOnce();
    });
  }

  function stopPolling() {
    if (!pollTimer) return;
    global.clearInterval(pollTimer);
    pollTimer = null;
  }

  // ---------------------------------------------------------------
  // PENYAMBUNG (wiring)
  // ---------------------------------------------------------------

  /**
   * Pasang lonceng, panel, dan polling.
   *
   * Aman dipanggil di halaman yang tidak punya lonceng — semua bagian
   * mengecek keberadaan elemennya lebih dulu, jadi satu modul bisa dipakai
   * di seluruh halaman tanpa penyesuaian per halaman.
   */
  function mount() {
    if (mounted) return;
    const api = global.AkademiaApi;
    if (!api) return;
    mounted = true;

    bell()?.addEventListener("click", (event) => {
      event.stopPropagation();

      if (panel()?.hidden) {
        open();
      } else {
        close();
      }
    });

    readAllButton()?.addEventListener("click", (event) => {
      event.stopPropagation();
      markAllRead();
    });

    // Klik di luar panel menutupnya.
    document.addEventListener("click", (event) => {
      const panelNode = panel();
      if (!panelNode || panelNode.hidden) return;
      if (panelNode.contains(event.target)) return;
      if (bell()?.contains(event.target)) return;

      close();
    });

    document.addEventListener("keydown", (event) => {
      const panelNode = panel();
      if (event.key === "Escape" && panelNode && !panelNode.hidden) {
        close();
      }
    });

    // Muat daftar saat halaman dibuka supaya titik merah di lonceng
    // langsung akurat, tanpa harus diklik dulu.
    load().then(() => {
      render();
      refreshBell();
    });

    startPolling();
  }

  global.AkademiaNotifications = {
    mount,
    load,
    render,
    refreshBell,
    unreadCount,
    open,
    close,
    markRead,
    markAllRead,
    pollOnce,
    startPolling,
    stopPolling,
    ensurePermission,
    showSystemNotification,
    readSeenAt,
    writeSeenAt,
  };

  // Auto-mount: modul ini dimuat lewat ``_shared_scripts.html`` di semua
  // halaman, dan mount() sendiri menoleransi halaman tanpa lonceng. Tanpa
  // ini, lima halaman fitur punya lonceng mati (lihat komentar header).
  //
  // Script dimuat dengan ``defer``, jadi DOM sudah selesai diparsing saat
  // file ini dieksekusi — tapi ``AkademiaApi`` (api.js, juga defer) baru
  // terdefinisi setelah file itu jalan. Karena defer menjamin urutan
  // eksekusi mengikuti urutan tag, ``AkademiaApi`` sudah ada di sini.
  // DOMContentLoaded dipakai untuk kasus script dimuat tanpa defer.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})(window);
