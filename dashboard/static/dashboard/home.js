/**
 * Dashboard (home) — disambungkan ke backend lewat endpoint JSON Django.
 *
 *   GET  /api/dashboard/summary/ → panel tugas + jadwal + mata kuliah
 *   GET  /api/tasks/             → ringkasan tugas & badge pengingat
 *   GET  /api/schedule/          → sesi kuliah hari ini + konflik jadwal
 *   GET  /api/rag/documents/     → jumlah dokumen terindeks
 *   POST /api/rag/upload/        → tombol "Upload PDF" di kotak prompt
 *
 * Notifikasi (lonceng, panel, notifikasi peramban) ditangani modul
 * bersama ``notifications.js`` — bukan di sini. Markup-nya ada di
 * ``base.html``, jadi modul yang sama bisa dipakai halaman lain.
 *
 * Semua angka yang tadinya hardcoded di template (2 sesi kuliah aktif,
 * 12 berkas terindeks, 2 pengingat, badge "Proses Aktif 5") di sini
 * diganti dengan angka dari server.
 *
 * Catatan zona waktu: backend mengirim dua jenis waktu — jam dinding
 * (``due_date``, ``start_time``) dan cap waktu UTC (``created_at``).
 * Keduanya datang sebagai ISO string TANPA sufiks zona, jadi JavaScript
 * tidak bisa membedakannya sendiri. Karena itu ada dua helper terpisah
 * (``formatWallClock`` dan ``formatUtc``) dan call site wajib memilih
 * yang sesuai — satu helper yang "menebak" akan salah diam-diam.
 * Lihat ``docs/02-WAKTU-DAN-ZONA.md``.
 */
