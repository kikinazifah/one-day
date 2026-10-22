/**
 * Reminder System — terhubung ke backend FastAPI (student-assistant)
 * lewat endpoint JSON Django (dashboard/views_api_tasks.py):
 *
 *   GET    /api/tasks/                        → daftar tugas
 *   POST   /api/tasks/create/                 → tugas baru
 *   PATCH  /api/tasks/<id>/edit/               → ubah tugas
 *   POST   /api/tasks/<id>/complete/           → tandai selesai
 *   POST   /api/tasks/<id>/reminders/          → atur waktu pengingat
 *   DELETE /api/tasks/<id>/                    → hapus tugas
 *   GET    /api/courses/                       → daftar mata kuliah
 *   GET    /api/reminders/offsets/             → daftar offset pengingat
 *
 * Semua angka di kartu statistik dihitung dari data server — bukan angka
 * hardcoded — sehingga kartu selalu cocok dengan isi daftar.
 *
 * **Offset pengingat.** Nilai yang dikirim ke backend adalah *jeda
 * sebelum tenggat* ("3_hours" = 3 jam sebelum tenggat), bukan waktu
 * absolut. Daftar presetnya diambil dari server lewat
 * ``/api/reminders/offsets/`` — jadi preset baru yang ditambahkan di
 * backend langsung muncul di sini, tanpa daftar kedua di file JS.
 */
