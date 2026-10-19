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
  // DATA DEMO JADWAL
  // =====================================================

  const schedules = [
    {
      day: 0,
      start: "08:00",
      end: "10:00",
      name: "IF3110",
      detail: "Rekayasa Perangkat Lunak",
      type: "kuliah",
      room: "Ruang A-201",
      code: "IF3110",
      lecturer: "Dosen Pengampu IF3110",
      topic: "Pengantar Rekayasa Perangkat Lunak",
      description:
        "Mempelajari konsep dasar, proses, dan praktik dalam pengembangan perangkat lunak.",
      summary:
        "Rekayasa Perangkat Lunak menerapkan pendekatan sistematis untuk merancang, membangun, menguji, dan memelihara perangkat lunak.",
      files: [],
      assignment: "Belum ada tugas",
      deadline: "Belum ada informasi deadline",
    },
    {
      day: 0,
      start: "10:00",
      end: "12:00",
      name: "IF3110",
      detail: "Kecerdasan Buatan",
      type: "kuliah",
      room: "Ruang A-201",
      code: "IF3110",
      lecturer: "Dr. Eng. Ir. Budi",
      topic: "Transformer Architecture dan Multi-Head Attention",
      description:
        "Mempelajari mekanisme Self-Attention, Query, Key, Value, dan penggunaan Multi-Head Attention dalam arsitektur Transformer.",
      summary:
        "Self-Attention membantu model memahami hubungan antar-token. Multi-Head Attention memungkinkan model mempelajari beberapa jenis hubungan secara paralel.",
      files: [
        {
          name: "IF3110_Sesi08_Transformer_Attention.pptx",
          description:
            "48 Halaman Slide • 86 Chunks • Embeddings: text-embedding-3-small",
          type: "pptx",
        },
        {
          name: "Diktat_AI_Bab7_SequenceModels.pdf",
          description: "Bab 7 Hal 120–154 • 62 Chunks • Hybrid BM25+Vector",
          type: "pdf",
        },
        {
          name: "Audio_Transcript_Sesi07_Review.txt",
          description:
            "Sinkron Lecture Listener • Whisper Large v3 • 36 Chunks",
          type: "txt",
        },
      ],
      assignment: "Tugas Eksplorasi Multi-Head Attention",
      deadline: "Kamis, 24 Okt 17:00 WIB",
    },
    {
      day: 0,
      start: "13:00",
      end: "15:00",
      name: "IF3121",
      detail: "Praktikum Basis Data",
      type: "praktikum",
      room: "Lab Komputer",
      code: "IF3121",
      lecturer: "Dosen Praktikum Basis Data",
      topic: "Praktikum Basis Data",
      description: "Latihan penerapan konsep basis data dan query SQL.",
      summary:
        "Praktikum berfokus pada perancangan tabel, relasi, dan penggunaan SQL.",
      files: [],
      assignment: "Belum ada tugas",
      deadline: "Belum ada informasi deadline",
    },
    {
      day: 1,
      start: "09:00",
      end: "11:00",
      name: "IF3120",
      detail: "Pemrograman Web",
      type: "kuliah",
      room: "Ruang B-102",
      code: "IF3120",
      lecturer: "Dosen Pengampu IF3120",
      topic: "Dasar Pemrograman Web",
      description:
        "Membahas konsep pengembangan aplikasi web dan teknologi yang digunakan.",
      summary:
        "Pengembangan web melibatkan sisi frontend, backend, dan komunikasi dengan basis data.",
      files: [],
      assignment: "Belum ada tugas",
      deadline: "Belum ada informasi deadline",
    },
    {
      day: 2,
      start: "08:00",
      end: "10:00",
      name: "IF3121",
      detail: "Praktikum Basis Data",
      type: "praktikum",
      room: "Lab Komputer",
      code: "IF3121",
      lecturer: "Dosen Praktikum Basis Data",
      topic: "Query dan Relasi Basis Data",
      description: "Latihan query SQL dan pengelolaan relasi antar tabel.",
      summary:
        "SQL digunakan untuk mengambil, menambah, mengubah, dan menghapus data.",
      files: [],
      assignment: "Belum ada tugas",
      deadline: "Belum ada informasi deadline",
    },
    {
      day: 3,
      start: "10:00",
      end: "12:00",
      name: "IF3130",
      detail: "Interaksi Manusia dan Komputer",
      type: "kuliah",
      room: "Ruang C-201",
      code: "IF3130",
      lecturer: "Dosen Pengampu IF3130",
      topic: "Prinsip Desain Antarmuka",
      description:
        "Mempelajari prinsip perancangan antarmuka yang mudah dipahami dan digunakan.",
      summary:
        "Antarmuka yang baik memperhatikan konsistensi, umpan balik, aksesibilitas, dan kebutuhan pengguna.",
      files: [],
      assignment: "Belum ada tugas",
      deadline: "Belum ada informasi deadline",
    },
    {
      day: 4,
      start: "08:00",
      end: "10:00",
      name: "IF3140",
      detail: "Pengujian Perangkat Lunak",
      type: "kuliah",
      room: "Ruang A-202",
      code: "IF3140",
      lecturer: "Dosen Pengampu IF3140",
      topic: "Dasar Pengujian Perangkat Lunak",
      description:
        "Membahas tujuan, strategi, dan jenis pengujian perangkat lunak.",
      summary:
        "Pengujian dilakukan untuk menemukan cacat dan memeriksa apakah perangkat lunak memenuhi kebutuhan.",
      files: [],
      assignment: "Belum ada tugas",
      deadline: "Belum ada informasi deadline",
    },
  ];

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

  function formatDate(date) {
    return date.toLocaleDateString("id-ID", {
      day: "numeric",
      month: "short",
    });
  }

  function formatLongDate(date) {
    return date.toLocaleDateString("id-ID", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  }

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
  // RENDER KALENDER
  // =====================================================

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

          const matchesFilter =
            !filter || filter.value === "all" || schedule.type === filter.value;

          return matchesDay && matchesFilter;
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
  // FILE MATERI
  // =====================================================

  function renderMaterialFiles(files) {
    const container = $("#materialFiles");
    if (!container) return;

    container.replaceChildren();

    if (!Array.isArray(files) || files.length === 0) {
      const empty = document.createElement("p");
      empty.className = "material-empty";
      empty.textContent = "Belum ada berkas materi.";
      container.appendChild(empty);
      return;
    }

    files.forEach((file) => {
      const item = document.createElement("div");
      item.className = "material-file";

      const icon = document.createElement("div");
      const isPdf =
        file.type === "pdf" || file.name.toLowerCase().endsWith(".pdf");

      icon.className = `file-icon ${isPdf ? "red" : "purple"}`;
      icon.textContent = isPdf ? "▤" : "▣";

      const info = document.createElement("div");
      info.className = "file-info";

      const name = document.createElement("strong");
      name.textContent = file.name;

      const description = document.createElement("small");
      description.textContent = file.description || "Berkas materi";

      info.append(name, description);

      const action = document.createElement("button");
      action.type = "button";
      action.className = "file-action";
      action.textContent = "Pratinjau";

      action.addEventListener("click", () => {
        showToast(
          "Pratinjau file perlu dihubungkan dengan penyimpanan berkas.",
        );
      });

      item.append(icon, info, action);
      container.appendChild(item);
    });
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

    setText(
      "materialSummary",
      schedule.summary || "Belum ada ringkasan materi.",
    );

    setText("assignmentTitle", schedule.assignment || "Belum ada tugas");

    setText("assignmentTitlePreview", schedule.assignment || "Belum ada tugas");

    setText(
      "assignmentDeadline",
      schedule.deadline || "Belum ada informasi deadline",
    );

    setText(
      "assignmentDeadlinePreview",
      schedule.deadline || "Belum ada informasi deadline",
    );

    const [startHour, startMinute] = schedule.start.split(":").map(Number);

    const [endHour, endMinute] = schedule.end.split(":").map(Number);

    const durationMinutes =
      endHour * 60 + endMinute - (startHour * 60 + startMinute);

    setText(
      "materialDuration",
      durationMinutes > 0 ? `${durationMinutes / 60} jam` : "-",
    );

    setText("materialCategory", schedule.type);

    renderMaterialFiles(schedule.files);

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

    materialModal.hidden = false;
    materialModal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";

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

  $("#saveMaterialNotes")?.addEventListener("click", () => {
    const notes = $("#materialNotes")?.value.trim();

    if (!notes) {
      showToast("Catatan masih kosong.");
      return;
    }

    // Demo frontend: belum menyimpan ke database.
    showToast("Catatan siap disimpan. Integrasi database belum tersedia.");
  });

  $("#saveMaterialSummary")?.addEventListener("click", () => {
    if (!activeSchedule) {
      showToast("Pilih jadwal terlebih dahulu.");
      return;
    }

    showToast("Fitur penyimpanan rangkuman ujian belum terhubung ke backend.");
  });

  // =====================================================
  // TANYA DOSEN AI - DEMO
  // =====================================================

  function handleChatSubmit(event, inputSelector) {
    event.preventDefault();

    const input = $(inputSelector);
    if (!input) return;

    const question = input.value.trim();
    if (!question) return;

    showToast("Pertanyaan diterima. Layanan AI belum terhubung ke backend.");

    input.value = "";
  }

  $("#materialChatForm")?.addEventListener("submit", (event) => {
    handleChatSubmit(event, "#materialChatInput");
  });

  $("#materialChatFormPreview")?.addEventListener("submit", (event) => {
    handleChatSubmit(event, "#materialChatInputPreview");
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
  // SINKRONISASI SIAM - DEMO
  // =====================================================

  $("#syncSiam")?.addEventListener("click", () => {
    setText("portalStatus", "Demo Sinkronisasi");
    setText("lastSync", `Percobaan: ${new Date().toLocaleTimeString("id-ID")}`);

    showToast("Demo: integrasi SIAM belum dihubungkan ke backend.");
  });

  $("#rescrapeBtn")?.addEventListener("click", () => {
    showToast("Demo: proses scraping membutuhkan integrasi backend.");
  });

  // =====================================================
  // UPLOAD KRS
  // =====================================================

  $("#krsFile")?.addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setText("fileName", file.name);

    showToast(
      `File KRS dipilih: ${file.name}. Pembacaan PDF belum terhubung ke backend.`,
    );
  });

  // =====================================================
  // OPTIMASI JADWAL - DEMO
  // =====================================================

  $("#optimizeBtn")?.addEventListener("click", () => {
    const avoidConflict = $("#avoidConflict")?.checked ?? false;
    const preferMorning = $("#preferMorning")?.checked ?? false;
    const includeConsultation = $("#includeConsultation")?.checked ?? false;

    const result = $("#optimizationResult");
    if (!result) return;

    const preferences = [];

    if (avoidConflict) {
      preferences.push("menghindari jadwal bentrok");
    }

    if (preferMorning) {
      preferences.push("memprioritaskan jadwal pagi");
    }

    if (includeConsultation) {
      preferences.push("memasukkan konsultasi dosen");
    }

    result.hidden = false;

    result.textContent = preferences.length
      ? `Simulasi preferensi: ${preferences.join(", ")}. Ini masih simulasi frontend.`
      : "Pilih setidaknya satu preferensi untuk simulasi.";

    showToast("Simulasi preferensi selesai.");
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
      const date = new Date(monday);
      date.setDate(monday.getDate() + schedule.day);

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

  $$("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      showToast(
        `${button.dataset.action}: fitur ini masih berupa demo frontend.`,
      );
    });
  });

  // =====================================================
  // INTEGRASI MODUL PADA BOX DETAIL
  // =====================================================

  $$(".material-integration-primary").forEach((button) => {
    button.addEventListener("click", () => {
      showToast("RAG Assistant perlu dihubungkan dengan modul terkait.");
    });
  });

  $$(".material-integration-buttons button").forEach((button) => {
    button.addEventListener("click", () => {
      showToast(
        `${button.textContent.trim()} belum terhubung ke modul backend.`,
      );
    });
  });

  // =====================================================
  // MULAI HALAMAN
  // =====================================================

  renderCalendar();
});
