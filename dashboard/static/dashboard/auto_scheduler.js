document.addEventListener("DOMContentLoaded", () => {
  "use strict";

  const $ = (selector, parent = document) => parent.querySelector(selector);

  const $$ = (selector, parent = document) =>
    Array.from(parent.querySelectorAll(selector));

  const toast = $("#schedulerToast");
  const weekGrid = $("#weekGrid");
  const weekLabel = $("#weekLabel");
  const filter = $("#calendarFilter");
  const materialModal = $("#materialModal");

  let currentDate = new Date();
  let activeSchedule = null;
  let toastTimeout = null;

  // =====================================================
  // DATA JADWAL (dari backend FastAPI lewat /api/schedule/)
  // =====================================================

  // Entri jadwal mentah dari backend, dipakai ulang saat render ulang
  // (week navigation, filter, refresh setelah create/delete).
  let scheduleEntries = [];

  // Status pemuatan jadwal: belum pernah dimuat / sedang memuat / sudah
  // pernah dimuat / gagal memuat.
  //
  // Tanpa ini, `renderConflicts([])` dan "Belum ada jadwal" tampil
  // selama request berjalan — padahal kita belum tahu apakah ada
  // bentrok atau tidak. User mengira jadwalnya bersih.
  let scheduleLoaded = false;
  let scheduleLoading = false;
  let scheduleError = null;
  // Konflik terakhir yang berhasil dimuat — disimpan supaya render ulang
  // saat reload tidak menghilangkan daftar yang sedang ditampilkan.
  let scheduleConflicts = [];

  // Entri yang sudah dipetakan ke bentuk kalender. Render ulang memakai
  // array ini, jadi tiap render tidak memetakan ulang data mentah.
  let schedules = [];

  // Dokumen terindeks dari /api/rag/documents/ — dipakai untuk daftar
  // berkas pada modal detail materi.
  let indexedDocuments = [];

  // Tugas dari /api/tasks/ — dipakai untuk tab "Tugas & Kuis" dan kartu
  // deadline di kolom kanan.
  let taskItems = [];

  // Daftar mata kuliah yang diambil dari /api/schedule/courses/ — untuk
  // pemilih mata kuliah pada form tambah jadwal dan form import.
  let courseOptions = [];

  // Dokumen dari /api/library/documents/ — daftar berkas perpustakaan
  // (KRS & referensi) dengan tombol hapus.
  let libraryDocuments = [];

  // Job import jadwal yang sedang dipolling (id dari backend). null =
  // tidak ada proses import yang sedang berjalan.
  let activeImportJobId = null;

  // Timer polling status import. Disimpan supaya polling bisa dihentikan
  // sebelum dimulai lagi (kalau user klik import dua kali).
  let importPollTimer = null;

  // =====================================================
  // HTTP
  // =====================================================

  // Klien API bersama (dashboard/api.js). Semua request lewat sini.
  //
  // Helper lokal (`getJson`/`postJson`/...) di bawah cuma **nama lain**
  // untuk fungsi yang sama — sengaja dipertahankan supaya call site tidak
  // berubah semua. Yang berubah: request tidak lagi `fetch` mentah, tapi
  // lewat `api.js` yang sudah menangani header CSRF, error, dan batas
  // waktu.
  //
  // Guard `if (!api) return;` itu wajib: baris ini ada di top-level
  // handler ``DOMContentLoaded``, jadi lempar di sini mematikan **seluruh**
  // handler — kalender, form, modal, dan toast ikut hilang.
  const api = window.AkademiaApi;

  if (!api) {
    showToast("Modul API gagal dimuat — halaman tidak bisa memuat data.");
    return;
  }

  const getJson = (url) => api.get(url);

  const postJson = (url, body) => api.post(url, body);

  const patchJson = (url, body) => api.patch(url, body);

  const deleteJson = (url) => api.del(url);

  // =====================================================
  // TOAST
  // =====================================================

  function showToast(message) {
    if (!toast) {
      console.info(message);
      return;
    }

    toast.textContent = message;
    toast.classList.add("show");

    clearTimeout(toastTimeout);

    toastTimeout = setTimeout(() => {
      toast.classList.remove("show");
    }, 3000);
  }

  // =====================================================
  // UTILITAS
  // =====================================================

  function setText(id, value) {
    const element = document.getElementById(id);

    if (element) {
      element.textContent =
        value !== undefined && value !== null && value !== "" ? value : "-";
    }
  }

  function getMonday(date) {
    const monday = new Date(date);
    const day = monday.getDay();

    monday.setDate(monday.getDate() + (day === 0 ? -6 : 1 - day));

    monday.setHours(0, 0, 0, 0);

    return monday;
  }

  // Satu definisi untuk seluruh halaman — lihat
  // ``dashboard/datetime_utils.js``. Helper tanggal/waktu ini tadinya
  // ditulis ulang di lima file JavaScript; tiap salinan sedikit
  // berbeda, jadi begitu satu salah, perbaikannya harus di lima tempat.
  //
  // **Jangan destructure langsung.** Kalau modul ini gagal dimuat,
  // ``window.AkademiaDateTime`` jadi ``undefined`` dan destructure dari
  // situ melempar error — dan karena baris ini ada di top-level handler
  // ``DOMContentLoaded``, **seluruh** handler mati: kalender, daftar
  // tugas, dan form tambah jadwal ikut hilang.
  //
  // Default per helper supaya pemanggilnya tetap dapat bekerja kalau
  // modulkya absen — nilainya "saya tidak tahu", bukan angka tebakan.
  // `parseNaiveDateTime` → `null` penting: `mapEntry()` memeriksa
  // hasilnya dengan `if (start)`, jadi `null` aman, sedangkan string
  // kosong akan lolos ke `start.getDay()` dan melempar.
  //
  // Fallback inline **sengaja tidak menyalin logika**: menyalin helper
  // tanggal/waktu ke lima file persis masalah yang modul ini hilangkan.
  const dateTime = window.AkademiaDateTime || {};
  const {
    formatDate = (date) =>
      date.toLocaleDateString("id-ID", { day: "numeric", month: "short" }),
    formatLongDate = (date) =>
      date.toLocaleDateString("id-ID", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      }),
    parseNaiveDateTime = () => null,
    formatClock = () => "--:--",
    naiveDateTime = () => "",
    formatTaskDeadline = (value) => (value ? String(value) : "-"),
    formatDuration = (seconds) =>
      Number.isFinite(Number(seconds)) && Number(seconds) >= 0
        ? `${String(Math.floor(Number(seconds) / 60)).padStart(2, "0")}:${String(
            Math.floor(Number(seconds) % 60),
          ).padStart(2, "0")}`
        : "-",
  } = dateTime;

  function escapeHTML(value) {
    return String(value ?? "").replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[character],
    );
  }

  // =====================================================
  // PETA ENTRY BACKEND → BENTUK KALENDER
  // =====================================================

  // "HH:MM" -> menit sejak tengah malam. Dipakai untuk menghitung slot
  // kosong pada optimizer jadwal.
  function toMinutes(clock) {
    const match = /(\d{2}):(\d{2})/.exec(String(clock || ""));
    if (!match) return NaN;
    return Number(match[1]) * 60 + Number(match[2]);
  }

  // Backend tidak punya field "tipe kegiatan"; hanya ada mata kuliah.
  // Jenis diturunkan dari judul/nama mata kuliah supaya filter kalender
  // dan kelas warna (event-kuliah / event-praktikum / event-responsi)
  // tetap punya isi.
  function guessType(title, courseName) {
    const haystack = `${title || ""} ${courseName || ""}`.toLowerCase();

    if (/praktikum|\blab\b|penggunaan/.test(haystack)) return "praktikum";
    if (/responsi|ujian|kuis/.test(haystack)) return "responsi";

    return "kuliah";
  }

  function findCourse(courseId) {
    if (!courseId) return null;

    return courseOptions.find((course) => course.id === courseId) || null;
  }

  // Ubah entri backend menjadi bentuk yang dipakai renderCalendar() dan
  // openMaterialDetail(). Field "day" tetap 0=Senin..6=Minggu agar
  // konsisten dengan getMonday() dan kolom kalender.
  function mapEntry(entry) {
    const start = parseNaiveDateTime(entry.start_time);
    const end = parseNaiveDateTime(entry.end_time);

    const course = findCourse(entry.course_id);

    const code = course?.code || entry.course_id || "";
    const title = entry.title || "Tanpa judul";

    // day_of_week backend: 0=Senin .. 6=Minggu. Kalau tidak diisi, ambil
    // dari tanggal awal entri.
    const day =
      entry.day_of_week === null || entry.day_of_week === undefined
        ? start
          ? (start.getDay() + 6) % 7
          : 0
        : Number(entry.day_of_week);

    // **Hanya** ``is_recurring`` yang menentukan berulang atau sekali
    // pakai.
    //
    // Sebelumnya `day_of_week !== null` ikut jadi sinyal berulang.
    // Itu keliru: entri sekali pakai juga punya hari (dihitung dari
    // tanggal mulainya), jadi entri yang cuma terjadi sekali — atau
    // yang sengaja dibedakan dari jadwal mingguan — ikut tampil di
    // SETIAP minggu. Di kalender, entri seperti itu muncul di minggu
    // yang tidak pernah ada, dan bentrok dengan entri lain di
    // minggu itu tidak pernah dilaporkan.
    //
    // Backend menormalkan hal yang sama (lihat ``normalize_recurrence``
    // di app/core/calendar.py): entri sekali pakai disimpan dengan
    // ``day_of_week`` kosong. Kalau backend-nya lama dan masih
    // menyimpan kombinasi itu, entri dianggap berulang — sama seperti
    // perilaku backend, jadi panel dan kalender tidak berbeda pendapat.
    const recurring = Boolean(entry.is_recurring);

    // Judul yang sudah diawali kode mata kuliah tidak perlu diulang.
    const detail =
      code && title.toLowerCase().startsWith(code.toLowerCase())
        ? title.slice(code.length).replace(/^[\s—–-]+/, "").trim() || title
        : title;

    return {
      id: entry.id,
      courseId: entry.course_id || "",
      day,
      start: formatClock(entry.start_time),
      end: formatClock(entry.end_time),
      name: code || title,
      detail,
      type: guessType(title, course?.name),
      room: entry.location || "",
      code,
      lecturer: course?.professor || "Belum ditentukan",
      topic: title,
      description: entry.description || "",
      summary: entry.description || "",
      files: [],
      // Tanggal asli untuk entri sekali Pakai (dipakai ekspor ICS).
      date: recurring || !start ? null : start,
      recurring,
    };
  }

  // =====================================================
  // RENDER KALENDER
  // =====================================================

  function isSameWeek(date, monday) {
    if (!date) return true;

    const weekStart = new Date(monday);
    weekStart.setHours(0, 0, 0, 0);

    const target = new Date(date);
    target.setHours(0, 0, 0, 0);

    const diff = Math.round((target - weekStart) / 86400000);

    return diff >= 0 && diff < 7;
  }

  function renderCalendar() {
    if (!weekGrid) {
      console.error("Elemen #weekGrid tidak ditemukan.");
      return;
    }

    const monday = getMonday(currentDate);
    const friday = new Date(monday);

    friday.setDate(monday.getDate() + 4);

    if (weekLabel) {
      weekLabel.textContent = `${formatDate(monday)} – ${formatDate(friday)} ${friday.getFullYear()}`;
    }

    const dayNames = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat"];

    weekGrid.replaceChildren();

    dayNames.forEach((dayName, index) => {
      const date = new Date(monday);
      date.setDate(monday.getDate() + index);

      const isToday = date.toDateString() === new Date().toDateString();

      const dayColumn = document.createElement("div");
      dayColumn.className = `scheduler-day${isToday ? " today" : ""}`;

      const header = document.createElement("div");
      header.className = "scheduler-day-header";
      header.textContent = `${dayName}, ${date.getDate()}`;

      dayColumn.appendChild(header);

      schedules
        .filter((schedule) => {
          const matchesDay = schedule.day === index;

          // Entri berulang muncul tiap minggu; entri sekali Pakai hanya
          // di minggu yang sama dengan tanggalnya.
          const matchesWeek = schedule.recurring
            ? true
            : isSameWeek(schedule.date, monday);

          const matchesFilter =
            !filter || filter.value === "all" || schedule.type === filter.value;

          return matchesDay && matchesWeek && matchesFilter;
        })
        .sort((a, b) => a.start.localeCompare(b.start))
        .forEach((schedule) => {
          const event = document.createElement("button");

          event.type = "button";
          event.className = `scheduler-event event-${schedule.type}`;

          event.setAttribute(
            "aria-label",
            `Buka detail ${schedule.name}: ${schedule.detail}`,
          );

          const title = document.createElement("strong");
          title.textContent = schedule.name;

          const time = document.createElement("span");
          time.textContent = `${schedule.start}–${schedule.end}`;

          const detail = document.createElement("span");
          detail.textContent = schedule.detail;

          event.append(title, time, detail);

          event.addEventListener("click", () => {
            openMaterialDetail(schedule, date);
          });

          dayColumn.appendChild(event);
        });

      weekGrid.appendChild(dayColumn);
    });
  }

  // =====================================================
  // RENDER BENTROK
  // =====================================================

  // Bentrok dihitung backend saat request, bentuknya:
  //   {entry1_id, entry2_id, entry1_title, entry2_title,
  //    type: "location_conflict"|"time_overlap",
  //    severity: "error"|"warning", message}
  const CONFLICT_TYPE_LABEL = {
    location_conflict: "Bentrok lokasi",
    time_overlap: "Irisan waktu",
  };

  function renderConflicts(conflicts) {
    const list = $("#conflictList");
    const badge = $("#conflictBadge");

    const items = Array.isArray(conflicts) ? conflicts : [];

    // Selama request berjalan, konflik belum diketahui — jangan tampilkan
    // "Tidak ada konflik" dulu, itu klaim yang belum terbukti benar.
    const pending = scheduleLoading || (!scheduleLoaded && !scheduleError);

    if (badge) {
      badge.textContent = pending
        ? "Memuat..."
        : items.length
          ? `${items.length} Konflik`
          : "Tidak ada konflik";

      badge.classList.toggle("scheduler-warning-badge-error", items.some(
        (conflict) => conflict.severity === "error",
      ));
    }

    const errorCount = items.filter((c) => c.severity === "error").length;
    const warningCount = items.length - errorCount;

    setText(
      "conflictCount",
      pending ? "—" : items.length ? `${items.length} Konflik` : "Tidak ada",
    );

    setText(
      "conflictNote",
      pending
        ? "Memuat jadwal..."
        : items.length
          ? `${errorCount} error, ${warningCount} peringatan`
          : "Tidak perlu ditinjau",
    );

    if (!list) return;

    list.replaceChildren();

    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "scheduler-empty";
      empty.textContent = pending
        ? "Memuat jadwal..."
        : "Tidak ada bentrok pada jadwal saat ini.";
      list.appendChild(empty);
      return;
    }

    items.forEach((conflict) => {
      const isError = conflict.severity === "error";

      const item = document.createElement("div");
      item.className = `scheduler-conflict-item ${isError ? "error" : "warning"}`;

      const head = document.createElement("div");
      head.className = "scheduler-conflict-head";

      const severity = document.createElement("span");
      severity.className = `scheduler-severity ${isError ? "error" : "warning"}`;
      severity.textContent = isError ? "Error" : "Peringatan";

      const type = document.createElement("span");
      type.className = "scheduler-conflict-type";
      type.textContent =
        CONFLICT_TYPE_LABEL[conflict.type] || conflict.type || "Konflik";

      head.append(severity, type);

      const message = document.createElement("p");
      message.className = "scheduler-conflict-message";
      // Pesan dari backend sudah berupa kalimat; tetap di-escape karena
      // judul entri bisa berisi karakter HTML.
      message.innerHTML = escapeHTML(
        conflict.message ||
          `${conflict.entry1_title} dan ${conflict.entry2_title}`,
      );

      const pair = document.createElement("p");
      pair.className = "scheduler-conflict-pair";
      pair.textContent = `${conflict.entry1_title || "?"} ↔ ${conflict.entry2_title || "?"}`;

      item.append(head, message, pair);

      list.appendChild(item);
    });
  }

  // =====================================================
  // MATA KULIAH
  // =====================================================

  function renderCourseOptions() {
    // "#materialCourseSelect" ikut diisi supaya koreksi tag manual di
    // modal detail bisa memakai daftar mata kuliah yang sama.
    ["#entryCourse", "#importCourse", "#materialCourseSelect"].forEach((selector) => {
      const select = $(selector);

      if (!select) return;

      // Pertahankan pilihan pengguna saat daftar dimuat ulang.
      const previous = select.value;

      select.replaceChildren();

      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "Tanpa mata kuliah";
      select.appendChild(empty);

      courseOptions.forEach((course) => {
        const option = document.createElement("option");
        option.value = course.id;
        option.textContent = course.code
          ? `${course.code} — ${course.name}`
          : course.name || course.id;
        select.appendChild(option);
      });

      if (previous) select.value = previous;
    });

    setText(
      "courseCount",
      courseOptions.length ? `${courseOptions.length} mata kuliah` : "0",
    );

    setText(
      "courseCountNote",
      courseOptions.length
        ? `${courseOptions.reduce(
            (total, course) => total + (Number(course.credits) || 0),
            0,
          )} SKS terdaftar`
        : "Belum ada mata kuliah",
    );
  }

  // =====================================================
  // MUAT DATA DARI BACKEND
  // =====================================================

  async function loadCourses() {
    try {
      const data = await getJson("/api/schedule/courses/");

      courseOptions = Array.isArray(data.courses) ? data.courses : [];

      renderCourseOptions();
    } catch (error) {
      console.error("gagal memuat mata kuliah:", error);

      setText("courseCount", "Gagal memuat");
      setText("courseCountNote", error.message);
    }
  }

  async function loadSchedule(options = {}) {
    const { silent = false } = options;

    // Tandai sedang memuat SEBELUM request, lalu render ulang supaya panel
    // konflik tidak sempat menampilkan "Tidak ada bentrok" (dan kartu
    // "Belum ada jadwal") yang belum tentu benar.
    scheduleLoading = true;
    scheduleError = null;
    renderConflicts(scheduleConflicts);

    try {
      const data = await getJson("/api/schedule/");

      scheduleEntries = Array.isArray(data.entries) ? data.entries : [];

      schedules = scheduleEntries.map(mapEntry);
      scheduleConflicts = Array.isArray(data.conflicts) ? data.conflicts : [];
      scheduleLoaded = true;

      renderCalendar();
      renderConflicts(scheduleConflicts);

      // Jumlah hari efektif = jumlah hari unik yang punya jadwal.
      const days = new Set(schedules.map((schedule) => schedule.day));

      setText("effectiveDayCount", `${days.size} Hari`);
      setText(
        "effectiveDayNote",
        schedules.length
          ? `${schedules.length} kegiatan terdaftar`
          : "Belum ada jadwal",
      );

      if (!silent) {
        showToast(
          schedules.length
            ? `${schedules.length} jadwal dimuat.`
            : "Belum ada jadwal tersimpan.",
        );
      }

      return true;
    } catch (error) {
      console.error("gagal memuat jadwal:", error);

      scheduleError = error.message || "tidak diketahui";

      setText("conflictCount", "Gagal memuat");
      setText("conflictNote", scheduleError);

      if (!silent) showToast(error.message);

      return false;
    } finally {
      scheduleLoading = false;
      renderConflicts(scheduleConflicts);
    }
  }

  // =====================================================
  // FILE MATERI
  // =====================================================

  // Berkas pada modal detail materi diambil dari dokumen yang SUDAH terindeks
  // di backend (/api/rag/documents/), bukan dari daftar contoh di template.
  function renderMaterialFiles() {
    const container = $("#materialFiles");
    if (!container) return;

    container.replaceChildren();

    if (!indexedDocuments.length) {
      const empty = document.createElement("p");
      empty.className = "material-empty";
      empty.textContent =
        "Belum ada berkas terindeks. Unggah berkas lewat RAG Assistant agar bisa dicari.";
      container.appendChild(empty);
      setText("materialFileStatus", "Belum ada berkas");
      return;
    }

    indexedDocuments.forEach((doc) => {
      const item = document.createElement("div");
      item.className = "material-file";

      const icon = document.createElement("div");
      const isPdf = String(doc.fileType || "").toLowerCase() === "pdf";

      icon.className = `file-icon ${isPdf ? "red" : "purple"}`;
      icon.textContent = isPdf ? "▤" : "▣";

      const info = document.createElement("div");
      info.className = "file-info";

      const name = document.createElement("strong");
      name.textContent = doc.fileName || "Berkas";

      // Status indexing + jumlah potongan - angka dari backend, bukan teks tetap.
      const description = document.createElement("small");
      const parts = [];
      if (doc.status) parts.push(`Status: ${doc.status}`);
      if (doc.chunksCount) parts.push(`${doc.chunksCount} chunks`);
      if (doc.fileSize) {
        parts.push(`${Math.max(1, Math.round(doc.fileSize / 1024))} KB`);
      }
      description.textContent = parts.join(" • ") || "Berkas materi";

      info.append(name, description);

      const action = document.createElement("button");
      action.type = "button";
      action.className = "file-action";
      action.textContent = "Tanyakan";

      // Tombol ini mengisi kotak pertanyaan RAG dengan nama berkas, lalu
      // menjalankan query - jadi berkas ini benar-benar bisa dicari.
      action.addEventListener("click", () => {
        const question = `Jelaskan isi berkas "${doc.fileName || "ini"}"`;
        const input = $("#materialChatInputPreview");
        if (input) input.value = question;
        askRag(question, "preview");
      });

      item.append(icon, info, action);
      container.appendChild(item);
    });

    // Status berkas di judul bagian - dihitung dari data yang sama.
    const status = $("#materialFileStatus");
    if (status) {
      const indexed = indexedDocuments.filter(
        (doc) => doc.status === "indexed",
      ).length;
      status.textContent = `${indexed} dari ${indexedDocuments.length} berkas siap RAG`;
    }
  }

  // =====================================================
  // DETAIL MATERI
  // =====================================================

  function showOverviewSections(show) {
    const leftColumn = $(".material-left-column");
    if (!leftColumn) return;

    [
      ".material-topic-card",
      ".material-left-column > .material-section",
      ".material-summary-card",
    ].forEach((selector) => {
      $$(selector, leftColumn).forEach((element) => {
        element.hidden = !show;
      });
    });
  }

  function switchMaterialTab(tabName) {
    $$(".material-tab").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.tab === tabName);
    });

    // Bagian overview di HTML berupa beberapa card terpisah.
    showOverviewSections(tabName === "overview");

    // Panel notes, assignments, dan AI.
    $$(".material-tab-panel").forEach((panel) => {
      panel.hidden = panel.id !== `panel-${tabName}`;
    });

    // Tab RAG berada di kolom kanan dan tetap ditampilkan.
    // Form Tanya Dokumen di kanan merupakan preview terpisah.
  }

  function openMaterialDetail(schedule, selectedDate = null) {
    if (!materialModal) {
      showToast("Modal detail materi tidak ditemukan.");
      console.error("Periksa elemen #materialModal pada HTML.");
      return;
    }

    activeSchedule = schedule;

    const date =
      selectedDate ||
      (() => {
        const monday = getMonday(currentDate);
        monday.setDate(monday.getDate() + schedule.day);
        return monday;
      })();

    setText(
      "materialTitle",
      `${schedule.code || schedule.name} — ${schedule.detail}`,
    );

    setText(
      "materialType",
      schedule.type === "kuliah"
        ? "Kuliah Teori Wajib"
        : schedule.type === "praktikum"
          ? "Praktikum"
          : "Responsi",
    );

    setText("materialMeeting", `● ${formatLongDate(date)}`);

    setText(
      "materialTime",
      `◷ ${formatLongDate(date)}, ${schedule.start}–${schedule.end} WIB`,
    );

    setText("materialRoom", `⌖ ${schedule.room || "Ruangan belum tersedia"}`);

    setText("materialLecturer", schedule.lecturer || "Belum ditentukan");

    setText(
      "materialLecturerAvatar",
      (schedule.lecturer || schedule.name)
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((word) => word[0])
        .join("")
        .toUpperCase(),
    );

    setText("materialCode", schedule.code || schedule.name);
    setText("materialTopic", schedule.topic || schedule.detail);
    setText(
      "materialDescription",
      schedule.description || "Belum ada deskripsi materi.",
    );

    // Koreksi tag manual: isi picker dengan mata kuliah yang sedang
    // tertaut (bisa kosong kalau auto-tag tidak menemukan kecocokan).
    const courseSelect = $("#materialCourseSelect");

    if (courseSelect) {
      courseSelect.value = schedule.courseId || "";
      setText(
        "materialTagNote",
        schedule.courseId
          ? "Tag saat ini sudah terhubung ke sebuah mata kuliah. Pilih lain lalu tekan \"Simpan Tag\" untuk mengoreksi."
          : "Entri ini belum tertaut ke mata kuliah. Auto-tag tidak menemukan kecocokan — pilih sendiri lalu tekan \"Simpan Tag\".",
      );
    }

    setText(
      "materialSummary",
      schedule.summary || "Belum ada ringkasan materi.",
    );

    // Tugas & deadline tidak lagi diambil dari entri jadwal (backend tidak
    // punya field itu) — melainkan dari daftar tugas backend, yang di-render
    // oleh renderAssignmentList() dan renderDeadlineCard().
    renderAssignmentList(schedule.courseId);

    const [startHour, startMinute] = schedule.start.split(":").map(Number);

    const [endHour, endMinute] = schedule.end.split(":").map(Number);

    const durationMinutes =
      endHour * 60 + endMinute - (startHour * 60 + startMinute);

    setText(
      "materialDuration",
      durationMinutes > 0 ? `${durationMinutes / 60} jam` : "-",
    );

    setText("materialCategory", schedule.type);

    renderMaterialFiles();

    // Reset isi chat demo setiap membuka jadwal.
    const messages = $("#materialChatMessages");
    if (messages) {
      messages.replaceChildren();

      const welcome = document.createElement("div");
      welcome.className = "material-chat-bubble";
      welcome.textContent = `Halo! Silakan tanyakan sesuatu tentang ${schedule.detail}.`;

      messages.appendChild(welcome);
    }

    const chatInput = $("#materialChatInput");
    if (chatInput) chatInput.value = "";

    const previewInput = $("#materialChatInputPreview");
    if (previewInput) previewInput.value = "";

    switchMaterialTab("overview");

    // Tombol hapus hanya tampil untuk entri yang benar-benar tersimpan
    // di backend (punya id).
    const deleteButton = $("#deleteScheduleEntry");

    if (deleteButton) {
      deleteButton.hidden = !schedule.id;
      deleteButton.disabled = false;
    }

    materialModal.hidden = false;
    materialModal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";

    // Beri tahu catatan_kuliah.js entri mana yang aktif, supaya textarea
    // catatan dan rangkuman terisi dari backend. Tanpa event ini, catatan
    // tidak pernah tampil padahal datanya ada di backend.
    window.dispatchEvent(
      new CustomEvent("akademia:schedule-active", {
        detail: { entryId: schedule.id || null, schedule },
      }),
    );

    $("#closeMaterial")?.focus();
  }

  function closeMaterialDetail() {
    if (!materialModal) return;

    materialModal.hidden = true;
    materialModal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    activeSchedule = null;
  }

  // =====================================================
  // TOMBOL MODAL DAN TAB
  // =====================================================

  $("#closeMaterial")?.addEventListener("click", closeMaterialDetail);

  $("#closeMaterialFooter")?.addEventListener("click", closeMaterialDetail);

  materialModal?.addEventListener("click", (event) => {
    if (event.target === materialModal) {
      closeMaterialDetail();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && materialModal && !materialModal.hidden) {
      closeMaterialDetail();
    }
  });

  $$(".material-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      switchMaterialTab(tab.dataset.tab);
    });
  });

  // =====================================================
  // CATATAN DAN RANGKUMAN
  // =====================================================

  // Catatan kuliah dan rangkuman ujian disimpan ke field ``description``
  // entri jadwal. Keduanya dipegang catatan_kuliah.js — file itu menulis
  // keduanya dalam satu PATCH, jadi tidak saling menimpa.
  //
  // Tombol "Simpan ke Rangkuman Ujian" (#saveMaterialSummary) memakai handler
  // yang sama: dia hanya memicu tombol simpan utama, jadi tidak ada dua
  // tempat yang menulis field yang sama.
  $("#saveMaterialSummary")?.addEventListener("click", () => {
    const summary = $("#materialSummaryText")?.value.trim();

    if (!summary) {
      showToast("Rangkuman masih kosong.");
      return;
    }

    if (!activeSchedule || !activeSchedule.id) {
      showToast(
        "Jadwal ini belum tersimpan di backend, jadi rangkuman tidak bisa disimpan.",
      );
      return;
    }

    $("#lnSave")?.click();
  });

  // =====================================================
  // TANYA DOKUMEN (RAG) - backend sungguhan
  // =====================================================

  // Placeholder yang dipakai untuk menampilkan jawaban RAG di modal.
  // Dua tampilan: "chat" (kolom kiri, gelembung) dan "preview" (kolom kanan,
  // satu blok teks).
  function setRagAnswer(answer, sources, confidence, target) {
    const heading = $(
      target === "preview" ? "#materialRagHeadingPreview" : "#materialRagHeading",
    );
    const sourceNote = $(
      target === "preview"
        ? "#materialRagSourcesPreview"
        : "#materialRagSources",
    );
    const verified = $(
      target === "preview"
        ? "#materialRagVerifiedPreview"
        : "#materialRagVerified",
    );

    // Skorsimilarity dari backend, kalau ada.
    const score = Number(confidence);
    if (heading) {
      heading.textContent = Number.isFinite(score) && score > 0
        ? `✧ Jawaban RAG (Similarity: ${score.toFixed(2)})`
        : "✧ Jawaban RAG";
    }

    if (target === "preview") {
      const body = $("#materialRagAnswerPreview");
      if (body) body.textContent = answer || "Tidak ada jawaban.";
    } else {
      const messages = $("#materialChatMessages");
      if (messages) {
        messages.replaceChildren();
        const bubble = document.createElement("div");
        bubble.className = "material-chat-bubble";
        bubble.textContent = answer || "Tidak ada jawaban.";
        messages.appendChild(bubble);
      }
    }

    // Rujukan sumber - dari chunk RAG yang dipakai backend.
    if (sourceNote) {
      const names = (sources || [])
        .map((source) => source.fileName || source.title || source.documentId)
        .filter(Boolean);
      sourceNote.textContent = names.length
        ? `⌁ ${names.join(" • ")}`
        : "Tidak ada sumber dokumen yang cocok.";
    }

    // Badge "Terverifikasi Silabus" hanya tampil kalau benar-benar ada sumber.
    if (verified) verified.hidden = !(sources || []).length;
  }

  async function askRag(question, target = "preview") {
    if (!question) return;

    const pending = $(
      target === "preview" ? "#materialRagAnswerPreview" : "#materialChatMessages",
    );
    if (pending) {
      if (target === "preview") {
        pending.textContent = "Mencari jawaban...";
      } else {
        pending.replaceChildren();
        const bubble = document.createElement("div");
        bubble.className = "material-chat-bubble";
        bubble.textContent = "Mencari jawaban...";
        pending.appendChild(bubble);
      }
    }

    try {
      const data = await postJson("/api/rag/query/", {
        question,
        n_results: 5,
      });

      setRagAnswer(data.answer, data.sources, data.confidence, target);
    } catch (error) {
      if (pending) {
        if (target === "preview") {
          pending.textContent = error.message;
        } else {
          pending.replaceChildren();
          const bubble = document.createElement("div");
          bubble.className = "material-chat-bubble";
          bubble.textContent = error.message;
          pending.appendChild(bubble);
        }
      }
      showToast(error.message);
    }
  }

  function handleChatSubmit(event, inputSelector, target) {
    event.preventDefault();

    const input = $(inputSelector);
    if (!input) return;

    const question = input.value.trim();
    if (!question) return;

    input.value = "";
    askRag(question, target);
  }

  $("#materialChatForm")?.addEventListener("submit", (event) => {
    handleChatSubmit(event, "#materialChatInput", "chat");
  });

  $("#materialChatFormPreview")?.addEventListener("submit", (event) => {
    handleChatSubmit(event, "#materialChatInputPreview", "preview");
  });

  // Pertanyaan saran pada kartu RAG.
  $$(".material-suggestions button").forEach((button) => {
    button.addEventListener("click", () => {
      const question = button.textContent.replace(/^⚡\s*/, "").trim();

      const input = $("#materialChatInputPreview");

      if (input) {
        input.value = question;
        input.focus();
      } else {
        showToast(`Pertanyaan dipilih: ${question}`);
      }
    });
  });

  // =====================================================
  // NAVIGASI KALENDER
  // =====================================================

  filter?.addEventListener("change", renderCalendar);

  $("#previousWeek")?.addEventListener("click", () => {
    currentDate.setDate(currentDate.getDate() - 7);
    renderCalendar();
  });

  $("#nextWeek")?.addEventListener("click", () => {
    currentDate.setDate(currentDate.getDate() + 7);
    renderCalendar();
  });

  $("#todayBtn")?.addEventListener("click", () => {
    currentDate = new Date();
    renderCalendar();
  });

  // =====================================================
  // SINKRONISASI JADWAL DARI WEB KAMPUS
  // =====================================================

  // Backend punya endpoint POST /schedule/import — worker mengambil jadwal
  // dari URL kampus di latar belakang. Jadi "Sinkron" bukan simulasi: ia
  // benar-benar memicu scraping.
  $("#syncSiam")?.addEventListener("click", async () => {
    const button = $("#syncSiam");
    const url = $("#importUrl")?.value.trim();

    if (!url) {
      showToast("Isi URL sumber jadwal terlebih dahulu.");
      $("#importUrl")?.focus();
      return;
    }

    if (button) button.disabled = true;
    setText("portalStatus", "Mengambil jadwal...");

    try {
      const data = await postJson("/api/schedule/import/", { url });
      const taskNote = data.task_id ? ` (task ${data.task_id})` : "";

      setText("portalStatus", "Sinkronisasi dijalankan");
      setText("lastSync", new Date().toLocaleTimeString("id-ID"));

      showToast(
        `Sinkronisasi dimulai${taskNote}. Worker berjalan di latar belakang — tekan "Muat ulang" untuk melihat hasil.`,
      );
    } catch (error) {
      setText("portalStatus", "Sinkronisasi gagal");
      showToast(error.message);
    } finally {
      if (button) button.disabled = false;
    }
  });

  $("#rescrapeBtn")?.addEventListener("click", async () => {
    const button = $("#rescrapeBtn");
    const url = $("#importUrl")?.value.trim();

    if (!url) {
      showToast("Isi URL sumber jadwal terlebih dahulu.");
      return;
    }

    if (button) button.disabled = true;

    try {
      await postJson("/api/schedule/import/", { url });
      showToast("Pengambilan ulang dijadwalkan. Tekan \"Muat ulang\" setelah job selesai.");
    } catch (error) {
      showToast(error.message);
    } finally {
      if (button) button.disabled = false;
    }
  });

  // =====================================================
  // UPLOAD KRS
  // =====================================================

  // Unggah KRS PDF. Backend punya POST /documents/upload — berkas disimpan di
  // perpustakaan dokumen, dan bisa diproses OCR (POST /documents/<id>/ocr)
  // supaya isinya bisa dicari lewat RAG.
  $("#krsFile")?.addEventListener("change", async (event) => {
    const input = event.target;
    const file = input.files?.[0];
    if (!file) return;

    setText("fileName", `Mengunggah ${file.name}...`);

    const form = new FormData();
    form.append("file", file);

    try {
      // Multipart — `Content-Type` (beserta boundary-nya) dibiarkan ke
      // browser. Kalau diisi manual, boundary-nya hilang dan server tidak
      // bisa mengurai file.
      const data = await api.upload("/api/library/documents/upload/", form);

      const document = data.document || {};
      setText("fileName", `${file.name} (terunggah)`);

      // KRS PDF hasil scan perlu OCR sebelum isinya bisa dicari.
      if (document.id) {
        try {
          await postJson(`/api/library/documents/${document.id}/ocr/`, {});
        } catch (error) {
          // OCR bersifat tambahan - kegagalan di sini tidak membatalkan unggah.
          console.warn("OCR gagal dijalankan:", error);
        }
      }

      // Daftar perpustakaan perlu diperbarui supaya dokumen baru langsung
      // muncul dengan tombol hapus-nya.
      loadLibraryDocuments();

      showToast(`KRS ${file.name} tersimpan di perpustakaan dokumen.`);
    } catch (error) {
      setText("fileName", "Gagal mengunggah");
      showToast(error.message);
    } finally {
      input.value = "";
    }
  });

  // =====================================================
  // OPTIMASI JADWAL - DEMO
  // =====================================================

  // Saran jadwal alternatif. Sumber datanya nyata: entri jadwal + daftar
  // bentrok yang dihitung backend. Yang dihitung di sini hanya "slot kosong"
  // dan "entri yang perlu digeser" - backend belum punya endpoint optimizer,
  // jadi tidak boleh menampilkan slot fiktif.
  $("#optimizeBtn")?.addEventListener("click", async () => {
    const avoidConflict = $("#avoidConflict")?.checked ?? false;
    const preferMorning = $("#preferMorning")?.checked ?? false;
    const includeConsultation = $("#includeConsultation")?.checked ?? false;

    const result = $("#optimizationResult");
    if (!result) return;

    const button = $("#optimizeBtn");
    if (button) button.disabled = true;

    try {
      // Muat ulang bentrok dari backend supaya saran memakai data terbaru.
      const data = await getJson("/api/schedule/conflicts/");
      const conflicts = Array.isArray(data.conflicts) ? data.conflicts : [];

      const entries = schedules.filter((schedule) => {
        if (!includeConsultation && schedule.type === "konsultasi") return false;
        return true;
      });

      // Jam-jam yang dipakai pada hari yang sama.
      const busyByDay = new Map();
      entries.forEach((schedule) => {
        const list = busyByDay.get(schedule.day) || [];
        list.push([toMinutes(schedule.start), toMinutes(schedule.end)]);
        busyByDay.set(schedule.day, list);
      });

      // Slot kandidat: 07:00 - 19:00, durasi 2 jam.
      const SLOT_START = 7 * 60;
      const SLOT_END = 19 * 60;
      const SLOT_LENGTH = 120;

      const freeSlots = [];
      for (let day = 0; day < 5; day += 1) {
        const busy = (busyByDay.get(day) || []).sort((a, b) => a[0] - b[0]);

        let cursor = SLOT_START;
        for (const [start, end] of busy) {
          if (start - cursor >= SLOT_LENGTH) {
            freeSlots.push({ day, start: cursor, end: cursor + SLOT_LENGTH });
          }
          cursor = Math.max(cursor, end);
        }
        if (SLOT_END - cursor >= SLOT_LENGTH) {
          freeSlots.push({ day, start: cursor, end: cursor + SLOT_LENGTH });
        }
      }

      // Prioritas pagi: urutkan slot pagi lebih dulu.
      if (preferMorning) {
        freeSlots.sort((a, b) => a.start - b.start);
      }

      const dayNames = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat"];
      const clock = (minutes) =>
        `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(
          minutes % 60,
        ).padStart(2, "0")}`;

      result.replaceChildren();
      result.hidden = false;

      const summary = document.createElement("p");
      summary.textContent = avoidConflict
        ? `${conflicts.length} bentrok, ${freeSlots.length} slot kosong tersedia.`
        : `${entries.length} kegiatan terdaftar, ${freeSlots.length} slot kosong tersedia.`;
      result.appendChild(summary);

      if (freeSlots.length) {
        const list = document.createElement("ul");
        freeSlots.slice(0, 6).forEach((slot) => {
          const item = document.createElement("li");
          item.textContent = `${dayNames[slot.day]} ${clock(slot.start)}-${clock(slot.end)}`;
          list.appendChild(item);
        });
        result.appendChild(list);
      }

      if (conflicts.length) {
        const conflictNote = document.createElement("p");
        conflictNote.textContent =
          "Entri yang bertabrakan: " +
          conflicts
            .slice(0, 4)
            .map((conflict) => conflict.entry1_title || conflict.entry2_title || "?")
            .join(", ");
        result.appendChild(conflictNote);
      }

      showToast("Saran jadwal dihitung dari data jadwal dan bentrok backend.");
    } catch (error) {
      result.hidden = false;
      result.textContent = "Gagal memuat data bentrok: " + error.message;
      showToast(error.message);
    } finally {
      if (button) button.disabled = false;
    }
  });

  // =====================================================
  // EKSPOR KALENDER ICS
  // =====================================================

  $("#exportCalendar")?.addEventListener("click", () => {
    const monday = getMonday(currentDate);

    const escapeICS = (value) =>
      String(value ?? "")
        .replace(/\\/g, "\\\\")
        .replace(/,/g, "\\,")
        .replace(/;/g, "\\;")
        .replace(/\r?\n/g, "\\n");

    const toICSDate = (date, time) => {
      const [hours, minutes] = time.split(":").map(Number);
      const eventDate = new Date(date);

      eventDate.setHours(hours, minutes, 0, 0);

      return (
        `${eventDate.getFullYear()}` +
        `${String(eventDate.getMonth() + 1).padStart(2, "0")}` +
        `${String(eventDate.getDate()).padStart(2, "0")}` +
        "T" +
        `${String(eventDate.getHours()).padStart(2, "0")}` +
        `${String(eventDate.getMinutes()).padStart(2, "0")}` +
        "00"
      );
    };

    const visibleSchedules = schedules.filter(
      (schedule) =>
        !filter || filter.value === "all" || schedule.type === filter.value,
    );

    const events = visibleSchedules.map((schedule, index) => {
      // Entri berulang memakai hari dalam minggu yang ditampilkan;
      // entri sekali pakai memakai tanggal aslinya.
      const date = schedule.recurring
        ? new Date(monday)
        : schedule.date || new Date(monday);

      if (schedule.recurring) {
        date.setDate(monday.getDate() + schedule.day);
      }

      return [
        "BEGIN:VEVENT",
        `UID:${Date.now()}-${index}@akademia-ai`,
        `DTSTAMP:${new Date()
          .toISOString()
          .replace(/[-:]/g, "")
          .replace(/\.\d{3}/, "")}`,
        `DTSTART:${toICSDate(date, schedule.start)}`,
        `DTEND:${toICSDate(date, schedule.end)}`,
        `SUMMARY:${escapeICS(schedule.name + " - " + schedule.detail)}`,
        `DESCRIPTION:${escapeICS(schedule.description || schedule.detail)}`,
        `LOCATION:${escapeICS(schedule.room)}`,
        "END:VEVENT",
      ].join("\r\n");
    });

    const calendar = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Akademia AI//Auto Scheduler//ID",
      "CALSCALE:GREGORIAN",
      ...events,
      "END:VCALENDAR",
    ].join("\r\n");

    const blob = new Blob([calendar], {
      type: "text/calendar;charset=utf-8",
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = "jadwal-akademia.ics";

    document.body.appendChild(link);
    link.click();
    link.remove();

    URL.revokeObjectURL(url);

    showToast("File kalender berhasil dibuat.");
  });

  // =====================================================
  // AKSI PRODUKTIVITAS
  // =====================================================

  // Aksi produktivitas. Setiap aksi diarahkan ke endpoint yang benar-benar
  // ada di backend, bukan ke pesan "demo":
  //   - Ringkas Materi  -> buat dokumen ringkasan (Document Creator)
  //   - Tanya Dosen AI  -> chat AI Dosen (AI Lecturer)
  //   - Cek Tugas       -> daftar tugas (Reminder System)
  //   - Flashcard       -> buat dokumen flashcard (Document Creator)
  const PRODUCTIVITY_TARGETS = {
    "Ringkas Materi Praktikum": {
      url: "/document-creator/",
      message: "Buka Document Creator untuk membuat ringkasan materi.",
    },
    "Buat Flashcard Ujian": {
      url: "/document-creator/",
      message: "Buka Document Creator untuk menyusun flashcard ujian.",
    },
    "Tanya Dosen AI": {
      url: "/ai-lecturer/",
      message: "Buka AI Lecturer untuk berdiskusi dengan Dosen AI.",
    },
    "Cek Tugas": {
      url: "/reminder-system/",
      message: "Buka Reminder System untuk memeriksa daftar tugas.",
    },
  };

  $$("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const target = PRODUCTIVITY_TARGETS[button.dataset.action];

      if (!target) {
        showToast(`${button.dataset.action}: aksi ini belum punya backend.`);
        return;
      }

      showToast(target.message);
      window.location.href = target.url;
    });
  });

  // =====================================================
  // INTEGRASI MODUL PADA BOX DETAIL
  // =====================================================

  // Tombol integrasi membuka modul yang benar-benar ada di dashboard.
  // Sebelumnya semuanya hanya menampilkan toast "belum terhubung" — jadi
  // tombolnya kelihatan bisa dipakai padahal tidak melakukan apa pun.
  const MODULE_LINKS = {
    "#openRagDocuments": {
      url: "/rag-assistant/",
      message: "Membuka RAG Assistant.",
    },
    "#openLectureListener": {
      url: "/lecture-listener/",
      message: "Membuka Lecture Listener.",
    },
    "#openAiLecturer": {
      url: "/ai-lecturer/",
      message: "Membuka AI Lecturer.",
    },
  };

  Object.entries(MODULE_LINKS).forEach(([selector, target]) => {
    $(selector)?.addEventListener("click", () => {
      showToast(target.message);
      window.location.href = target.url;
    });
  });

  // =====================================================
  // FORM TAMBA JADWAL
  // =====================================================

  const scheduleForm = $("#scheduleForm");

  scheduleForm?.addEventListener("submit", async (event) => {
    event.preventDefault();

    const submitButton = $("#entrySubmit");

    const title = $("#entryTitle")?.value.trim() || "";
    const startTime = naiveDateTime($("#entryStart")?.value);
    const endTime = naiveDateTime($("#entryEnd")?.value);
    const location = $("#entryLocation")?.value.trim() || "";
    const description = $("#entryDescription")?.value.trim() || "";
    const courseId = $("#entryCourse")?.value || "";
    const isRecurring = $("#entryRecurring")?.checked ?? false;

    if (!title) {
      showToast("Judul jadwal wajib diisi.");
      return;
    }

    if (!startTime || !endTime) {
      showToast("Waktu mulai dan selesai wajib diisi.");
      return;
    }

    if (endTime <= startTime) {
      showToast("Waktu selesai harus setelah waktu mulai.");
      return;
    }

    // day_of_week backend: 0=Senin .. 6=Minggu. Dihitung dari tanggal
    // mulai, bukan dari getDay() JavaScript (0=Minggu).
    const startDate = parseNaiveDateTime(startTime);
    const dayOfWeek = startDate ? (startDate.getDay() + 6) % 7 : null;

    const payload = {
      title,
      start_time: startTime,
      end_time: endTime,
      is_recurring: isRecurring,
    };

    if (location) payload.location = location;
    if (description) payload.description = description;
    if (courseId) payload.course_id = courseId;

    // ``day_of_week`` hanya dikirim untuk entri **berulang**.
    //
    // Untuk entri sekali pakai, hari sudah diketahui dari tanggal
    // mulainya — mengirimkannya membuat entri itu terbaca sebagai
    // jadwal mingguan di tempat lain yang masih memakai aturan lama
    // ("ada day_of_week = berulang"). Backend sekarang menormalkan
    // sendiri (lihat ``normalize_recurrence``), tapi mengirim field
    // yang tidak bermakna hanya menambah satu jalan lagi ke bug yang
    // sama.
    if (isRecurring && dayOfWeek !== null) payload.day_of_week = dayOfWeek;

    if (submitButton) submitButton.disabled = true;

    try {
      await postJson("/api/schedule/", payload);

      scheduleForm.reset();

      // Setelah simpan, tombol "Tambah" dan dropdown kembali ke default.
      $("#entryCourse").value = "";
      $("#entryRecurring").checked = false;

      await loadSchedule({ silent: true });

      showToast("Jadwal tersimpan.");
    } catch (error) {
      showToast(error.message);
    } finally {
      if (submitButton) submitButton.disabled = false;
    }
  });

  // =====================================================
  // HAPUS JADWAL
  // =====================================================

  $("#deleteScheduleEntry")?.addEventListener("click", async () => {
    if (!activeSchedule?.id) {
      showToast("Jadwal ini belum tersimpan di backend.");
      return;
    }

    const button = $("#deleteScheduleEntry");
    const title = activeSchedule.detail || activeSchedule.name || "jadwal ini";

    if (!window.confirm(`Hapus "${title}" dari jadwal?`)) return;

    if (button) button.disabled = true;

    try {
      await deleteJson(`/api/schedule/${encodeURIComponent(activeSchedule.id)}/`);

      closeMaterialDetail();

      await loadSchedule({ silent: true });

      showToast("Jadwal dihapus.");
    } catch (error) {
      showToast(error.message);
    } finally {
      if (button) button.disabled = false;
    }
  });

  // =====================================================
  // IMPORT JADWAL DARI PORTAL KAMPUS
  // =====================================================

  const importForm = $("#scheduleImportForm");

  importForm?.addEventListener("submit", async (event) => {
    event.preventDefault();

    const url = $("#importUrl")?.value.trim() || "";
    const courseId = $("#importCourse")?.value || "";
    const submitButton = $("#importSubmit");

    if (!url) {
      showToast("URL sumber wajib diisi.");
      return;
    }

    const payload = { url };

    if (courseId) payload.course_id = courseId;

    if (submitButton) submitButton.disabled = true;

    try {
      const data = await postJson("/api/schedule/import/", payload);

      const jobId = data.job_id || data.job?.id || "";

      if (!jobId) {
        // Backend lama (tanpa job_id) — tidak ada yang bisa dipolling.
        // Satu-satunya jalur yang tersedia adalah meminta user memuat ulang.
        const taskNote = data.task_id ? ` (task ${data.task_id})` : "";

        showToast(
          `Import dimulai${taskNote}. Backend tidak mengembalikan id job, jadi status proses tidak bisa dipantau — tekan "Muat ulang" nanti.`,
        );

        return;
      }

      activeImportJobId = jobId;

      setText(
        "importStatus",
        "Import berjalan di latar belakang. Menunggu proses selesai…",
      );

      showToast("Import dimulai. Status proses ditampilkan di panel import.");

      pollImportJob(jobId);
    } catch (error) {
      setText("importStatus", `Import gagal dimulai: ${error.message}`);

      showToast(error.message);
    } finally {
      if (submitButton) submitButton.disabled = false;
    }
  });

  // Poll status satu job import sampai selesai (done/failed). Pola ini
  // meniru schedulePolling() di ai_lecturer.js — polling memakai timeout
  // supaya tidak ada request yang menumpuk kalau tab sedang idle.
  function pollImportJob(jobId) {
    clearTimeout(importPollTimer);

    importPollTimer = setTimeout(async () => {
      if (activeImportJobId !== jobId) return;

      let job = null;

      try {
        const data = await getJson(
          "/api/schedule/import/" + encodeURIComponent(jobId) + "/",
        );

        job = data.job || null;
      } catch (error) {
        setText("importStatus", `Gagal membaca status import: ${error.message}`);

        // Status tidak bisa dibaca — hentikan polling daripada menebak
        // hasil. User masih bisa menekan "Muat ulang" untuk melihat jadwal.
        activeImportJobId = null;

        showToast("Gagal membaca status import: " + error.message);

        return;
      }

      if (!job) {
        setText("importStatus", "Status import tidak tersedia.");

        activeImportJobId = null;

        return;
      }

      const status = job.status || "queued";

      if (status === "done") {
        const imported = Number(job.entries_imported) || 0;
        const updated = Number(job.entries_updated) || 0;

        activeImportJobId = null;

        setText(
          "importStatus",
          `Import selesai. ${imported} entri baru, ${updated} entri diperbarui.`,
        );

        showToast(
          `Import selesai: ${imported} entri baru, ${updated} diperbarui.`,
        );

        // Muat ulang jadwal supaya entri hasil import langsung terlihat.
        await loadSchedule({ silent: true });

        return;
      }

      if (status === "failed") {
        activeImportJobId = null;

        const reason = job.error_message || "Tanpa keterangan.";

        setText("importStatus", `Import gagal: ${reason}`);

        showToast("Import gagal: " + reason);

        return;
      }

      setText(
        "importStatus",
        status === "processing"
          ? "Import sedang berjalan…"
          : "Import dijadwalkan, menunggu worker…",
      );

      pollImportJob(jobId);
    }, 3000);
  }

  $("#reloadSchedule")?.addEventListener("click", async () => {
    await loadSchedule();
  });

  // =====================================================
  // KOREKSI TAG MATA KULIAH
  // =====================================================

  // Auto-tag menebak dari isi entri; kalau tebakannya salah, pengguna
  // menautkan mata kuliah sendiri lewat PATCH /schedule/<id>/.
  $("#saveMaterialCourse")?.addEventListener("click", async () => {
    if (!activeSchedule?.id) {
      showToast("Jadwal ini belum tersimpan di backend.");
      return;
    }

    const button = $("#saveMaterialCourse");
    const select = $("#materialCourseSelect");
    const courseId = select?.value || "";

    if (button) button.disabled = true;

    try {
      // course_id = null berarti lepaskan tag; string kosong di backend
      // berarti "kosongkan field ini" (lihat _schedule_payload di BFF).
      await patchJson(`/api/schedule/${encodeURIComponent(activeSchedule.id)}/`, {
        course_id: courseId || null,
      });

      const course = findCourse(courseId);

      setText(
        "materialTagNote",
        course
          ? `Tersimpan. Entri ini sekarang tertaut ke ${course.code ? course.code + " — " : ""}${course.name || course.id}.`
          : "Tersimpan. Entri ini sekarang tidak tertaut ke mata kuliah mana pun.",
      );

      await loadSchedule({ silent: true });

      showToast(course ? "Tag mata kuliah diperbarui." : "Tag mata kuliah dilepas.");
    } catch (error) {
      setText("materialTagNote", `Gagal menyimpan tag: ${error.message}`);

      showToast(error.message);
    } finally {
      if (button) button.disabled = false;
    }
  });

  // =====================================================
  // TRANSKRIP LECTURE LISTENER
  // =====================================================

  // Sesi rekaman terakhir yang punya transkrip. Dipakai untuk mengisi tab
  // "Catatan Kuliah Live Sync" - bukan catatan contoh.
  let latestLecture = null;

  // Segmen transkrip -> kartu "Catatan Cerdas Otomatis".
  function renderTakeaways(segments) {
    const container = $("#lnTakeaways");
    if (!container) return;

    container.replaceChildren();

    if (!segments.length) {
      const empty = document.createElement("p");
      empty.className = "material-empty";
      empty.textContent = "Belum ada segmen transkrip untuk ditampilkan.";
      container.appendChild(empty);
      return;
    }

    segments.slice(0, 6).forEach((segment, index) => {
      const article = document.createElement("article");
      article.className = "ln-takeaway";

      const head = document.createElement("div");
      head.className = "ln-take-head";

      const title = document.createElement("h5");
      title.textContent = `${index + 1}. Segmen transkrip`;

      const time = document.createElement("span");
      time.textContent = formatDuration(segment.start, "-");

      head.append(title, time);

      const body = document.createElement("p");
      body.textContent = segment.text || "";

      article.append(head, body);
      container.appendChild(article);
    });
  }

  // Muat sesi rekaman terakhir beserta transkripnya.
  async function loadLectureTranscript() {
    try {
      const data = await getJson("/api/lecture/");
      const sessions = Array.isArray(data.sessions) ? data.sessions : [];

      // Backend tidak mengurutkan daftar sesi, jadi "terakhir" berarti
      // started_at paling baru.
      const newestFirst = (a, b) => {
        const at = Date.parse(a.started_at || a.created_at || "") || 0;
        const bt = Date.parse(b.started_at || b.created_at || "") || 0;
        return bt - at;
      };

      // Sesi yang transkripnya sudah jadi.
      const withTranscript = sessions
        .filter((s) => s.transcript || s.status === "completed")
        .sort(newestFirst);

      // Sesi yang punya berkas rekaman.
      const withAudio = sessions.filter((s) => s.audioUrl).sort(newestFirst);

      // Pemilihan sesi berjenjang. Urutannya penting: sesi yang punya
      // transkrip SEKALIGUS punya berkas audio adalah yang terbaik —
      // transkripnya bisa dibaca dan rekamannya bisa diputar.
      //
      // Prioritas hanya "transkrip" (tanpa syarat audio) itu jebakan:
      // sesi berstatus `recording` bisa sudah punya teks transkrip tapi
      // belum punya berkas audio sama sekali. Kalau sesi seperti itu
      // menang, pemutar audio mati (tidak ada `src`) padahal ada sesi
      // lain yang rekamannya bisa diputar.
      const withBoth = withTranscript.filter((s) => s.audioUrl);
      const withAudioOnly = withAudio.filter(
        (s) => !s.transcript && s.status !== "completed",
      );

      const session =
        withBoth[0] || withAudioOnly[0] || withTranscript[0] || withAudio[0];

      if (!session) {
        setText("lnSessionTitle", "Belum ada sesi rekaman.");
        setText("lnSessionStatus", "Belum ada data");
        setText("lnAudioTime", "-");
        setText(
          "lnAudioHint",
          "Rekam atau unggah berkas di Lecture Listener untuk melihat transkrip di sini.",
        );
        setText("lnModuleLecture", "Belum ada rekaman");
        renderTakeaways([]);
        return;
      }

      latestLecture = session;

      setText("lnSessionTitle", session.title || "Sesi rekaman");
      setText(
        "lnSessionStatus",
        `● Status: ${session.status || "tidak diketahui"}`,
      );
      setText(
        "lnAudioTime",
        session.duration_seconds
          ? formatDuration(session.duration_seconds, "-")
          : "-",
      );
      setText(
        "lnAudioHint",
        "Transkrip diambil dari Lecture Listener (backend).",
      );

      // Status sinkronisasi modul — dihitung dari data yang benar-benar
      // diterima, bukan teks tetap.
      setText(
        "lnModuleLecture",
        session.audioUrl ? "Siap diputar" : "Siap (transkrip saja)",
      );

      // Segmen bertimestamp butuh endpoint terpisah.
      let segments = [];
      try {
        const transcript = await getJson(
          `/api/lecture/${encodeURIComponent(session.id)}/transcript/`,
        );
        segments = Array.isArray(transcript.segments) ? transcript.segments : [];
      } catch (error) {
        console.warn("Segmen transkrip gagal dimuat:", error);
      }

      renderTakeaways(segments);
    } catch (error) {
      console.warn("Sesi rekaman gagal dimuat:", error);
      setText("lnSessionTitle", "Gagal memuat sesi rekaman.");
      setText("lnSessionStatus", "Gagal memuat");
      renderTakeaways([]);
    }
  }

  // =====================================================
  // BERKAS TERINDEKS (RAG)
  // =====================================================

  // Dokumen yang sudah terindeks di backend. Dipakai untuk daftar berkas
  // pada modal detail materi - jadi tidak ada lagi daftar file contoh di
  // template.
  async function loadDocuments() {
    try {
      const data = await getJson("/api/rag/documents/");
      indexedDocuments = Array.isArray(data.documents) ? data.documents : [];
    } catch (error) {
      // Daftar berkas bukan hal wajib - modal tetap bisa dibuka.
      console.warn("Daftar dokumen gagal dimuat:", error);
      indexedDocuments = [];
    }
    renderMaterialFiles();

    // Status RAG Vector Store — dihitung dari dokumen yang benar-benar
    // terindeks di backend.
    const indexed = indexedDocuments.filter(
      (doc) => doc.status === "indexed",
    ).length;

    setText(
      "lnModuleRag",
      indexed ? `${indexed} dokumen terindeks` : "Belum ada dokumen terindeks",
    );
  }

  // =====================================================
  // DOKUMEN PERPUSTAKAAN
  // =====================================================

  // Daftar dokumen tersimpan di perpustakaan backend (KRS & berkas
  // referensi). Backend DELETE /documents/<id> menghapus baris dokumen
  // beserta berkas nativesnya, jadi tombol hapus di sini cukup memanggil
  // route BFF lalu memuat ulang daftar.
  function renderLibraryDocuments() {
    const list = $("#libraryDocList");
    if (!list) return;

    list.replaceChildren();

    if (!libraryDocuments.length) {
      const empty = document.createElement("p");
      empty.className = "scheduler-empty";
      empty.textContent = "Belum ada dokumen di perpustakaan.";
      list.append(empty);
      return;
    }

    libraryDocuments.forEach((doc) => {
      const row = document.createElement("div");
      row.className = "scheduler-doc-row";
      row.dataset.documentId = doc.id || "";

      const icon = document.createElement("span");
      icon.className = "scheduler-doc-icon";
      icon.textContent = "📄";

      const name = document.createElement("span");
      name.className = "scheduler-doc-name";
      name.textContent = doc.title || doc.filename || "Dokumen";
      name.title = name.textContent;

      const type = document.createElement("span");
      type.className = "scheduler-doc-type";
      type.textContent = doc.type || doc.fileType || "";

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "scheduler-doc-delete";
      remove.setAttribute("aria-label", "Hapus " + name.textContent);
      remove.textContent = "×";
      remove.disabled = !doc.id;

      remove.addEventListener("click", async () => {
        remove.disabled = true;

        try {
          await postJson(
            "/api/library/documents/" + encodeURIComponent(doc.id) + "/delete/",
            {},
          );
          libraryDocuments = libraryDocuments.filter(
            (item) => item.id !== doc.id,
          );
          renderLibraryDocuments();
          showToast("Dokumen dihapus dari perpustakaan.");
        } catch (error) {
          remove.disabled = false;
          showToast("Gagal menghapus dokumen: " + error.message);
        }
      });

      row.append(icon, name, type, remove);
      list.append(row);
    });
  }

  async function loadLibraryDocuments() {
    try {
      const data = await getJson("/api/library/documents/");
      libraryDocuments = Array.isArray(data.documents) ? data.documents : [];
    } catch (error) {
      // Daftar dokumen bukan hal wajib - panel lain tetap jalan.
      console.warn("Daftar dokumen perpustakaan gagal dimuat:", error);
      libraryDocuments = [];
    }
    renderLibraryDocuments();
  }

  // =====================================================
  // TUGAS & DEADLINE
  // =====================================================

  // Tugas yang sudah selesai tidak lagi jadi deadline aktif.
  //
  // Definisi "sudah selesai" punya satu sumber untuk seluruh halaman —
  // lihat ``dashboard/task_state.js``.
  //
  // Akses ke modul dilakukan **saat dipanggil**, bukan saat file ini
  // dimuat, dan ada fallback-nya: kalau modulnya gagal dimuat, halaman
  // ini harus tetap bisa merender daftar deadline (dengan satu predikat
  // cadangan), bukan meledak di tengah render.
  const isTaskCompleted = (task) => {
    const state = window.AkademiaTaskState;
    if (state) return state.isCompleted(task);
    return (
      Boolean(task) &&
      (task.is_completed === true || task.status === "completed")
    );
  };

  // "2026-12-31T23:59:00" → "31 Des 2026, 23:59". Backend menyimpan waktu
  // tanpa zona waktu, jadi string-nya dibaca apa adanya (lihat catatan
  // parseNaiveDateTime di atas).

  // Tugas yang terkait dengan satu entri jadwal. Backend menautkan lewat
  // ``course_id`` — entri jadwal juga punya ``course_id``, jadi keduanya
  // bisa dicocokkan.
  function tasksForCourse(courseId) {
    if (!courseId) return [];

    return taskItems.filter((task) => task.course_id === courseId);
  }

  function renderAssignmentList(courseId) {
    const container = $("#assignmentList");
    if (!container) return;

    container.replaceChildren();

    const tasks = tasksForCourse(courseId).filter((task) => !isTaskCompleted(task));

    if (!tasks.length) {
      const empty = document.createElement("p");
      empty.className = "material-empty";
      empty.textContent = courseId
        ? "Belum ada tugas terbuka untuk mata kuliah ini."
        : "Belum ada tugas yang ditautkan ke jadwal ini.";
      container.appendChild(empty);
      return;
    }

    tasks.forEach((task) => {
      const item = document.createElement("div");
      item.className = "material-assignment";

      const body = document.createElement("div");

      const title = document.createElement("strong");
      title.textContent = task.title || "Tugas";

      const deadline = document.createElement("p");
      deadline.textContent = formatTaskDeadline(task.due_date);

      body.append(title, deadline);

      const badge = document.createElement("span");
      badge.className = "material-badge";
      badge.textContent =
        task.type === "exam" ? "Ujian" : task.type === "project" ? "Proyek" : "Tugas";

      item.append(body, badge);
      container.appendChild(item);
    });
  }

  // Kartu deadline di kolom kanan menampilkan tugas terdekat yang belum
  // selesai — bukan teks contoh.
  function renderDeadlineCard() {
    const title = $("#assignmentTitlePreview");
    const description = $("#assignmentDescriptionPreview");
    const deadline = $("#assignmentDeadlinePreview");
    const counter = $("#deadlineCountLabel");

    const open = taskItems
      .filter((task) => !isTaskCompleted(task))
      .sort((a, b) => String(a.due_date || "").localeCompare(String(b.due_date || "")));

    if (counter) {
      counter.textContent = open.length ? `${open.length} tugas aktif` : "Tidak ada";
    }

    if (!open.length) {
      if (title) title.textContent = "Belum ada tugas aktif.";
      if (description) {
        description.textContent =
          "Tugas yang dibuat di Reminder System muncul di sini lengkap dengan tenggatnya.";
      }
      if (deadline) deadline.textContent = "-";
      return;
    }

    const nearest = open[0];

    if (title) title.textContent = nearest.title || "Tugas";
    if (description) {
      description.textContent =
        nearest.description || "Tanpa catatan tambahan. Deadline dari Reminder System.";
    }
    if (deadline) deadline.textContent = formatTaskDeadline(nearest.due_date);
  }

  async function loadTasks() {
    try {
      const data = await getJson("/api/tasks/");
      taskItems = Array.isArray(data.tasks) ? data.tasks : [];
    } catch (error) {
      console.warn("Daftar tugas gagal dimuat:", error);
      taskItems = [];
    }

    renderDeadlineCard();

    // Tab Tugas menampilkan tugas milik entri yang sedang dibuka.
    if (activeSchedule) {
      renderAssignmentList(activeSchedule.courseId);
    }
  }

  // =====================================================
  // MULAI HALAMAN
  // =====================================================

  // Render kosong dulu supaya layout tidak melompat, lalu isi dari backend.
  // Konflik sengaja dirender sebagai "Memuat jadwal..." — bukan "Tidak ada
  // bentrok" — karena bentrok belum diketahui sampai request selesai.
  scheduleLoading = true;
  renderCalendar();
  renderConflicts([]);

  loadCourses();
  loadSchedule({ silent: true });
  loadDocuments();
  loadLibraryDocuments();
  loadLectureTranscript();
  loadTasks();
});