document.addEventListener("DOMContentLoaded", () => {
  const api = window.AkademiaApi;
  const form = document.getElementById("reminderForm");
  const list = document.getElementById("reminderList");

  // Panel ubah tugas (native <dialog>).
  const editDialog = document.getElementById("taskEditDialog");
  const editForm = document.getElementById("taskEditForm");
  const editTitle = document.getElementById("editTaskTitle");
  const editSubject = document.getElementById("editTaskSubject");
  const editDeadline = document.getElementById("editTaskDeadline");
  const editPriority = document.getElementById("editTaskPriority");
  const editReminder = document.getElementById("editTaskReminder");
  const editNotes = document.getElementById("editTaskNotes");
  const editError = document.getElementById("taskEditError");
  const editCancel = document.getElementById("taskEditCancel");
  const editSubmit = document.getElementById("taskEditSubmit");

  // Field offset kustom (form baru + dialog ubah).
  const reminderSelect = document.getElementById("taskReminder");
  const customBox = document.getElementById("taskReminderCustom");
  const customAmount = document.getElementById("taskReminderCustomAmount");
  const customUnit = document.getElementById("taskReminderCustomUnit");
  const customHint = document.getElementById("taskReminderCustomHint");

  const editCustomBox = document.getElementById("editTaskReminderCustom");
  const editCustomAmount = document.getElementById("editTaskReminderCustomAmount");
  const editCustomUnit = document.getElementById("editTaskReminderCustomUnit");
  const editCustomHint = document.getElementById("editTaskReminderCustomHint");

  if (!form || !list || !api) return;

  // Tugas dari server.
  let tasks = [];
  // True kalau daftar tugas sudah pernah berhasil dimuat. Dipakai
  // untuk membedakan "memang tidak ada tugas" dari "belum sempat dimuat
  // (atau gagal dimuat)". Tanpa penanda ini, kegagalan jaringan membuat
  // halaman menampilkan "Belum ada tugas" — yang sebenarnya salah, karena
  // server sebenarnya punya data.
  let tasksLoaded = false;
  // True selama permintaan masih berjalan. Angka statistik menampilkan "—"
  // selama jendela ini, bukan "0" — karena "0" berarti "tidak ada tugas",
  // sedangkan faktanya kita belum tahu. Ini yang bikin halaman terlihat
  // "kosong" setiap kali di-refresh.
  let tasksLoading = false;
  // Error terakhir saat memuat. Disimpan supaya bisa ditampilkan ulang
  // di dalam daftar (bukan cuma di console) dan tidak hilang begitu
  // daftar dirender ulang.
  let loadError = null;
  // Mata kuliah dari server — untuk mengisi dropdown.
  let courses = [];
  // Preset offset pengingat — diambil dari server, bukan ditulis di sini.
  let reminderOptions = [];

  // Peta warna badge untuk prioritas backend (low/medium/high/urgent).
  const PRIORITY_BADGE = {
    low: "green",
    medium: "blue",
    high: "red",
    urgent: "red",
  };

  const PRIORITY_LABEL = {
    low: "Rendah",
    medium: "Sedang",
    high: "Tinggi",
    urgent: "Mendesak",
  };

  // Prioritas UI (Indonesia) → nilai backend (low/medium/high/urgent).
  const PRIORITY_MAP = {
    Rendah: "low",
    Sedang: "medium",
    Tinggi: "high",
    Mendesak: "urgent",
  };

  // Nilai khusus yang berarti "pengguna sedang mengisi offset sendiri".
  const CUSTOM = "custom";

  // =====================================================
  // OFFSET PENGINGAT
  // =====================================================

  // Batas atas offset pengingat: **365 hari** (sama dengan backend —
  // `MAX_OFFSET_MINUTES` di `app/core/reminder_offsets.py`).
  //
  // Batasnya **per satuan**, bukan satu angka untuk semua satuan: 365
  // menit cuma 6 jam, sedangkan 365 minggu hampir 7 tahun. Dulu input
  // kustom memakai `max="365"` — angka yang sama untuk semua satuan.
  // Akibatnya nilai yang sah (mis. `8760_hours` = 365 hari) dianggap
  // tidak valid oleh peramban, dan karena field-nya ikut form, dialog
  // "Ubah" terkunci tanpa pesan yang terlihat.
  const MAX_OFFSET_DAYS = 365;

  // Durasi per satuan dalam menit, dan batas jumlah maksimum per satuan
  // dalam satuan itu sendiri.
  const UNIT_MINUTES = {
    minutes: 1,
    hours: 60,
    days: 24 * 60,
    weeks: 7 * 24 * 60,
  };

  const UNIT_LABEL = {
    minutes: "menit",
    hours: "jam",
    days: "hari",
    weeks: "minggu",
  };

  // Jumlah maksimum per satuan agar durasinya tidak melebihi 365 hari.
  const UNIT_MAX_AMOUNT = {
    minutes: MAX_OFFSET_DAYS * 24 * 60,
    hours: MAX_OFFSET_DAYS * 24,
    days: MAX_OFFSET_DAYS,
    weeks: Math.floor(MAX_OFFSET_DAYS / 7),
  };

  /**
   * Cek apakah offset kustom (jumlah + satuan) boleh dipakai.
   *
   * Mengembalikan `null` kalau oke, atau pesan error berbahasa Indonesia
   * kalau tidak. Pesannya ditampilkan di hint, jadi user tahu batasnya
   * sebelum menekan Simpan — bukan setelahnya mendapat 400 dari server.
   *
   * Hanya ada **satu** batas: durasinya tidak boleh melebihi 365 hari.
   * Jumlah digit tidak dibatasi sendiri — batas itu ada di backend
   * sebagai `\d{1,4}`, dan menerapkannya di sini justru membuat dua
   * batas yang berbeda: "525600 menit" (tepat 365 hari) ditolak
   * padahal durasinya sah, sementara pesan errornya sendiri
   * menyebut angka itu sebagai batas yang sah.
   */
  function validateCustomOffset(amount, unit) {
    if (!Number.isFinite(amount) || amount <= 0) {
      return "Masukkan jumlah lebih dari 0.";
    }

    if (!Number.isInteger(amount)) {
      return "Jumlah harus bilangan bulat.";
    }

    const maxAmount = UNIT_MAX_AMOUNT[unit];
    if (amount > maxAmount) {
      return (
        "Maksimal " +
        MAX_OFFSET_DAYS +
        " hari (" +
        maxAmount +
        " " +
        UNIT_LABEL[unit] +
        " sebelum tenggat)."
      );
    }

    return null;
  }

  /**
   * Ubah nilai `<select>` menjadi offset yang dikirim ke backend.
   *
   * Kalau pilihannya "custom", nilainya dirakit dari field jumlah +
   * satuan. Kalau tidak, nilainya langsung dipakai — preset dari server
   * sudah berbentuk kanonik.
   *
   * Mengembalikan `null` kalau tidak ada pengingat.
   */
  function readOffset(select, amountInput, unitSelect) {
    const chosen = select?.value || "";

    if (!chosen) return null;

    if (chosen !== CUSTOM) return chosen;

    const amount = Number.parseInt(amountInput?.value || "", 10);
    const unit = unitSelect?.value || "hours";

    if (!Number.isFinite(amount) || amount <= 0) return null;

    // Bentuk kanonik: jumlah 1 memakai satuan tunggal ("1_hour"), jumlah
    // lebih dari satu memakai jamak ("3_hours"). Backend menormalkan
    // juga, tapi mengirim bentuk yang sudah kanonik membuat yang
    // tersimpan rapi sejak awal.
    const singular = unit === "minutes" ? "minute" : unit.slice(0, -1);
    const suffix = amount === 1 ? singular : unit;
    return amount + "_" + suffix;
  }

  /** Tampilkan/hidden field kustom sesuai pilihan saat ini. */
  function syncCustomVisibility(select, box) {
    if (!box) return;
    box.hidden = select?.value !== CUSTOM;
  }

  /** Tulislah pratinjau offset kustom ("2 jam sebelum tenggat"). */
  function syncCustomHint(amountInput, unitSelect, hint) {
    if (!hint) return;

    const amount = Number.parseInt(amountInput?.value || "", 10);
    const unit = unitSelect?.value || "hours";

    if (!Number.isFinite(amount) || amount <= 0) {
      hint.textContent = "Masukkan jumlah lebih dari 0.";
      return;
    }

    // Batas per-satuan: tampilkan pesannya di hint, jadi user tahu
    // sebelum menekan Simpan — bukan setelah mendapat 400 dari server.
    const problem = validateCustomOffset(amount, unit);
    if (problem) {
      hint.textContent = problem;
      hint.style.color = "#b42318";
      return;
    }

    hint.style.color = "";
    hint.textContent =
      "Pengingat berbunyi " +
      amount +
      " " +
      UNIT_LABEL[unit] +
      " sebelum tenggat.";
  }

  /**
   * Isi ulang `<select>` pengingat dengan preset dari server.
   *
   * Opsi "custom" dan "tanpa pengingat" dipertahankan — keduanya bukan
   * preset, tapi pilihan yang harus selalu ada.
   */
  function fillReminderOptions(select) {
    if (!select) return;

    const current = select.value;
    const wasCustom = current === CUSTOM;

    select.replaceChildren();

    // Urutannya **apa adanya** dari server.
    //
    // Dulu ada peta `closeness` di sini yang mengurutkan ulang preset
    // dari jauh ke dekat. Dua masalahnya:
    //
    //   1. Server sebenarnya sudah mengirim urutan yang benar
    //      (dekat ke jauh — `PRESET_OFFSETS` di backend), jadi peta itu
    //      membatalkan urutan yang benar, bukan memperbaiki.
    //   2. Preset yang tidak ada di peta (mis. `2_hours` yang baru
    //      ditambahkan backend) jatuh ke `Number.MAX_SAFE_INTEGER` —
    //      jadi muncul di **dasar** dropdown, bukan di tempatnya.
    //
    // Dan karena select per-baris memakai `reminderOptions` tanpa sort,
    // dua dropdown untuk hal yang sama bisa punya urutan berbeda.
    //
    // Sekarang server yang menjadi satu-satunya sumber urutan.
    reminderOptions.forEach((option) => {
      const element = document.createElement("option");
      element.value = option.value;
      element.textContent = option.label;
      select.appendChild(element);
    });

    const custom = document.createElement("option");
    custom.value = CUSTOM;
    custom.textContent = "Kustom (N jam/menit sebelum)...";
    select.appendChild(custom);

    const none = document.createElement("option");
    none.value = "";
    none.textContent = "Tanpa pengingat";
    select.appendChild(none);

    if (wasCustom) {
      select.value = CUSTOM;
    } else if (reminderOptions.some((option) => option.value === current)) {
      select.value = current;
    }
  }

  /**
   * Ambil daftar preset dari opsi yang sudah di-render server.
   *
   * Template merender preset-nya sendiri (`{% for preset in
   * reminder_presets %}`), jadi daftar itu tersedia bahkan kalau
   * `GET /api/reminders/offsets/` gagal. Ini cadangan supaya **select
   * per-baris** (yang dibangun sepenuhnya di JavaScript) tidak ikut
   * kehilangan semua preset-nya.
   *
   * Tanpa ini, kegagalan sesaat saat backend restart membuat user tidak
   * bisa mengubah pengingat tugas yang sudah ada — select-nya hanya
   * berisi "Tanpa pengingat".
   */
  function seedReminderOptionsFromTemplate() {
    const select = reminderSelect;
    if (!select) return [];

    return [...select.options]
      .filter((option) => option.value && option.value !== CUSTOM)
      .map((option) => ({ value: option.value, label: option.textContent }));
  }

  /** Muat daftar offset pengingat dari server. */
  async function loadReminderOptions() {
    try {
      const data = await api.get("/api/reminders/offsets/");
      const offsets = data.offsets || [];
      const labels = data.labels || {};

      // Label dari backend dipakai kalau ada; kalau tidak, pakai milik
      // BFF (``presets``) supaya dropdown tetap terisi walau backendnya
      // versi lama yang belum punya endpoint ini.
      const fallback = data.presets || [];
      const fallbackMap = new Map(fallback.map((item) => [item.value, item.label]));

      reminderOptions = offsets.map((value) => ({
        value,
        label: labels[value] || fallbackMap.get(value) || value,
      }));

      if (!reminderOptions.length) {
        reminderOptions = fallback;
      }
    } catch (error) {
      // Server tidak bisa dihubungi. Preset yang **sudah di-render
      // template** tetap dipakai — jadi formnya masih berfungsi, dan
      // select per-baris juga masih punya presetnya (dulu daftar ini
      // dikosongkan, sehingga baris hanya punya "Tanpa pengingat").
      console.warn("Daftar offset pengingat gagal dimuat:", error);
      reminderOptions = seedReminderOptionsFromTemplate();
      if (!reminderOptions.length) return;
    }

    fillReminderOptions(reminderSelect);
    fillReminderOptions(editReminder);

    // Select pengingat di tiap baris tugas dibangun dari daftar ini,
    // jadi daftarnya harus siap sebelum baris-baris itu dirender. Kalau
    // daftar baru saja tiba setelah daftar tugas, barisnya digambar
    // ulang supaya pilihan pengingatnya ikut terisi.
    if (tasks.length) renderTasks();
  }

  // Field kustom mengikuti perubahan select dan inputnya.
  reminderSelect?.addEventListener("change", () => {
    syncCustomVisibility(reminderSelect, customBox);
    syncCustomHint(customAmount, customUnit, customHint);
  });

  editReminder?.addEventListener("change", () => {
    syncCustomVisibility(editReminder, editCustomBox);
    syncCustomHint(editCustomAmount, editCustomUnit, editCustomHint);
  });

  [customAmount, customUnit].forEach((node) => {
    node?.addEventListener("input", () => {
      syncCustomHint(customAmount, customUnit, customHint);
    });
    node?.addEventListener("change", () => {
      syncCustomHint(customAmount, customUnit, customHint);
    });
  });

  [editCustomAmount, editCustomUnit].forEach((node) => {
    node?.addEventListener("input", () => {
      syncCustomHint(editCustomAmount, editCustomUnit, editCustomHint);
    });
    node?.addEventListener("change", () => {
      syncCustomHint(editCustomAmount, editCustomUnit, editCustomHint);
    });
  });

  // =====================================================
  // STATISTIK
  // =====================================================

  // Status tugas punya satu definisi untuk seluruh halaman — lihat
  // ``dashboard/task_state.js``. Badge sidebar, kartu "mendesak" di
  // Home, dan baris di halaman ini pakai definisi yang sama, jadi
  // angkanya tidak pernah beda satu sama lain.
  //
  // **Jangan destructure langsung.** Baris ini ada di top-level handler
  // ``DOMContentLoaded``, jadi kalau modulnya gagal dimuat, destructure
  // melempar error dan **seluruh** handler mati — daftar tugas, form,
  // dan statistik ikut hilang. Dengan fallback, modulate yang hilang cuma
  // menurunkan satu fitur, bukan satu halaman.
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

  // Helper tanggal/waktu — satu definisi untuk seluruh halaman, lihat
  // ``dashboard/datetime_utils.js``. Tadinya ditulis ulang di lima file
  // JavaScript, dan tiap salinan sedikit berbeda.
  //
  // **Jangan destructure langsung.** Baris ini ada di top-level handler
  // ``DOMContentLoaded``, jadi kalau modulnya gagal dimuat, destructure
  // melempar error dan **seluruh** handler mati — daftar tugas, form,
  // dan dialog ubah ikut hilang.
  //
  // Default per helper supaya pemanggilnya tetap dapat bekerja kalau
  // modulkya absen — nilainya "saya tidak tahu", bukan angka tebakan.
  //
  // Fallback inline **sengaja tidak menyalin logika**: menyalin helper
  // tanggal/waktu ke lima file persis masalah yang modul ini hilangkan.
  const dateTime = window.AkademiaDateTime || {};
  const {
    formatDeadline = () => "Tanpa tenggat",
    toDatetimeLocal = () => "",
  } = dateTime;

  function updateStats() {
    // Sebelum daftar pernah termuat, angka "0" menyesatkan: itu berarti
    // "tidak ada tugas", padahal artinya "belum diketahui". Tampilkan "—"
    // supaya user tidak menyimpulkan yang salah.
    //
    // Badge sidebar **tidak** disentuh di sini. Badge itu milik modul
    // bersama ``reminder_badge.js`` — satu writer untuk seluruh halaman.
    // Dulu halaman ini menyembunyikannya saat daftar belum termuat, jadi
    // badge sempat hilang padahal ada tugas mendesak, lalu muncul
    // belakangan: di halaman yang sama, kartu "mendesak" sudah berisi
    // angka sementara badge di sidebar masih kosong.
    if (!tasksLoaded) {
      setText("totalCount", "—");
      setText("doneCount", "—");
      setText("urgentCount", "—");
      return;
    }

    // Data sudah pernah termuat, tapi sedang dimuat ulang. Angka lama
    // masih valid — tampilkan lagi, jangan reset ke "—".
    if (tasksLoading) {
      const total = tasks.length;
      setText("totalCount", total);
      setText("doneCount", tasks.filter(isCompleted).length);
      setText("urgentCount", tasks.filter(isUrgent).length);
      return;
    }

    const total = tasks.length;
    const done = tasks.filter(isCompleted).length;
    const urgent = tasks.filter(isUrgent).length;

    setText("totalCount", total);
    setText("doneCount", done);
    setText("urgentCount", urgent);
  }

  /**
   * Segarkan badge "mendesak" di sidebar.
   *
   * Badge itu ditulis modul bersama ``reminder_badge.js`` — bukan di
   * sini. Kalau halaman ini juga menulisnya, dua sumber data bisa
   * menulis angka berbeda ke badge yang sama, dan hasilnya bergantung
   * siapa yang terakhir.
   *
   * Modul badge membaca **snapshot yang sama** dengan yang dipakai
   * kartu statistik di halaman ini, jadi keduanya tidak mungkin
   * berbeda — meskipun jawabannya datang di urutan berbeda.
   */
  function refreshSidebarBadge() {
    window.AkademiaReminderBadge?.refresh(
      window.AkademiaApi,
      window.AkademiaTaskState,
    );
  }

  function setText(id, value) {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  }

  // =====================================================
  // RENDER DAFTAR
  // =====================================================

  function courseName(courseId) {
    if (!courseId) return "";
    const course = courses.find((item) => item.id === courseId);
    if (!course) return "";
    return course.code ? course.code + " — " + course.name : course.name;
  }

  // =====================================================
  // UBAH TUGAS (PATCH)
  // =====================================================

  // Tugas yang sedang diedit — disimpan di luar form supaya handler
  // submit tahu id mana yang harus dikirim.
  let editingTaskId = null;

  function fillEditCourseOptions(selected) {
    if (!editSubject) return;

    editSubject.replaceChildren();

    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "Mata kuliah belum ditentukan";
    editSubject.append(empty);

    courses.forEach((course) => {
      const option = document.createElement("option");
      option.value = course.id;
      option.textContent = course.code
        ? course.code + " — " + course.name
        : course.name;
      editSubject.append(option);
    });

    if (selected) editSubject.value = selected;
  }

  /**
   * Pecah offset tersimpan ("5_hours") jadi jumlah + satuan.
   *
   * Offset bisa saja bukan preset — misalnya tugas lama yang pengingatnya
   * "90_minutes". Kalau begitu dropdown harusnya menunjukkan "Kustom" dan
   * field-nya diisi, supaya Offset yang tampil sama dengan Offset yang
   * tersimpan. Kalau tidak, mengedit judul saja bisa diam-diam mengubah
   * waktu pengingatnya.
   *
   * Jumlah digit tidak dibatasi — harus sama dengan tata bahasa backend
   * (`app/core/reminder_offsets.py`). Kalau dibatasi 4 digit di sini,
   * offset sah seperti "525600_minutes" tidak bisa dipecah, jadi field
   * kustomnya tetap kosong — dan offset itu **hilang** begitu tugas
   * disimpan ulang.
   */
  function splitOffset(value) {
    const match = /^(\d+)_([a-z]+)$/.exec(String(value || "").toLowerCase());
    if (!match) return null;

    const amount = Number.parseInt(match[1], 10);
    const unit = match[2];

    const known = { minutes: "minutes", minute: "minutes", hours: "hours", hour: "hours", days: "days", day: "days", weeks: "weeks", week: "weeks" };
    if (!known[unit]) return null;

    return { amount, unit: known[unit] };
  }

  function openEditDialog(task) {
    if (!editDialog) return;

    editingTaskId = task.id || null;

    if (editTitle) editTitle.value = task.title || "";
    if (editDeadline) editDeadline.value = toDatetimeLocal(task.due_date);
    if (editPriority) editPriority.value = task.priority || "medium";
    if (editNotes) editNotes.value = task.description || "";

    // Offset yang tersimpan ditampilkan apa adanya kalau ia ada di
    // daftar preset; kalau bukan, isi field kustom.
    const stored = task.reminder_time || "";
    const isPreset = reminderOptions.some((option) => option.value === stored);

    // Field kustom harus di-reset dulu. Kalau tidak, nilai dari dialog
    // sebelumnya **bocor** ke dialog ini — dan karena field-nya ikut
    // form, satu nilai basi bisa membuat seluruh dialog terkunci
    // (form tidak valid -> peramban menolak submit tanpa pesan yang
    // terlihat, karena field-nya sedang tersembunyi).
    if (editCustomAmount) editCustomAmount.value = "2";
    if (editCustomUnit) editCustomUnit.value = "hours";

    if (editReminder) {
      if (stored && !isPreset) {
        editReminder.value = CUSTOM;
        const parts = splitOffset(stored);
        if (parts) {
          if (editCustomAmount) editCustomAmount.value = parts.amount;
          if (editCustomUnit) editCustomUnit.value = parts.unit;
        }
      } else {
        editReminder.value = stored;
      }
    }

    syncCustomVisibility(editReminder, editCustomBox);
    syncCustomHint(editCustomAmount, editCustomUnit, editCustomHint);

    fillEditCourseOptions(task.course_id || "");

    if (editError) {
      editError.hidden = true;
      editError.textContent = "";
    }

    // Kalau dialognya **sudah terbuka**, `showModal()` melempar
    // `InvalidStateError` — dan karena pemanggilnya tidak menangkap
    // error itu, klik berikutnya jadi tidak melakukan apa-apa: user
    // menekan "Ubah" dan tidak terjadi apa-apa, tanpa pesan.
    //
    // Jalur ini bisa terjadi kalau dialog belum selesai ditutup dari
    // simpan sebelumnya (permintaan PATCH-nya masih berjalan) lalu
    // pengguna menekan "Ubah" lagi. Dialognya tidak perlu ditutup
    // lalu dibuka lagi — isinya sudah diperbarui di atas, jadi cukup
    // dibiarkan terbuka.
    if (!editDialog.open) {
      editDialog.showModal();
    }
  }

  function closeEditDialog() {
    if (editDialog?.open) editDialog.close();
    editingTaskId = null;
  }

  /**
   * Tutup dialog **hanya kalau** dialognya masih berisi tugas yang sama
   * dengan yang sedang disimpan.
   *
   * Simpan berlangsung secara asinkron: `await api.request("PATCH", ...)`
   * lalu baru dialog ditutup. Kalau user menekan "Ubah" pada tugas lain
   * di sela-selanya, dialognya berisi tugas yang **baru** — dan aksi
   * "tutup" milik simpan yang lama akan menutup dialog yang salah.
   *
   * Yang terjadi tanpa ini: pengguna menekan "Ubah" pada tugas kedua,
   * lalu tiba-tiba dialognya tertutup sendiri — isi yang baru saja
   * diketik hilang.
   */
  function closeEditDialogIf(taskId) {
    if (editingTaskId !== taskId) return;
    closeEditDialog();
  }

  if (editCancel) {
    editCancel.addEventListener("click", closeEditDialog);
  }

  if (editForm) {
    // Form ber-`method="dialog"`, jadi submit bawaan menutup dialog. Kita
    // intercept dulu supaya PATCH sempat jalan.
    editForm.addEventListener("submit", async (event) => {
      event.preventDefault();

      if (!editingTaskId) {
        closeEditDialog();
        return;
      }

      const reminder = readOffset(
        editReminder,
        editCustomAmount,
        editCustomUnit,
      );

      // Batas offset per-satuan dicek di sini — sama seperti form tambah.
      // Ditampilkan di dalam dialog, jadi user melihat apa yang salah
      // tanpa harus menutup dialog dulu.
      if (editReminder?.value === CUSTOM) {
        const amount = Number.parseInt(editCustomAmount?.value || "", 10);
        const unit = editCustomUnit?.value || "hours";
        const problem = validateCustomOffset(amount, unit);
        if (problem) {
          syncCustomHint(editCustomAmount, editCustomUnit, editCustomHint);
          if (editError) {
            editError.hidden = false;
            editError.textContent = problem;
            editError.style.color = "#b42318";
          }
          return;
        }
      }

      if (editSubmit) editSubmit.disabled = true;
      if (editError) {
        editError.hidden = true;
        editError.textContent = "";
      }

      // Id tugas yang sedang disimpan. Dialognya mungkin sudah berisi
      // tugas lain kalau user menekan "Ubah" lagi selagi PATCH ini
      // berjalan — lihat `closeEditDialogIf`.
      const savingTaskId = editingTaskId;

      try {
        await api.request(
          "PATCH",
          "/api/tasks/" + encodeURIComponent(editingTaskId) + "/edit/",
          {
            body: {
              title: editTitle?.value.trim() || "",
              due_date: editDeadline?.value ? editDeadline.value + ":00" : "",
              priority: editPriority?.value || "medium",
              course_id: editSubject?.value || null,
              description: editNotes?.value.trim() || "",
              reminder_enabled: Boolean(reminder),
              reminder_time: reminder || null,
            },
          },
        );

        closeEditDialogIf(savingTaskId);
        await reloadTasks();
      } catch (error) {
        // Error hanya ditampilkan kalau dialognya masih milik tugas
        // yang gagal disimpan. Kalau user sudah membuka tugas lain di
        // sela-selanya, pesan error milik tugas lama tidak boleh
        // muncul di dialog yang sekarang.
        if (editingTaskId !== savingTaskId) {
          showError(error.message);
          return;
        }

        if (editError) {
          editError.hidden = false;
          editError.textContent = error.message;
          editError.style.color = "#b42318";
        }
      } finally {
        if (editSubmit) editSubmit.disabled = false;
      }
    });
  }

  function buildTaskRow(task) {
    const completed = isCompleted(task);

    const item = document.createElement("article");
    item.className = "reminder-item" + (completed ? " completed" : "");
    item.dataset.taskId = task.id || "";

    const top = document.createElement("div");
    top.className = "reminder-item-top";

    const badge = document.createElement("span");
    badge.className = "badge " + (PRIORITY_BADGE[task.priority] || "blue");
    badge.textContent = PRIORITY_LABEL[task.priority] || "Sedang";

    const date = document.createElement("span");
    date.className = "reminder-date";
    date.textContent = formatDeadline(task.due_date);
    if (isOverdue(task)) {
      date.textContent = "Terlambat • " + date.textContent;
      date.style.color = "#b42318";
    }

    top.append(badge, date);

    const heading = document.createElement("h3");
    heading.textContent = task.title || "Tugas";

    const desc = document.createElement("p");
    // Tampilkan mata kuliah kalau ada; kalau tidak, pakai catatan tugas.
    const subject = courseName(task.course_id);
    desc.textContent = subject || task.description || "Tanpa catatan";

    const actions = document.createElement("div");
    actions.className = "reminder-item-top";

    // --- Tandai selesai -------------------------------------------------
    const doneButton = document.createElement("button");
    doneButton.className = "small-outline";
    doneButton.type = "button";
    doneButton.textContent = completed ? "Selesai" : "Tandai Selesai";
    doneButton.disabled = completed;

    doneButton.addEventListener("click", async () => {
      doneButton.disabled = true;
      try {
        await api.post(
          "/api/tasks/" + encodeURIComponent(task.id) + "/complete/",
        );
        // Ambil ulang daftar dari server supaya status, badge, dan
        // penghitung statistik ikut berubah sesuai data terbaru.
        await reloadTasks();
      } catch (error) {
        doneButton.disabled = false;
        showError(error.message);
      }
    });

    // --- Waktu pengingat ------------------------------------------------
    // Select per baris: daftar preset dari server. Kolom "kustom" tidak
    // ada di sini — untuk offset non-preset, pakai dialog "Ubah", yang
    // punya field jumlah + satuan.
    const rowReminderSelect = document.createElement("select");
    rowReminderSelect.className = "form-control";
    rowReminderSelect.title = "Waktu pengingat";
    rowReminderSelect.setAttribute(
      "aria-label",
      "Waktu pengingat untuk " + (task.title || "tugas"),
    );

    const noneOption = document.createElement("option");
    noneOption.value = "";
    noneOption.textContent = "Tanpa pengingat";
    rowReminderSelect.append(noneOption);

    reminderOptions.forEach((option) => {
      const element = document.createElement("option");
      element.value = option.value;
      element.textContent = option.label;
      rowReminderSelect.append(element);
    });

    if (task.reminder_time) {
      const known = reminderOptions.some(
        (option) => option.value === task.reminder_time,
      );
      // Offset non-preset tetap ditampilkan sebagai teks, kalau tidak
      // select-nya akan lompat ke "Tanpa pengingat" dan pengingat yang
      // sedang aktif terlihat hilang.
      if (known) {
        rowReminderSelect.value = task.reminder_time;
      } else {
        const customOption = document.createElement("option");
        customOption.value = task.reminder_time;
        customOption.textContent = task.reminder_time;
        rowReminderSelect.append(customOption);
        rowReminderSelect.value = task.reminder_time;
      }
    }
    rowReminderSelect.disabled = completed;

    rowReminderSelect.addEventListener("change", async () => {
      const chosen = rowReminderSelect.value;
      rowReminderSelect.disabled = true;
      try {
        await api.post(
          "/api/tasks/" + encodeURIComponent(task.id) + "/reminders/",
          { enabled: Boolean(chosen), time: chosen || null },
        );
        task.reminder_time = chosen || null;
        task.reminder_enabled = Boolean(chosen);
      } catch (error) {
        showError(error.message);
        rowReminderSelect.value = task.reminder_time || "";
      } finally {
        rowReminderSelect.disabled = completed;
      }
    });

    // --- Hapus ----------------------------------------------------------
    const deleteButton = document.createElement("button");
    deleteButton.className = "small-outline";
    deleteButton.type = "button";
    deleteButton.textContent = "Hapus";
    deleteButton.addEventListener("click", async () => {
      if (!window.confirm('Hapus tugas "' + (task.title || "") + '"?')) return;
      deleteButton.disabled = true;
      try {
        await api.del("/api/tasks/" + encodeURIComponent(task.id) + "/");
        await reloadTasks();
      } catch (error) {
        deleteButton.disabled = false;
        showError(error.message);
      }
    });

    // --- Ubah -----------------------------------------------------------
    const editButton = document.createElement("button");
    editButton.className = "small-outline";
    editButton.type = "button";
    editButton.textContent = "Ubah";
    editButton.addEventListener("click", () => {
      openEditDialog(task);
    });

    actions.append(doneButton, rowReminderSelect, editButton, deleteButton);

    item.append(top, heading, desc, actions);
    return item;
  }

  function showError(message) {
    const note = document.createElement("p");
    note.className = "form-note";
    note.style.color = "#b42318";
    note.textContent = message;
    list.prepend(note);
    setTimeout(() => note.remove(), 6000);
  }

  /**
   * Banner error yang bertahan di dalam daftar.
   *
   * `showError()` prepend note lalu menghapusnya 6 detik lagi - dan
   * `renderTasks()` memanggil `list.replaceChildren()`, jadi note itu
   * hilang setiap kali daftar dirender ulang. Untuk error yang perlu
   * disadari (mis. daftar gagal dimuat), note harus dibuat ulang
   * setiap render, bukan sekali di-prepend.
   */
  function loadErrorNode() {
    if (!loadError) return null;

    const wrapper = document.createElement("div");
    wrapper.className = "form-note list-load-error";
    wrapper.style.color = "#b42318";
    wrapper.setAttribute("role", "alert");
    wrapper.textContent = loadError;

    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "small-outline";
    retry.textContent = "Coba lagi";
    retry.addEventListener("click", async () => {
      retry.disabled = true;
      await reloadTasks();
    });
    wrapper.append(" ", retry);

    return wrapper;
  }

  function renderTasks() {
    list.replaceChildren();

    const errorNode = loadErrorNode();
    if (errorNode) list.append(errorNode);

    if (!tasks.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state compact-empty";

      const icon = document.createElement("span");
      icon.className = "material-symbols-outlined";
      // Empat kondisi dibedakan: sedang memuat, belum sempat dimuat,
      // gagal dimuat, dan memang tidak ada tugas. Semuanya terlihat
      // "kosong" kalau cuma dilihat dari isi daftar — padahal maknanya
      // berbeda jauh. Kalau tidak dibedakan, user mengira datanya hilang.
      icon.textContent = loadError
        ? "cloud_off"
        : tasksLoaded
          ? "task_alt"
          : "hourglass_empty";

      const text = document.createElement("p");
      if (loadError) {
        text.textContent = "Daftar tugas gagal dimuat. Coba muat ulang halaman.";
      } else if (!tasksLoaded) {
        text.textContent = "Memuat tugas...";
      } else {
        text.textContent = "Belum ada tugas. Tambahkan pengingat pertamamu di samping.";
      }

      empty.append(icon, text);
      list.append(empty);
    } else {
      // Urutkan: belum selesai dulu, lalu berdasarkan tenggat terdekat.
      const sorted = [...tasks].sort((a, b) => {
        if (isCompleted(a) !== isCompleted(b)) return isCompleted(a) ? 1 : -1;
        const at = a.due_date ? new Date(a.due_date).getTime() : Infinity;
        const bt = b.due_date ? new Date(b.due_date).getTime() : Infinity;
        return at - bt;
      });

      sorted.forEach((task) => list.append(buildTaskRow(task)));
    }

    updateStats();
  }

  // =====================================================
  // MATA KULIAH
  // =====================================================

  function fillCourseOptions() {
    const select = document.getElementById("taskSubject");
    if (!select || select.tagName !== "SELECT") return;

    const current = select.value;
    select.replaceChildren();

    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "Mata kuliah belum ditentukan";
    select.append(empty);

    courses.forEach((course) => {
      const option = document.createElement("option");
      option.value = course.id;
      option.textContent = course.code
        ? course.code + " — " + course.name
        : course.name;
      select.append(option);
    });

    // Pertahankan pilihan sebelumnya kalau masih valid.
    if (current) select.value = current;
  }

  async function loadCourses() {
    try {
      const data = await api.get("/api/courses/");
      courses = data.courses || [];
      fillCourseOptions();
    } catch (error) {
      // Daftar mata kuliah bukan hal wajib — form tetap bisa dipakai.
      console.warn("Daftar mata kuliah gagal dimuat:", error);
    }
  }

  // =====================================================
  // FORM
  // =====================================================

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const submitButton = form.querySelector("button[type='submit']");
    const title = document.getElementById("taskTitle")?.value.trim();
    const deadline = document.getElementById("taskDeadline")?.value;
    const priority = document.getElementById("taskPriority")?.value;
    const notes = document.getElementById("taskNotes")?.value.trim();
    const subject = document.getElementById("taskSubject")?.value;

    // Offset pengingat: preset atau hasil rakitan field kustom.
    const reminderTime = readOffset(reminderSelect, customAmount, customUnit);

    // Judul kosong: validasi peramban sudah menolak submit, jadi ini
    // hanya jaring pengaman — tapi **diam** saja lebih buruk, karena
    // user menekan Simpan dan melihat apa-apa terjadi.
    if (!title) {
      showError("Nama tugas tidak boleh kosong.");
      return;
    }

    // Offset kustom yang melebihi batas dicek di sini, bukan diserahkan ke
    // server: batasnya per-satuan, jadi pesan error bisa langsung tampil di
    // hint dengan bahasa Indonesia — dan request tidak dikirim sama sekali.
    if (reminderSelect?.value === CUSTOM) {
      const amount = Number.parseInt(customAmount?.value || "", 10);
      const unit = customUnit?.value || "hours";
      const problem = validateCustomOffset(amount, unit);
      if (problem) {
        syncCustomHint(customAmount, customUnit, customHint);
        showError(problem);
        return;
      }
    }

    if (submitButton) submitButton.disabled = true;

    // Form dikosongkan **sebelum** menunggu server, bukan sesudahnya.
    //
    // Dulu `form.reset()` dipanggil setelah `await reloadTasks()`. Kalau
    // pemuatan daftar lambat (server sedang sibuk, atau tab lain sedang
    // memuat), reset-nya baru jalan belakangan — **setelah** user sudah
    // mengisi form berikutnya. Akibatnya isi form yang baru diketik hilang
    // tanpa jejak, dan submit berikutnya keluar diam-diam di
    // `if (!title) return`: user menekan Simpan, tidak ada request yang
    // dikirim, tidak ada pesan yang muncul. Diuji ulang dengan
    // `probe_form_reset.js` — dua submit, hanya satu yang sampai ke server.
    //
    // Reset di sini sinkron: begitu request terkirim, form sudah kosong
    // dan siap untuk isian berikutnya.
    form.reset();
    syncCustomVisibility(reminderSelect, customBox);
    syncCustomHint(customAmount, customUnit, customHint);

    try {
      const data = await api.post("/api/tasks/create/", {
        title,
        // Backend menyimpan jam dinding apa adanya (tanpa zona waktu).
        due_date: deadline ? deadline + ":00" : "",
        priority: PRIORITY_MAP[priority] || "medium",
        description: notes || undefined,
        course_id: subject || undefined,
        reminder_enabled: Boolean(reminderTime),
        reminder_time: reminderTime || null,
      });

      const task = data.task || {};
      if (task.id) tasks = [task, ...tasks];
      await reloadTasks();
    } catch (error) {
      showError(error.message);
    } finally {
      if (submitButton) submitButton.disabled = false;
    }
  });

  // =====================================================
  // MUAT DATA AWAL
  // =====================================================

  // Daftar tugas milik halaman ini. **Tidak** diambil sendiri dari
  // server — diambil dari snapshot bersama di `api.js`, supaya badge
  // sidebar dan kartu statistik di halaman ini memakai data yang sama.
  //
  // Dulu halaman ini memanggil `/api/tasks/` sendiri sementara modul
  // badge memanggilnya juga. Dua permintaan, dua jawaban — dan kalau
  // isinya berbeda, sidebar dan kartu menampilkan angka berbeda di
  // halaman yang sama. `probe_race_splitbrain.js` memunculkan
  // badge=1 sementara kartu=0 di halaman ini.
  function currentTasks() {
    return api.taskSnapshot?.().tasks || tasks;
  }

  // Ambil daftar tugas terbaru dari server. Dipakai setelah setiap mutasi
  // supaya angka statistik dan isi daftar selalu konsisten dengan backend.
  async function reloadTasks() {
    // Tandai sedang memuat SEBELUM request. Tanpa ini, halaman sempat
    // menampilkan angka "0" dan "Belum ada tugas" selama menunggu
    // jawaban server — padahal jawabannya belum diketahui. Itu yang
    // bikin halaman terlihat kosong setiap kali di-refresh.
    tasksLoading = true;
    loadError = null;
    renderTasks();

    try {
      const data = await api.refreshTasks();
      tasks = data.tasks || [];
      tasksLoaded = true;
    } catch (error) {
      // Error dicatat, bukan ditelan: kalau tidak, halaman menampilkan
      // "Belum ada tugas" padahal server-nya hanya sedang tidak
      // merespons. Data lama (kalau ada) tetap ditampilkan — jadi user
      // tidak kehilangan konteks.
      loadError =
        "Daftar tugas gagal dimuat: " + (error.message || "tidak diketahui");
    } finally {
      tasksLoading = false;
    }

    renderTasks();

    // Badge "mendesak" di sidebar ikut disegarkan di sini — dan hanya
    // di sini. `reloadTasks()` adalah satu-satunya tempat daftarnya
    // berubah, jadi ini juga satu-satunya tempat badge perlu
    // disegarkan. Menempelkan pemanggilan di tiap handler mutasi
    // berarti ada jalur yang lupa memanggilnya.
    refreshSidebarBadge();
  }

  reloadTasks();
  loadCourses();
  loadReminderOptions();

  // Berlangganan snapshot tugas bersama.
  //
  // Badge sidebar dan kartu statistik di halaman ini membaca snapshot
  // yang sama — jadi keduanya tidak mungkin menampilkan angka berbeda.
  // Ketika snapshot berubah (mis. tugas diselesaikan dari tab lain),
  // daftar di halaman ini ikut digambar ulang dari data yang sama.
  api.subscribeTasks?.((snapshot) => {
    if (!snapshot || !snapshot.loaded) return;
    tasks = snapshot.tasks || [];
    tasksLoaded = true;
    loadError = null;
    renderTasks();
  });

  // Notifikasi (panel web + notifikasi peramban) dipasang oleh modul
  // bersama ``notifications.js`` — lonceng dan panelnya ada di
  // base.html, jadi halaman ini memakai modul yang sama dengan dashboard.
  window.AkademiaNotifications?.mount();
});