document.addEventListener("DOMContentLoaded", () => {
  const api = window.AkademiaApi;
  if (!api) return;

  // =====================================================
  // STATE
  // =====================================================

  let tasks = [];
  let documents = [];
  let videos = [];

  // Laporan mingguan Dosen AI — untuk widget dashboard. Dipisah dari
  // `videos` karena siklus waktunya beda: video dibuat manual, laporan
  // dibuat worker tiap minggu.
  let reports = [];
  let reportsLoaded = false;
  let reportsError = null;

  // Jadwal — **satu sumber** untuk panel "Jadwal Hari Ini", hero, badge
  // kartu fitur, dan kartu worker.
  //
  // Sebelumnya panel memakai `summary.schedule`, sedangkan hero & kartu
  // worker memakai `scheduleEntries` dari /api/schedule/ — dua request
  // berbeda yang bisa selesai pada waktu berbeda. Akibatnya panel
  // menulis "3 sesi hari ini" sementara hero menulis "Ada 0 sesi kuliah
  // aktif" di layar yang sama. Sekarang semuanya membaca satu objek.
  //
  // `today` = "hari ini" menurut zona aplikasi, dikirim backend. Tidak
  // dihitung di browser: user yang zona kerjanya berbeda akan melihat
  // hari yang salah.
  let schedule = { entries: [], conflicts: [], today: null };

  // Ringkasan dari /api/dashboard/summary/ — sumber data untuk panel
  // "Tugas Mendatang" dan "Jadwal Hari Ini".
  let summary = null;
  // True kalau ringkasan sudah pernah berhasil dimuat. Membedakan
  // "belum dimuat" dari "memang kosong" — kalau tidak, kegagalan
  // jaringan membuat panel menampilkan "Tidak ada tugas menunggu",
  // padahal server sebenarnya punya data.
  let summaryLoaded = false;
  // Error terakhir saat memuat ringkasan. Ditampilkan di panel supaya
  // kegagalan tidak terlihat seperti "tidak ada data".
  let summaryError = null;

  // =====================================================
  // HELPER WAKTU
  // =====================================================

  // Satu definisi untuk seluruh halaman — lihat
  // ``dashboard/datetime_utils.js``. Helper ini tadinya ditulis ulang
  // di lima file JavaScript, dan tiap salinan sedikit berbeda; begitu
  // satu salah, perbaikannya harus di lima tempat.
  //
  // **Jangan destructure langsung.** Kalau modul ini gagal dimuat,
  // ``window.AkademiaDateTime`` jadi ``undefined`` dan destructure dari
  // situ melempar error — dan karena baris ini ada di top-level handler
  // ``DOMContentLoaded``, **seluruh** handler mati: panel, badge, dan
  // profil ikut hilang. Satu modul hilang mematikan satu halaman penuh.
  //
  // Jadi di sini: `|| {}` supaya destructure tidak pernah melempar, dan
  // **nilai default** per helper supaya pemanggilnya tetap dapat bekerja
  // walaupun modulkya absen. Default-nya sengaja konservatif — nilai
  // yang "saya tidak tahu", bukan angka tebakan:
  //
  //   - `parseNaiveDateTime` → `null` (bukan "-"), supaya
  //     `isToday()` mengembalikan false dan bukan membandingkan string.
  //   - `dateKey` → `""`, supaya perbandingan dengan tanggal server
  //     juga false.
  //   - sisanya → placeholder yang jujur ("-", "--:--").
  //
  // Fallback inline **sengaja tidak menyalin logika**: menyalin helper
  // tanggal/waktu ke lima file persis masalah yang modul ini hilangkan.
  const dateTime = window.AkademiaDateTime || {};
  const {
    formatWallClock = () => "-",
    formatUtc = () => "-",
    parseNaiveDateTime = () => null,
    dateKey = () => "",
    formatClock = () => "--:--",
  } = dateTime;

  // =====================================================
  // RINGKASAN HALAMAN
  // =====================================================

  // Status tugas punya satu definisi untuk seluruh halaman — lihat
  // ``dashboard/task_state.js``. Badge sidebar, kartu "mendesak" di
  // Home, dan baris di Reminder System pakai definisi yang sama, jadi
  // angkanya tidak pernah beda satu sama lain.
  //
  // **Jangan destructure langsung.** Kalau modul ini gagal dimuat,
  // ``window.AkademiaTaskState`` jadi ``undefined`` dan destructure di
  // sini melempar error — dan karena baris ini ada di top-level handler
  // ``DOMContentLoaded``, **seluruh** handler mati: panel, badge, dan
  // profil ikut hilang. Satu modul hilang mematikan satu halaman penuh.
  //
  // Jadi di sini fallback yang dipakai kalau modul absen. Fallback-nya
  // sengaja konservatif: status sudah selesai & lewat tenggat dibaca
  // dari field yang sama seperti aslinya (backend yang menentukan), jadi
  // kalau modulnya ternyata dimuat, hasilnya identik.
  const taskState = window.AkademiaTaskState || {
    isCompleted: (task) =>
      Boolean(task) &&
      (task.is_completed === true || task.status === "completed"),
    isOverdue: (task) => Boolean(task) && task.status === "overdue",
    isUrgent: (task) =>
      Boolean(task) &&
      task.status !== "completed" &&
      task.is_completed !== true &&
      (task.priority === "high" ||
        task.priority === "urgent" ||
        task.status === "overdue"),
  };
  const { isCompleted, isOverdue, isUrgent } = taskState;

  function urgentCount() {
    return tasks.filter(isUrgent).length;
  }

  // Jadwal hari ini — schedule entry punya start_time/end_time naive.
  //
  // Dua hal menentukan sebuah entri muncul sebagai "hari ini":
  //
  // 1. **Hari ini** — dikirim backend di `schedule.today`, dihitung dalam
  //    zona aplikasi (`APP_TIMEZONE`). Browser tidak boleh menghitungnya
  //    sendiri: user yang zona kerjanya berbeda akan melihat panel hari
  //    yang salah. Server sudah tahu hari ini dalam zona yang benar.
  // 2. **Bentuk entri** — entri BERULANG (`is_recurring`) tampil di setiap
  //    minggu pada hari yang sama; entri SEKALI PAKAI hanya tampil di
  //    tanggalnya sendiri.
  //
  // Catatan: `day_of_week` yang terisi **bukan** tanda berulang. Entri
  // sekali pakai juga punya hari (dihitung dari tanggal mulai), jadi
  // memakainya sebagai sinyal berulang membuat entri sekali pakai ikut
  // tampil di setiap minggu. Backend juga sudah menormalkan: entri
  // sekali pakai disimpan dengan `day_of_week` kosong.
  //
  // day_of_week backend: 0=Senin .. 6=Minggu.
  function isToday(entry) {
    const today = schedule.today;
    if (!today || today.dow === null || today.dow === undefined) return false;

    if (entry.is_recurring) {
      // Entri berulang: cocok kalau hari-dalam-minggu-nya sama.
      const day = Number(entry.day_of_week);
      if (!Number.isFinite(day)) return false;
      return day === Number(today.dow);
    }

    // Entri sekali pakai: hanya tampil di tanggalnya sendiri — tanggal
    // yang dibandingkan adalah tanggal *server*, bukan tanggal browser.
    const start = parseNaiveDateTime(entry.start_time);
    if (!start) return false;
    return dateKey(start) === today.date;
  }

  function todaySessions() {
    return schedule.entries.filter(isToday);
  }

  function indexedDocuments() {
    return documents.filter((doc) => doc.status === "indexed").length;
  }

  function unreadNotifications() {
    return window.AkademiaNotifications
      ? window.AkademiaNotifications.unreadCount()
      : 0;
  }

  function setText(node, value) {
    if (node) node.textContent = value;
  }

  // Kalimat ringkasan di hero: "Ada 2 sesi kuliah aktif, ... dan 2 pengingat
  // tugas prioritas." — sebelumnya teks statis.
  function renderSummary() {
    const description = document.querySelector(".welcome-description");
    if (!description) return;

    const sessions = todaySessions().length;
    const indexed = indexedDocuments();
    const urgent = urgentCount();

    description.replaceChildren();

    const intro = document.createElement("span");
    intro.textContent = "Ada ";
    description.append(intro);

    const strongSessions = document.createElement("strong");
    strongSessions.textContent = sessions + " sesi kuliah aktif";
    description.append(strongSessions);

    const middle = document.createElement("span");
    middle.textContent = ", ";
    description.append(middle);

    const strongIndexed = document.createElement("strong");
    strongIndexed.textContent = indexed + " dokumen terindeks";
    description.append(strongIndexed);

    const tail = document.createElement("span");
    tail.textContent = ", dan ";
    description.append(tail);

    const strongUrgent = document.createElement("strong");
    strongUrgent.textContent = urgent + " pengingat tugas prioritas";
    description.append(strongUrgent);

    const end = document.createElement("span");
    end.textContent = ".";
    description.append(end);
  }

  // =====================================================
  // BADGE & KARTU
  // =====================================================

  function renderBadges() {
    // Badge sidebar "Reminder System" — **tidak** ditulis di sini.
    //
    // Sidebar punya badge yang sama di dua tempat (desktop + mobile),
    // dan modul bersama ``reminder_badge.js`` sudah menulis keduanya
    // dari satu sumber data. Kalau halaman ini juga menulisnya, ada
    // dua angka yang bisa berbeda — persis bug yang membuat badge di
    // sidebar beda dengan kartu "mendesak" di halaman ini.
    //
    // Yang ditulis di sini hanya badge **kartu fitur** ("N Mendesak"),
    // yang memakai format berbeda dan tidak ada di sidebar.
    const featureBadge = document.querySelector("#reminder .badge");
    if (featureBadge) {
      const urgent = urgentCount();
      featureBadge.textContent = urgent + " Mendesak";
      featureBadge.hidden = urgent === 0;
    }

    // Badge kartu fitur "Web Auto Scheduler" → "N Kelas Hari Ini".
    const schedulerBadge = document.querySelector("#scheduler .badge");
    if (schedulerBadge) {
      const sessions = todaySessions().length;
      schedulerBadge.textContent = sessions + " Kelas Hari Ini";
      schedulerBadge.hidden = sessions === 0;
    }

    // Tombol notifikasi di topbar: titik merah hanya kalau ada yang belum
    // dibaca. Daftarnya dimiliki modul notifikasi bersama, jadi di sini
    // cuma diminta supaya digambar ulang — bukan disimpan dua kali.
    window.AkademiaNotifications?.refreshBell();
  }

  // "Proses Aktif" — backend tidak punya endpoint antrean global, jadi angka
  // dihitung dari pekerjaan yang memang sedang berjalan: video ajar yang
  // diproses dan dokumen yang sedang diindeks.
  function activeProcesses() {
    const rendering = videos.filter(
      (video) => video.status === "processing" || video.status === "pending",
    ).length;
    const indexing = documents.filter(
      (doc) => doc.status === "uploaded" || doc.status === "processing",
    ).length;
    return rendering + indexing;
  }

  function renderProcessButton() {
    const button = document.querySelector(".process-button");
    if (!button) return;

    const badge = button.querySelector(".badge");
    const count = activeProcesses();
    if (badge) {
      badge.textContent = count;
      badge.hidden = count === 0;
    }
  }

  // =====================================================
  // WORKER QUEUE
  // =====================================================

  // Kartu worker di template adalah data contoh. Ganti isinya dengan
  // keadaan nyata: dokumen yang sedang diindeks, dokumen terindeks, dan
  // konflik jadwal (backend mengirimnya terpisah di field ``conflicts``).
  function renderWorkerQueue() {
    const grid = document.querySelector(".worker-grid");
    if (!grid) return;

    const indexing = documents.filter(
      (doc) => doc.status === "uploaded" || doc.status === "processing",
    );
    const indexed = indexedDocuments();
    // Bentrok dihitung dengan definisi yang sama seperti panel jadwal:
    // pasangan bentrok yang melibatkan entri hari ini. Kalau kartu ini
    // memakai definisi lain, dua angka berbeda tampil di layar yang sama.
    const conflictPairs = todayConflicts();

    grid.replaceChildren();

    grid.append(
      workerCard({
        icon: "database",
        title: "RAG Vector Indexing (ChromaDB)",
        badge: indexed + " Berkas",
        badgeClass: "blue",
        description:
          indexed +
          " dokumen terindeks, siap dijadikan konteks untuk pertanyaan.",
        info: ["Embedding aktif", "Ready for Prompting"],
      }),
    );

    if (indexing.length) {
      grid.append(
        workerCard({
          icon: "sync",
          title: "Pengindeksan Dokumen Berjalan",
          badge: indexing.length + " Aktif",
          badgeClass: "blue",
          description:
            "Dokumen sedang diproses: " +
            indexing.map((doc) => doc.fileName || "berkas").join(", "),
          info: ["Background worker", "Menunggu selesai"],
        }),
      );
    }

    const rendering = videos.filter(
      (video) => video.status === "processing" || video.status === "pending",
    );
    if (rendering.length) {
      grid.append(
        workerCard({
          icon: "movie_creation",
          title: "Pembuatan Video Dosen AI",
          badge: rendering.length + " Aktif",
          badgeClass: "blue",
          description:
            "Video sedang dirender: " +
            rendering
              .map((video) => video.material || video.title || "materi")
              .join(", "),
          info: ["Celery/Redis", "Menunggu selesai"],
        }),
      );
    }

    grid.append(
      workerCard({
        icon: "calendar_month",
        title: "Jadwal Perkuliahan",
        badge: conflictPairs.length ? conflictPairs.length + " Konflik" : "Bersih",
        badgeClass: conflictPairs.length ? "red" : "green",
        description:
          todaySessions().length +
          " sesi hari ini, " +
          schedule.entries.length +
          " entri total. " +
          (conflictPairs.length
            ? conflictPairs.length + " bentrok terdeteksi."
            : "Tidak ada bentrok."),
        info: ["Sumber: backend", "Sinkron"],
      }),
    );
  }

  function workerCard({ icon, title, badge, badgeClass, description, info }) {
    const card = document.createElement("article");
    card.className = "worker-card";

    const head = document.createElement("div");
    head.className = "worker-title";

    const iconNode = document.createElement("span");
    iconNode.className = "material-symbols-outlined";
    iconNode.textContent = icon;

    const titleNode = document.createElement("strong");
    titleNode.textContent = title;

    const badgeNode = document.createElement("span");
    badgeNode.className = "badge " + badgeClass;
    badgeNode.textContent = badge;

    head.append(iconNode, titleNode, badgeNode);

    const desc = document.createElement("p");
    desc.className = "worker-description";
    desc.textContent = description;

    const infoRow = document.createElement("div");
    infoRow.className = "worker-info";

    info.forEach((text, index) => {
      const span = document.createElement(index === info.length - 1 ? "strong" : "span");
      span.textContent = text;
      infoRow.append(span);
    });

    card.append(head, desc, infoRow);
    return card;
  }

  // =====================================================
  // PANEL TUGAS & JADWAL
  // =====================================================

  const PRIORITY_LABEL = {
    low: "Rendah",
    medium: "Sedang",
    high: "Tinggi",
    urgent: "Mendesak",
  };

  const PRIORITY_BADGE = {
    low: "green",
    medium: "blue",
    high: "red",
    urgent: "red",
  };

  const TYPE_LABEL = {
    assignment: "Tugas",
    exam: "Ujian",
    project: "Proyek",
    reading: "Bacaan",
    other: "Lainnya",
  };

  // Entri jadwal yang bentrok. Backend sudah menghitungnya (field
  // ``conflicts`` di /schedule/), jadi di sini cukup dikumpulkan id-nya.
  //
  // Konsep "bentrok" harus sama di mana-mana. Sebelumnya panel
  // menghitung jumlah entri yang ikut bentrok (``conflicts.size``),
  // sedangkan kartu worker menghitung jumlah **pasangan** bentrok
  // (``conflicts.length``) — dua angka berbeda untuk data yang sama,
  // jadi panel bisa bilang "3 bentrok" sementara worker card bilang
  // "2 Konflik" di layar yang sama.
  //
  // Sekarang keduanya memakai definisi yang sama: **pasangan bentrok
  // yang melibatkan entri hari ini**. "Hari ini" dipakai karena panel
  // hanya menampilkan entri hari ini — bentrok antar entri minggu depan
  // tidak terlihat di panel, jadi menghitungnya di sini hanya
  // membingungkan.
  function todayConflicts() {
    const todayIds = new Set(todaySessions().map((entry) => entry.id));

    return (schedule.conflicts || []).filter(
      (conflict) =>
        todayIds.has(conflict?.entry1_id) || todayIds.has(conflict?.entry2_id),
    );
  }

  // Id entri yang ikut bentrok — dipakai untuk menandai baris di panel.
  function conflictedEntryIds() {
    const ids = new Set();

    todayConflicts().forEach((conflict) => {
      if (conflict?.entry1_id) ids.add(conflict.entry1_id);
      if (conflict?.entry2_id) ids.add(conflict.entry2_id);
    });

    return ids;
  }

  function renderTaskPanel() {
    const list = document.getElementById("dashboardTaskList");
    const heading = document.querySelector("[data-task-panel-summary]");
    if (!list) return;

    const items = summary?.tasks?.items || [];
    // Berapa banyak tugas yang TIDAK ikut dirender karena batas 8.
    // Datangnya dari server supaya angka ini tidak bisa melenceng dari
    // jumlah item yang benar-benar diterima browser.
    const omitted = summary?.tasks?.omitted ?? 0;
    // Jumlah "lewat tenggat" datang dari server, dihitung dari **semua**
    // tugas yang belum selesai — bukan dari 8 item yang tampil di panel.
    // Kalau dihitung dari `items`, tugas yang lewat tenggat tapi tidak
    // masuk 8 teratas akan hilang dari hitungan, dan angka yang tampil
    // terlihat benar padahal tidak.
    const overdueCount =
      summary?.tasks?.overdue ?? items.filter(isOverdue).length;

    if (heading) {
      if (summaryError) {
        heading.textContent = "Gagal memuat ringkasan";
      } else if (!summaryLoaded) {
        heading.textContent = "Memuat tugas...";
      } else {
        // Heading menyebut jumlah **yang tampil**, bukan total yang
        // belum selesai. Kalau menulis "13 tugas belum selesai" tapi
        // hanya 8 baris yang dirender, user mengira 5 tugas hilang.
        // Sisanya disebut eksplisit lewat baris "+N tugas lainnya".
        const parts = [items.length + " tugas berikutnya"];
        if (omitted) parts.push(omitted + " lainnya");
        if (overdueCount) parts.push(overdueCount + " lewat tenggat");
        heading.textContent = parts.join(" · ");
      }
    }

    list.replaceChildren();

    if (!items.length) {
      if (summaryError) {
        list.append(
          panelEmpty(
            "cloud_off",
            "Ringkasan gagal dimuat",
            summaryError + " — tekan Muat Ulang untuk mencoba lagi.",
          ),
        );
        return;
      }
      if (!summaryLoaded) {
        list.append(
          panelEmpty("hourglass_empty", "Memuat tugas...", "Sebentar saja."),
        );
        return;
      }
      list.append(
        panelEmpty(
          "task_alt",
          "Tidak ada tugas menunggu",
          "Tugas yang dibuat akan muncul di sini beserta tenggatnya.",
        ),
      );
      return;
    }

    items.forEach((task) => list.append(taskRow(task)));

    // Baris penutup kalau masih ada tugas yang tidak ditampilkan.
    // Tanpa ini, tugas ke-9 dan seterusnya hilang diam-diam — panel
    // terlihat seperti daftar lengkap padahal bukan.
    if (omitted) {
      list.append(omittedRow(omitted));
    }
  }

  // Baris "+N tugas lainnya" — penanda bahwa daftar di panel dipotong,
  // bukan lengkap. Dipakai ``<a>`` ke Reminder System supaya user bisa
  // melihat semuanya.
  function omittedRow(omitted) {
    const row = document.createElement("a");
    row.className = "dashboard-task-omitted";
    row.href = "/reminder-system/";
    row.textContent =
      "+" + omitted + " tugas lainnya — lihat semua di Reminder System";
    return row;
  }

  function taskRow(task) {
    const row = document.createElement("div");
    row.className = "dashboard-task-item";
    row.dataset.taskId = task.id;

    if (isOverdue(task)) row.classList.add("overdue");

    const main = document.createElement("div");
    main.className = "dashboard-task-main";

    const title = document.createElement("strong");
    title.className = "dashboard-task-title";
    title.textContent = task.title || "Tanpa judul";

    const meta = document.createElement("div");
    meta.className = "dashboard-task-meta";

    // Kode mata kuliah (bukan UUID) supaya tugas bisa dikenali sekilas.
    if (task.course_code) {
      const course = document.createElement("span");
      course.className = "dashboard-task-course";
      course.textContent = task.course_code;
      meta.append(course);
    }

    const type = document.createElement("span");
    type.textContent = TYPE_LABEL[task.type] || task.type || "Tugas";
    meta.append(type);

    const due = document.createElement("span");
    due.className = "dashboard-task-due";
    if (isOverdue(task)) due.classList.add("late");
    due.textContent =
      (isOverdue(task) ? "Lewat: " : "Tenggat: ") + formatWallClock(task.due_date);
    meta.append(due);

    // "Dibuat" adalah cap waktu UTC (bukan jam dinding), jadi dibaca
    // dengan helper yang menambahkan "Z".
    if (task.created_at) {
      const created = document.createElement("span");
      created.className = "dashboard-task-created";
      created.textContent = "Dibuat " + formatUtc(task.created_at);
      meta.append(created);
    }

    main.append(title, meta);

    const actions = document.createElement("div");
    actions.className = "dashboard-task-actions";

    const priority = document.createElement("span");
    priority.className =
      "badge " + (PRIORITY_BADGE[task.priority] || "blue");
    priority.textContent = PRIORITY_LABEL[task.priority] || task.priority;
    actions.append(priority);

    const done = document.createElement("button");
    done.type = "button";
    done.className = "dashboard-task-done";
    done.textContent = "Selesai";
    done.addEventListener("click", () => completeTaskFromDashboard(task.id, done));
    actions.append(done);

    row.append(main, actions);
    return row;
  }

  function renderSchedulePanel() {
    const list = document.getElementById("dashboardScheduleList");
    const heading = document.querySelector("[data-schedule-panel-summary]");
    if (!list) return;

    const today = todaySessions();
    const conflictPairs = todayConflicts();
    const conflicts = conflictedEntryIds();

    if (heading) {
      const parts = [today.length + " sesi hari ini"];
      // Jumlah **pasangan** bentrok — sama dengan yang dipakai kartu
      // worker, jadi dua angka di layar ini tidak saling bertentangan.
      if (conflictPairs.length) {
        parts.push(conflictPairs.length + " bentrok");
      }
      heading.textContent = parts.join(" · ");
    }

    list.replaceChildren();

    if (!today.length) {
      list.append(
        panelEmpty(
          "event_busy",
          "Tidak ada jadwal hari ini",
          "Kelas dan agenda yang jatuh pada hari ini akan tampil di sini.",
        ),
      );
      return;
    }

    // Urutkan berdasarkan jam mulai.
    today
      .slice()
      .sort((a, b) => {
        const left = parseNaiveDateTime(a.start_time);
        const right = parseNaiveDateTime(b.start_time);
        return (left?.getTime() || 0) - (right?.getTime() || 0);
      })
      .forEach((entry) => list.append(scheduleRow(entry, conflicts)));
  }

  function scheduleRow(entry, conflicts) {
    const row = document.createElement("div");
    row.className = "dashboard-schedule-item";
    if (conflicts.has(entry.id)) row.classList.add("conflict");

    const time = document.createElement("div");
    time.className = "dashboard-schedule-time";
    time.textContent = formatClock(entry.start_time);

    const body = document.createElement("div");
    body.className = "dashboard-schedule-main";

    const title = document.createElement("strong");
    title.textContent = entry.title || "Tanpa judul";
    body.append(title);

    const meta = document.createElement("div");
    meta.className = "dashboard-schedule-meta";

    if (entry.course_code) {
      const course = document.createElement("span");
      course.textContent = entry.course_code;
      meta.append(course);
    }

    const end = document.createElement("span");
    end.textContent = formatClock(entry.start_time) + " - " + formatClock(entry.end_time);
    meta.append(end);

    if (entry.location) {
      const location = document.createElement("span");
      location.textContent = entry.location;
      meta.append(location);
    }

    body.append(meta);

    row.append(time, body);

    if (conflicts.has(entry.id)) {
      const badge = document.createElement("span");
      badge.className = "badge red";
      badge.textContent = "Bentrok";
      row.append(badge);
    }

    return row;
  }

  function panelEmpty(icon, title, message) {
    const wrapper = document.createElement("div");
    wrapper.className = "empty-state compact-empty";

    const iconNode = document.createElement("span");
    iconNode.className = "material-symbols-outlined";
    iconNode.textContent = icon;

    const heading = document.createElement("h3");
    heading.textContent = title;

    const paragraph = document.createElement("p");
    paragraph.textContent = message;

    wrapper.append(iconNode, heading, paragraph);
    return wrapper;
  }

  // Tandai tugas selesai langsung dari dashboard, lalu segarkan panel dan
  // badge sidebar. Cache tugas di api.js harus di-invalidasi supaya
  // angka badge tidak basi.
  async function completeTaskFromDashboard(taskId, button) {
    if (button) button.disabled = true;

    try {
      await api.post("/api/tasks/" + encodeURIComponent(taskId) + "/complete/");

      // Muat ulang ringkasan (isi panel) dan daftar tugas (badge sidebar)
      // dari server — jangan hanya mengubah state lokal, supaya kalau
      // ada mutasi lain di luar dashboard, keduanya tetap sinkron.
      await Promise.all([loadSummary(), api.refreshTasks()]);

      // Daftar tugas sekarang **ikut ter-refresh** oleh snapshot
      // bersama: `api.refreshTasks()` menulis snapshot baru, dan
      // pelanggan snapshot menggambar ulang badge, hero, dan kartu
      // "N Mendesak" dari data yang sama. Jadi tidak perlu request
      // kedua di sini — dan kalau ada, jawabannya bisa berbeda dari
      // snapshot, sehingga angkanya bisa tidak cocok.
      renderTaskPanel();
      renderSchedulePanel();
      renderSummary();
      renderBadges();
      renderWorkerQueue();

      toast("Tugas ditandai selesai.");
    } catch (error) {
      if (button) button.disabled = false;
      toast("Gagal menandai tugas: " + error.message);
    }
  }

  // =====================================================
  // TANGGAL DI KARTI KANAN
  // =====================================================

  function renderDate() {
    const card = document.querySelector(".date-card");
    if (!card) return;

    const strong = card.querySelector("strong");
    const paragraph = card.querySelector("p");

    const today = new Date();
    if (strong) {
      strong.textContent = today.toLocaleDateString("id-ID", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      });
    }
    if (paragraph) {
      // Minggu ke berapa dalam semester — dihitung dari awal Juli (awal
      // semester ganjil) sampai hari ini.
      const start = new Date(today.getFullYear(), 6, 1);
      const week = Math.max(
        1,
        Math.floor((today - start) / (7 * 24 * 60 * 60 * 1000)) + 1,
      );
      paragraph.textContent = "Minggu Perkuliahan ke-" + week;
    }
  }

  // =====================================================
  // PROMPT & AKSI
  // =====================================================

  function toast(message) {
    const node = document.getElementById("toast");
    if (!node) return;

    node.textContent = message;
    node.classList.add("visible");
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => node.classList.remove("visible"), 4000);
  }

  // Prompt "Kirim" → arahkan ke Dosen AI. Navigasi, bukan proses AI
  // sendiri: halaman AI Lecturer yang menangani chat. Pertanyaannya
  // disimpan di sessionStorage supaya halaman tujuan bisa mengisinya
  // otomatis — sessionStorage hilang saat tab ditutup, jadi tidak bertahan
  // sebagai data pribadi.
  function wirePrompt() {
    const input = document.getElementById("promptInput");
    const send = document.getElementById("sendPrompt");

    function submit() {
      const text = input?.value.trim();
      if (!text) {
        toast("Tulis pertanyaan dulu.");
        return;
      }
      sessionStorage.setItem("akademia.prompt", text);
      window.location.href = "/ai-lecturer/";
    }

    send?.addEventListener("click", submit);
    input?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submit();
      }
    });
  }

  // "Upload PDF" di prompt → unggah ke indeks RAG, lalu arahkan ke halaman
  // RAG Assistant.
  function wireUpload() {
    const pdfInput = document.getElementById("pdfInput");
    if (!pdfInput) return;

    pdfInput.addEventListener("change", async () => {
      const file = pdfInput.files?.[0];
      pdfInput.value = "";
      if (!file) return;

      if (!/\.pdf$/i.test(file.name)) {
        toast("Hanya berkas PDF yang bisa diunggah dari sini.");
        return;
      }

      try {
        const form = new FormData();
        form.append("file", file);
        await api.upload("/api/rag/upload/", form);
        toast("Berkas diunggah, sedang diindeks di latar belakang.");
        await loadDocuments();
        window.location.href = "/rag-assistant/";
      } catch (error) {
        toast(error.message);
      }
    });
  }

  // Tombol "Buat Materi AI" → ke Document Creator.
  function wireCreateMaterial() {
    const button = document.getElementById("createMaterial");
    button?.addEventListener("click", () => {
      window.location.href = "/document-creator/";
    });
  }

  // Tombol yang sebelumnya cuma menampilkan "notifikasi contoh" — arahkan ke
  // halaman fiturnya yang sebenarnya sudah terhubung.
  function wireFeatureButtons() {
    const targets = [
      { selector: "#lecture .feature-button", href: "/lecture-listener/" },
      { selector: "#reminder .feature-button", href: "/reminder-system/" },
      { selector: "#rag .feature-button", href: "/rag-assistant/" },
      { selector: "#lecturer .feature-button", href: "/ai-lecturer/" },
      { selector: "#scheduler .feature-button", href: "/auto-scheduler/" },
    ];

    targets.forEach(({ selector, href }) => {
      const button = document.querySelector(selector);
      if (!button) return;
      button.addEventListener("click", () => {
        window.location.href = href;
      });
    });
  }

  // "Refresh queue" → muat ulang data worker.
  function wireRefresh() {
    const button = document.getElementById("refreshQueue");
    button?.addEventListener("click", async () => {
      await loadAll();
      toast("Data diperbarui.");
    });
  }

  // Elemen yang memang belum punya backend ditandai ``data-unavailable``.
  // Tombolnya harus tetap memberi umpan balik, bukan diam saja.
  function wireUnavailable() {
    document.querySelectorAll("[data-unavailable]").forEach((element) => {
      element.addEventListener("click", (event) => {
        event.preventDefault();
        toast(element.dataset.unavailable);
      });
    });
  }

  // =====================================================
  // NOTIFIKASI
  // =====================================================

  // Panel notifikasi dan loncengnya sekarang ditangani modul bersama
  // ``notifications.js`` (window.AkademiaNotifications) — markup dan
  // logikanya dipakai halaman Reminder System juga, jadi menulisnya dua
  // kali berarti dua tempat yang bisa berbeda.
  //
  // Yang tersisa di sini cuma hitungan badge lonceng, karena angka
  // "belum dibaca" juga dipakai kartu ringkasan.

  // Voice STT butuh mikrofon + endpoint STT di backend yang belum ada.
  // Jadi tombolnya menjelaskan batasannya, bukan berpura-pura bisa jalan.
  function wireVoiceStt() {
    const button = document.getElementById("voiceStt");
    button?.addEventListener("click", () => {
      toast("Voice STT belum tersedia. Gunakan Lecture Listener untuk merekam kuliah.");
    });
  }

  // =====================================================
  // MEMUAT DATA
  // =====================================================

  async function loadTasks() {
    try {
      const data = await api.tasks();
      tasks = data.tasks || [];
    } catch (error) {
      console.warn("Daftar tugas gagal dimuat:", error);
    }
  }

  /**
   * Daftar tugas milik dashboard — dibaca dari **snapshot bersama** di
   * `api.js`, bukan dari request terpisah.
   *
   * Badge sidebar, kartu "N Mendesak", dan hero di halaman ini semuanya
   * harus berasal dari daftar yang sama. Kalau tiap bagian mengambil
   * `/api/tasks/` sendiri, jawabannya bisa berbeda — dan angkanya jadi
   * berbeda di halaman yang sama.
   */
  function subscribeToTaskSnapshot() {
    api.subscribeTasks?.((snapshot) => {
      if (!snapshot || !snapshot.loaded) return;
      tasks = snapshot.tasks || [];
      renderSummary();
      renderBadges();
      renderProcessButton();
      renderWorkerQueue();
    });
  }

  // Ringkasan dashboard — satu request BFF yang mengambil tugas, jadwal,
  // dan mata kuliah sekaligus. Endpoint ini yang jadi sumber panel
  // "Tugas Mendatang" & "Jadwal Hari Ini".
  async function loadSummary() {
    try {
      const data = await api.get("/api/dashboard/summary/");
      summary = data;
      summaryLoaded = true;
      summaryError = null;

      // Jadwal ikut diambil dari ringkasan ini supaya **satu** request
      // yang jadi sumber tunggal. Sebelumnya panel memakai
      // `summary.schedule` sementara hero & worker card memakai
      // `scheduleEntries` dari /api/schedule/ — dua request yang bisa
      // selesai pada waktu berbeda, sehingga panel dan hero bisa
      // menampilkan angka berbeda di layar yang sama.
      schedule = {
        entries: data.schedule?.entries || [],
        conflicts: data.schedule?.conflicts || [],
        today: data.schedule?.today || null,
      };
    } catch (error) {
      // Error dicatat, bukan ditelan: tanpa ini, panel menampilkan
      // "Tidak ada tugas menunggu" saat backend sedang restart —
      // yang menyesatkan, karena datanya ada, cuma belum sampai.
      summaryError = error.message || "tidak diketahui";
      console.warn("Ringkasan dashboard gagal dimuat:", error);
    }
  }

  // Fallback jadwal — dipakai **hanya** kalau ringkasan gagal dimuat.
  // Endpoint ini mengembalikan entri + konflik + "hari ini" yang sama,
  // jadi bentuk datanya tidak berbeda; yang berbeda adalah sumbernya.
  //
  // Kalau keduanya gagal, `schedule` tetap berisi nilai kosong dan
  // panel menampilkan "Tidak ada jadwal hari ini" — bukan data basi
  // dari request yang sukses setengah.
  async function loadSchedule() {
    try {
      const data = await api.get("/api/schedule/");
      schedule = {
        entries: data.entries || [],
        conflicts: data.conflicts || [],
        today: data.today || null,
      };
    } catch (error) {
      console.warn("Jadwal gagal dimuat:", error);
    }
  }

  async function loadDocuments() {
    try {
      const data = await api.get("/api/rag/documents/");
      documents = data.documents || [];
    } catch (error) {
      console.warn("Dokumen RAG gagal dimuat:", error);
    }
  }

  async function loadNotifications() {
    // Daftar notifikasi dimiliki modul bersama — di sini cuma memicu
    // pemuatannya supaya modul itu yang punya array terbaru.
    await window.AkademiaNotifications?.load();
  }

  async function loadVideos() {
    try {
      const data = await api.get("/api/lecturer/videos/");
      videos = data.videos || [];
    } catch (error) {
      console.warn("Video ajar gagal dimuat:", error);
    }
  }

  // =====================================================
  // LAPORAN MINGGUAN (Dosen AI)
  // =====================================================

  /**
   * Muat laporan mingguan untuk widget dashboard.
   *
   * Widget ini menampilkan **periode terakhir** saja — laporan lengkap
   * ada di tab AI Lecturer. Yang ditampilkan di sini: rentang periode,
   * angka aktivitas, dan tombol unduh. Tanpa tombol unduh, widget ini
   * hanya informatif dan tidak memenuhi permintaan spec (§1.2) laporan
   * mingguan yang bisa diunduh.
   */
  async function loadReports() {
    try {
      const data = await api.get("/api/lecturer/reports/");
      reports = Array.isArray(data.reports) ? data.reports : [];
      // Backend tidak mengurutkan — terbaru dulu.
      reports.sort((a, b) =>
        String(b.period_start || "").localeCompare(String(a.period_start || ""))
      );
      reportsLoaded = true;
    } catch (error) {
      console.warn("Laporan mingguan gagal dimuat:", error);
      reportsError = error.message || "tidak diketahui";
    }
  }

  function reportPeriodLabel(report) {
    const start = formatWallClock(report.period_start);
    const end = formatWallClock(report.period_end);
    if (!start || !end) return "Periode tidak diketahui";
    return start + " — " + end;
  }

  /**
   * Ringkasan satu laporan untuk widget.
   *
   * Laporan baru membawa `summary_data` terstruktur; laporan lama (dan
   * laporan yang LLM-nya gagal) hanya punya angka dasar. Widget
   * menampilkan angka yang selalu ada, lalu menambah narasi/topik kalau
   * tersedia — bukan sebaliknya, supaya widget tidak pernah kosong
   * hanya karena LLM sedang tidak bisa dipakai.
   */
  function reportHighlights(report) {
    const data = report.summary_data || {};
    const highlights = [];

    if (data.total_lectures !== undefined) {
      highlights.push(data.total_lectures + " rekaman kuliah");
    }
    if (data.total_completed_tasks !== undefined) {
      highlights.push(data.total_completed_tasks + " tugas selesai");
    }
    if (data.schedule_entries !== undefined) {
      highlights.push(data.schedule_entries + " sesi jadwal");
    }

    const analysis = data.analysis || {};
    if (analysis.total_questions) {
      highlights.push(analysis.total_questions + " pertanyaan ke Dosen AI");
    }

    return highlights;
  }

  function reportRow(report) {
    const row = document.createElement("div");
    row.className = "dashboard-report-item";

    const main = document.createElement("div");
    main.className = "dashboard-report-main";

    const title = document.createElement("strong");
    title.textContent = reportPeriodLabel(report);
    main.append(title);

    const highlights = reportHighlights(report);
    if (highlights.length) {
      const meta = document.createElement("div");
      meta.className = "dashboard-report-meta";
      highlights.forEach((text) => {
        const span = document.createElement("span");
        span.textContent = text;
        meta.append(span);
      });
      main.append(meta);
    }

    // Narasi LLM — hanya satu kalimat pertama, supaya widget tetap
    // ringkas. Laporan lengkap ada di tab AI Lecturer.
    const narrative = (report.summary_data || {}).llm_summary?.activity;
    if (narrative) {
      const paragraph = document.createElement("p");
      paragraph.className = "dashboard-report-narrative";
      paragraph.textContent = String(narrative).slice(0, 220);
      main.append(paragraph);
    }

    const actions = document.createElement("div");
    actions.className = "dashboard-report-actions";

    const download = document.createElement("a");
    download.className = "dashboard-report-download";
    download.href =
      "/api/lecturer/reports/" + encodeURIComponent(report.id) + "/export/";
    download.setAttribute("download", "");
    download.title = "Unduh laporan (.docx)";
    download.innerHTML =
      '<span class="material-symbols-outlined">download</span>';

    actions.append(download);
    row.append(main, actions);
    return row;
  }

  function renderReportPanel() {
    const list = document.getElementById("dashboardReportList");
    const heading = document.querySelector("[data-report-panel-summary]");
    if (!list) return;

    if (heading) {
      if (reportsError) {
        heading.textContent = "Gagal dimuat — " + reportsError;
      } else if (!reportsLoaded) {
        heading.textContent = "Memuat laporan...";
      } else if (reports.length) {
        heading.textContent = "Periode terakhir: " + reportPeriodLabel(reports[0]);
      } else {
        heading.textContent = "Belum ada laporan mingguan";
      }
    }

    list.replaceChildren();

    if (reportsError) {
      list.append(
        panelEmpty(
          "cloud_off",
          "Laporan gagal dimuat",
          reportsError + " — tekan Muat Ulang untuk mencoba lagi.",
        ),
      );
      return;
    }

    if (!reportsLoaded) {
      list.append(
        panelEmpty("hourglass_empty", "Memuat laporan...", "Sebentar saja."),
      );
      return;
    }

    if (!reports.length) {
      list.append(
        panelEmpty(
          "summarize",
          "Belum ada laporan mingguan",
          "Laporan dibuat otomatis tiap minggu oleh worker. Buka Dosen AI untuk membuat sekarang.",
        ),
      );
      return;
    }

    // Hanya 3 laporan terakhir — widget untuk sekilas, bukan arsip.
    reports.slice(0, 3).forEach((report) => list.append(reportRow(report)));
  }

  async function loadAll() {
    // Render per-pasangan, bukan sekali di akhir. Kalau menunggu semua
    // request selesai dulu, satu endpoint lambat (mis. /api/lecturer/videos/
    // yang butuh ~2 detik) menahan SELURUH halaman — panel tugas, jadwal,
    // badge, semuanya tetap kosong selama itu. Render begitu datanya
    // tiba supaya tiap bagian muncul secepat mungkin.
    renderTaskPanel();

    // Ringkasan dan jadwal sengaja TIDAK dimuat paralel.
    //
    // Keduanya mengembalikan jadwal, dan keduanya bisa menulis ke state
    // yang sama. Kalau paralel, yang selesai terakhir menang — hasilnya
    // panel bisa menampilkan jadwal dari satu request sementara hero
    // menampilkan hitungan dari request yang lain.
    //
    // Urutannya: ringkasan dulu (sumber tunggal, sudah berisi jadwal).
    // /api/schedule/ cuma dipanggil kalau ringkasan gagal.
    await Promise.all([
      loadSummary().finally(() => {
        renderTaskPanel();
        renderSchedulePanel();
      }),
      loadTasks().then(() => {
        renderSummary();
        renderBadges();
        renderProcessButton();
        renderWorkerQueue();
      }),
      loadDocuments().then(() => {
        renderSummary();
        renderWorkerQueue();
      }),
      loadNotifications(),
      loadVideos().then(() => {
        renderSummary();
        renderWorkerQueue();
      }),
      loadReports().then(() => {
        renderReportPanel();
      }),
    ]);

    // Fallback jadwal — hanya kalau ringkasan tidak berhasil.
    if (!summaryLoaded) {
      await loadSchedule();
    }

    renderSummary();
    renderBadges();
    renderProcessButton();
    renderWorkerQueue();
    renderTaskPanel();
    renderSchedulePanel();
    renderReportPanel();
  }

  renderDate();
  wirePrompt();
  wireUpload();
  wireCreateMaterial();
  wireFeatureButtons();
  wireRefresh();
  wireUnavailable();
  wireVoiceStt();
  // Notifikasi (panel + polling peramban) dipasang oleh modul bersama
  // ``notifications.js`` — lonceng dan panelnya ada di base.html, jadi
  // modul yang sama dipakai halaman Reminder System juga.
  window.AkademiaNotifications?.mount();
  subscribeToTaskSnapshot();
  loadAll();
});
