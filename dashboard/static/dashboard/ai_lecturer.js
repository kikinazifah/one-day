/**
 * AI Lecturer (Dosen AI) — terhubung ke backend FastAPI (student-assistant)
 * lewat endpoint JSON Django (dashboard/views_api_lecturer.py):
 *
 *   GET   /api/lecturer/personas/           → daftar persona
 *   POST  /api/lecturer/persona/            → buat persona
 *   PATCH /api/lecturer/persona/<id>/       → ubah persona
 *   POST  /api/lecturer/chat/               → kirim pesan, terima balasan
 *   POST  /api/lecturer/chat/sessions/      → buat sesi chat baru
 *   GET   /api/lecturer/chat/<session_id>/  → riwayat percakapan
 *   POST  /api/lecturer/chat/<session_id>/delete/ → hapus sesi
 *   GET   /api/lecturer/reports/            → daftar laporan mingguan
 *   GET   /api/lecturer/reports/<id>/        → detail satu laporan
 *   POST  /api/lecturer/reports/generate/   → trigger pembuatan laporan
 *   GET   /api/lecturer/videos/             → daftar job video
 *   POST  /api/lecturer/videos/generate/    → buat job video
 *   GET   /api/lecturer/videos/<id>/        → status satu job (polling)
 *   GET   /api/lecturer/videos/<id>/file/   → proxy file video
 *
 * Backend tidak punya endpoint "daftar sesi chat", jadi id sesi disimpan di
 * sessionStorage agar percakapan tetap ada saat halaman di-refresh.
 *
 * Catatan soal sesi: `session_id` yang dikirim ke backend **wajib** ikut
 * pada setiap pesan. Kalau tidak, backend menempelkan pesan ke sesi
 * terakhir persona — artinya "mulai percakapan baru" hanya mengosongkan
 * tampilan, sementara riwayatnya masih menempel di sesi yang sama dan
 * muncul lagi saat halaman di-refresh.
 */
document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("lecturerForm");
  const input = document.getElementById("lecturerInput");
  const chat = document.getElementById("lecturerChat");
  const clearButton = document.getElementById("clearLecturerChat");
  const personaSelect = document.getElementById("lecturerPersonaSelect");
  const personaName = document.getElementById("lecturerPersonaName");
  const personaMeta = document.getElementById("lecturerPersonaMeta");
  const courseSelect = document.getElementById("lecturerCourseSelect");
  const useRagToggle = document.getElementById("lecturerUseRag");

  if (!form || !input || !chat) return;

  // Persona aktif, daftar persona, dan id sesi chat terakhir.
  let personas = [];
  let currentPersonaId = "";
  let sessionId = sessionStorage.getItem("lecturerSessionId") || "";
  let chatBusy = false;

  // Retrieval: mata kuliah yang dipilih dan apakah dokumen sendiri dipakai.
  //
  // Tanpa ``course_id``, backend tidak bisa menyaring dokumen ke mata
  // kuliah tertentu — soalnya guard-nya ``if use_rag and course_id and
  // user_id``. Jadi pilihan MK bukan hiasan: tanpa itu, RAG diam-diam
  // tidak jalan sama sekali.
  let courses = [];
  let selectedCourseId = "";

  // Badge status video → kelas warna yang tersedia di style.css.
  const VIDEO_STATUS_BADGE = {
    queued: "blue",
    processing: "amber",
    done: "green",
    failed: "red",
  };
  const VIDEO_STATUS_LABEL = {
    queued: "Menunggu",
    processing: "Diproses",
    done: "Selesai",
    failed: "Gagal",
  };

  // =====================================================
  // TOAST
  // =====================================================

  const toast = document.getElementById("toast");
  let toastTimeout;

  function showToast(message) {
    if (!toast) {
      console.info(message);
      return;
    }

    toast.textContent = message;
    toast.classList.add("visible");

    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove("visible"), 4000);
  }

  // =====================================================
  // HTTP
  // =====================================================

  // Klien API bersama (dashboard/api.js). Semua request lewat sini.
  //
  // Helper lokal (`getJson`/`postJson`/`patchJson`) di bawah cuma **nama
  // lain** untuk fungsi yang sama — sengaja dipertahankan supaya call site
  // tidak berubah semua. Yang berubah: request tidak lagi `fetch` mentah,
  // tapi lewat `api.js` yang sudah menangani header CSRF, error, dan batas
  // waktu.
  //
  // Guard `if (!api) return;` itu wajib: baris ini ada di top-level
  // handler ``DOMContentLoaded``, jadi lempar di sini mematikan **seluruh**
  // handler — persona, chat, laporan, dan video ikut hilang.
  const api = window.AkademiaApi;

  if (!api) {
    showToast("Modul API gagal dimuat — halaman tidak bisa memuat data.");
    return;
  }

  const getJson = (url) => api.get(url);
  const postJson = (url, body) => api.post(url, body);
  const patchJson = (url, body) => api.patch(url, body);

  // --------------------------------------------------------------- sesi chat

  /**
   * Pastikan ada sesi chat yang bisa dipakai untuk pesan berikutnya.
   *
   * Kalau `sessionId` masih ada, dia dipakai lagi — supaya riwayat
   * percakapan tetap nyambung setelah halaman di-refresh. Kalau belum,
   * sesi baru dibuat di backend.
   *
   * Penting: sesi dibuat di **backend**, bukan cuma di memori halaman.
   * Dulu tombol Clear hanya mengosongkan DOM dan menghapus
   * sessionStorage — backend tetap memakai sesi lama, jadi pesan berikutnya
   * menempel ke riwayat yang baru saja dikosongkan.
   *
   * Promise-nya di-memoize: Clear dan pengiriman pesan bisa berjalan
   * berdekatan, dan tanpa ini dua permintaan "buat sesi" terkirim
   * bersamaan — backend membuat dua sesi, dan yang terakhir menimpa
   * yang pertama. Efeknya: sesi yang tercatat di sessionStorage bukan
   * sesi tempat pesan sebenarnya tersimpan.
   */
  let sessionPromise = null;

  async function ensureSession() {
    if (sessionId) return sessionId;
    if (!currentPersonaId) return "";
    if (sessionPromise) return sessionPromise;

    sessionPromise = postJson("/api/lecturer/chat/sessions/", {
      persona_id: currentPersonaId,
      title: "Percakapan baru",
    })
      .then((data) => {
        sessionId = (data.session && data.session.id) || "";
        if (sessionId) {
          sessionStorage.setItem("lecturerSessionId", sessionId);
        }
        return sessionId;
      })
      .finally(() => {
        sessionPromise = null;
      });

    return sessionPromise;
  }

  // =====================================================
  // CHAT
  // =====================================================

  function addMessage(text, sender) {
    const message = document.createElement("div");
    message.className =
      sender === "user"
        ? "lecturer-message user"
        : "lecturer-message assistant";

    const content = document.createElement("p");
    // textContent sudah escaped browser — tidak ada HTML dari server yang
    // dieksekusi.
    content.textContent = text;

    message.append(content);
    chat.append(message);
    chat.scrollTop = chat.scrollHeight;
    return message;
  }

  /**
   * Render kartu sumber di bawah jawaban.
   *
   * Sumber-sumber ini dokumen yang jadi dasar jawaban — jadi mahasiswa
   * bisa cek sendiri apakah petikan yang dipakai Dosen AI benar-benar
   * ada di dokumennya. Tanpa ini, mahasiswa tak punya cara tahu jawaban
   * itu bersandar pada apa.
   *
   * Semua isi dibuat lewat ``textContent`` — nama file dan cuplikan
   * dokumen coming dari server dan tak boleh dieksekusi sebagai HTML.
   */
  function addSources(sources) {
    if (!Array.isArray(sources) || !sources.length) return null;

    const block = document.createElement("div");
    block.className = "lecturer-sources";

    const title = document.createElement("div");
    title.className = "lecturer-sources-title";
    title.textContent =
      sources.length === 1
        ? "1 sumber dokumen"
        : sources.length + " sumber dokumen";
    block.append(title);

    const list = document.createElement("ul");
    list.className = "lecturer-sources-list";

    sources.forEach((source, index) => {
      const metadata = source.metadata || {};
      const item = document.createElement("li");
      item.className = "lecturer-source";

      const label = document.createElement("span");
      label.className = "lecturer-source-label";
      label.textContent =
        "[" + (index + 1) + "] " +
        (metadata.file_name || metadata.source || "Dokumen");
      item.append(label);

      const snippet = (source.text || "").trim();
      if (snippet) {
        const excerpt = document.createElement("p");
        excerpt.className = "lecturer-source-excerpt";
        excerpt.textContent = snippet.length > 260 ? snippet.slice(0, 260) + "…" : snippet;
        item.append(excerpt);
      }

      list.append(item);
    });

    block.append(list);
    chat.append(block);
    chat.scrollTop = chat.scrollHeight;
    return block;
  }

  function addTyping() {
    const typing = document.createElement("div");
    typing.className = "lecturer-message assistant lecturer-typing";
    typing.id = "lecturerTyping";

    const content = document.createElement("p");
    content.textContent = "Mengetik…";

    typing.append(content);
    chat.append(typing);
    chat.scrollTop = chat.scrollHeight;
    return typing;
  }

  function removeTyping() {
    document.getElementById("lecturerTyping")?.remove();
  }

  function currentPersona() {
    return personas.find((persona) => persona.id === currentPersonaId) || null;
  }

  // =====================================================
  // MATA KULIAH (untuk retrieval)
  // =====================================================

  /**
   * Muat daftar mata kuliah milik pengguna.
   *
   * Gagal memuat tidak boleh menggagalkan halaman — daftar MK cuma
   * memengaruhi retrieval, bukan chat biasa. Jadi error-nya ditelan dan
   * dropdown dibiarkan kosong.
   */
  async function loadCourses() {
    // Jangan berhenti di sini kalau `courseSelect` tidak ada — daftar
    // mata kuliah juga dipakai untuk mengisi filter video.
    if (!courseSelect && !videoCourseFilter) return;

    try {
      const data = await getJson("/api/courses/");
      courses = Array.isArray(data.courses) ? data.courses : [];
    } catch (error) {
      courses = [];
      showToast("Daftar mata kuliah gagal dimuat: " + error.message);
    }

    renderCourseSelect();
    renderVideoCourseFilter();
  }

  function renderCourseSelect() {
    if (!courseSelect) return;

    courseSelect.replaceChildren();

    const all = document.createElement("option");
    all.value = "";
    all.textContent = "Semua mata kuliah";
    courseSelect.append(all);

    courses.forEach((course) => {
      const option = document.createElement("option");
      option.value = course.id;
      option.textContent = course.code
        ? course.code + " — " + (course.name || "")
        : course.name || course.id;
      courseSelect.append(option);
    });

    courseSelect.value = selectedCourseId;
    syncRagAvailability();
  }

  /**
   * RAG cuma bisa jalan kalau mata kuliah dipilih.
   *
   * Alasannya di backend: guard retrieval adalah
   * ``if use_rag and course_id and user_id``. Jadi toggle yang menyala
   * tanpa MK yang dipilih hanya menjanjikan sesuatu yang tak terjadi.
   * Toggle-nya dinonaktifkan, dan alasannya ditampilkan lewat ``title``.
   */
  function syncRagAvailability() {
    if (!useRagToggle) return;

    const ready = Boolean(selectedCourseId);
    useRagToggle.disabled = !ready;
    useRagToggle.closest(".lecturer-rag-toggle")?.classList.toggle("is-disabled", !ready);

    if (!ready) {
      useRagToggle.checked = false;
      useRagToggle.closest(".lecturer-rag-toggle")?.setAttribute(
        "title",
        "Pilih mata kuliah dulu supaya dokumen yang dipakai bisa disaring"
      );
    } else {
      useRagToggle.closest(".lecturer-rag-toggle")?.setAttribute(
        "title",
        "Jawab memakai dokumen yang kamu unggah"
      );
    }
  }

  function renderPersonaHeader() {
    const persona = currentPersona();
    if (!persona) {
      if (personaName) personaName.textContent = "Dosen AI Akademia";
      if (personaMeta) {
        personaMeta.textContent = "Asisten belajar untuk berbagai mata kuliah";
      }
      return;
    }

    if (personaName) personaName.textContent = persona.name || "Dosen AI";
    if (personaMeta) {
      const style = persona.style || "friendly";
      const label = style.charAt(0).toUpperCase() + style.slice(1);
      const course = persona.course_id ? " · " + persona.course_id : "";
      personaMeta.textContent = "Gaya " + label + course;
    }
  }

  function renderPersonaSelect() {
    if (!personaSelect) return;

    personaSelect.replaceChildren();

    if (!personas.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "Belum ada persona";
      personaSelect.append(option);
      personaSelect.disabled = true;
      return;
    }

    personas.forEach((persona) => {
      const option = document.createElement("option");
      option.value = persona.id;
      option.textContent = persona.name || "Dosen AI";
      personaSelect.append(option);
    });

    personaSelect.disabled = false;
    personaSelect.value = currentPersonaId;
  }

  async function sendMessage(text) {
    const question = (text || "").trim();
    if (!question || chatBusy) return;

    if (!currentPersonaId) {
      showToast("Belum ada persona aktif. Coba muat ulang halaman.");
      return;
    }

    chatBusy = true;
    addMessage(question, "user");
    addTyping();

    try {
      // Sesi dibuat dulu kalau belum ada — supaya pesan ini masuk ke sesi
      // yang jelas, bukan ke "sesi terakhir" yang mungkin sisa dari
      // percakapan sebelumnya.
      const target = await ensureSession();

      const payload = {
        persona_id: currentPersonaId,
        message: question,
      };
      if (target) payload.session_id = target;

      // Retrieval. Dua-duanya wajib: backend hanya menyentuh dokumen kalau
      // ``course_id`` **dan** ``use_rag`` sama-sama benar. Tanpa MK yang
      // dipilih, RAG tak akan jalan walau toggle-nya menyala.
      const useRag = Boolean(useRagToggle?.checked && selectedCourseId);
      if (selectedCourseId) payload.course_id = selectedCourseId;
      if (useRag) payload.use_rag = true;

      const data = await postJson("/api/lecturer/chat/", payload);

      removeTyping();
      addMessage(data.response || "(Tidak ada balasan dari Dosen AI.)", "assistant");
      addSources(data.sources);

      if (data.session_id) {
        sessionId = data.session_id;
        sessionStorage.setItem("lecturerSessionId", sessionId);
      }
    } catch (error) {
      removeTyping();
      addMessage("Maaf, pesan gagal terkirim: " + error.message, "assistant");
      showToast(error.message);
    } finally {
      chatBusy = false;
      input.value = "";
      input.focus();
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    sendMessage(input.value);
  });

  // --------------------------------------------------------------- retrieval

  if (courseSelect) {
    courseSelect.addEventListener("change", () => {
      selectedCourseId = courseSelect.value || "";
      syncRagAvailability();
    });
  }

  if (useRagToggle) {
    useRagToggle.addEventListener("change", syncRagAvailability);
  }

  // Enter mengirim, Shift+Enter menambah baris baru.
  //
  // Tanpa ini, Promise di bawah ("Enter untuk mengirim") tidak benar —
  // Enter di <textarea> hanya menambah baris baru dan form tidak pernah
  // terkirim.
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    // Enter bisa saja dipakai IME untuk memilih kandidat karakter —
    // dalam kasus itu jangan kirim.
    if (event.isComposing) return;

    event.preventDefault();
    form.requestSubmit
      ? form.requestSubmit()
      : sendMessage(input.value);
  });

  // Tombol cepat (dan "ide sesi belajar") langsung mengirim pertanyaannya,
  // bukan sekadar mengisi kolom input.
  document.querySelectorAll("[data-prompt]").forEach((button) => {
    button.addEventListener("click", () => {
      sendMessage(button.dataset.prompt || "");
    });
  });

  if (clearButton) {
    clearButton.addEventListener("click", async () => {
      // Tampilan dikosongkan duluan supaya terasa responsif.
      chat.replaceChildren();
      sessionId = "";
      sessionPromise = null;
      sessionStorage.removeItem("lecturerSessionId");

      // Sesi baru dibuat di backend. Tanpa ini, "mulai percakapan baru"
      // hanya mengosongkan tampilan: backend masih memakai sesi lama,
      // jadi pesan berikutnya menempel ke riwayat yang baru saja
      // dibersihkan — dan riwayat lama muncul lagi saat halaman di-refresh.
      try {
        await ensureSession();
        showToast("Percakapan baru dimulai.");
      } catch (error) {
        showToast("Gagal memulai percakapan baru: " + error.message);
      }
    });
  }

  async function loadHistory() {
    if (!sessionId) return;

    try {
      const data = await getJson(
        "/api/lecturer/chat/" + encodeURIComponent(sessionId) + "/"
      );
      const messages = data.messages || [];
      if (!messages.length) return;

      chat.replaceChildren();
      messages.forEach((message) => {
        addMessage(
          message.content || "",
          message.role === "user" ? "user" : "assistant"
        );
      });
    } catch (error) {
      // Sesi hilang di backend (mis. dihapus) → mulai baru.
      sessionId = "";
      sessionStorage.removeItem("lecturerSessionId");
      showToast("Riwayat percakapan lama tidak ditemukan: " + error.message);
    }
  }

  // =====================================================
  // PERSONA
  // =====================================================

  const personaList = document.getElementById("lecturerPersonaList");
  const personaForm = document.getElementById("lecturerPersonaForm");
  const personaIdField = document.getElementById("personaId");
  const personaSubmitLabel = document.getElementById("lecturerPersonaSubmitLabel");
  const personaFormTitle = document.getElementById("lecturerPersonaFormTitle");
  const personaReset = document.getElementById("lecturerPersonaReset");

  function emptyState(icon, title, text) {
    const wrapper = document.createElement("div");
    wrapper.className = "lecturer-empty";

    const iconEl = document.createElement("span");
    iconEl.className = "material-symbols-outlined";
    iconEl.textContent = icon;

    const heading = document.createElement("strong");
    heading.textContent = title;

    const note = document.createElement("p");
    note.textContent = text;

    wrapper.append(iconEl, heading, note);
    return wrapper;
  }

  function renderPersonaList() {
    if (!personaList) return;

    personaList.replaceChildren();

    if (!personas.length) {
      personaList.append(
        emptyState(
          "person_off",
          "Belum ada persona",
          "Buat persona pertama lewat formulir di samping."
        )
      );
      return;
    }

    personas.forEach((persona) => {
      const row = document.createElement("div");
      row.className = "lecturer-row";

      const main = document.createElement("div");
      main.className = "lecturer-row-main";

      const name = document.createElement("strong");
      name.textContent = persona.name || "Dosen AI";

      const meta = document.createElement("small");
      const style = persona.style || "friendly";
      const label = style.charAt(0).toUpperCase() + style.slice(1);
      meta.textContent =
        "Gaya " + label + " · " + (persona.language || "id") +
        (persona.is_active ? "" : " · nonaktif");

      main.append(name, meta);

      const badge = document.createElement("span");
      badge.className = "badge " + (persona.is_active ? "green" : "blue");
      badge.textContent = persona.is_active ? "Aktif" : "Nonaktif";

      const actions = document.createElement("div");
      actions.className = "lecturer-row-actions";

      const useButton = document.createElement("button");
      useButton.type = "button";
      useButton.className = "lecturer-ghost-button";
      useButton.textContent = "Pakai";
      useButton.disabled = persona.id === currentPersonaId;
      useButton.addEventListener("click", () => {
        selectPersona(persona.id);
      });

      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.className = "lecturer-ghost-button";
      editButton.textContent = "Edit";
      editButton.addEventListener("click", () => {
        fillPersonaForm(persona);
      });

      actions.append(useButton, editButton);
      row.append(main, badge, actions);
      personaList.append(row);
    });
  }

  function fillPersonaForm(persona) {
    if (!personaForm) return;

    personaIdField.value = persona.id || "";
    document.getElementById("personaName").value = persona.name || "";
    document.getElementById("personaStyle").value = persona.style || "friendly";
    document.getElementById("personaLanguage").value = persona.language || "id";
    document.getElementById("personaTeachingStyle").value =
      persona.teaching_style || "";
    document.getElementById("personaSpecialNeeds").value =
      persona.special_needs || "";
    document.getElementById("personaCustomPrompt").value =
      persona.custom_prompt || "";

    if (personaFormTitle) {
      personaFormTitle.textContent = "Edit Persona";
    }
    if (personaSubmitLabel) {
      personaSubmitLabel.textContent = "Simpan Perubahan";
    }
    if (personaReset) {
      personaReset.hidden = false;
    }
    personaForm.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function resetPersonaForm() {
    if (!personaForm) return;
    personaForm.reset();
    personaIdField.value = "";

    if (personaFormTitle) {
      personaFormTitle.textContent = "Persona Baru";
    }
    if (personaSubmitLabel) {
      personaSubmitLabel.textContent = "Simpan Persona";
    }
    if (personaReset) {
      personaReset.hidden = true;
    }
  }

  if (personaReset) {
    personaReset.addEventListener("click", resetPersonaForm);
  }

  if (personaForm) {
    personaForm.addEventListener("submit", async (event) => {
      event.preventDefault();

      const payload = {
        name: document.getElementById("personaName").value.trim(),
        style: document.getElementById("personaStyle").value,
        language: document.getElementById("personaLanguage").value,
        teaching_style: document.getElementById("personaTeachingStyle").value.trim(),
        special_needs: document.getElementById("personaSpecialNeeds").value.trim(),
        custom_prompt: document.getElementById("personaCustomPrompt").value.trim(),
      };

      const editingId = personaIdField.value.trim();

      try {
        const data = editingId
          ? await patchJson(
              "/api/lecturer/persona/" + encodeURIComponent(editingId) + "/",
              payload
            )
          : await postJson("/api/lecturer/persona/", payload);

        await loadPersonas();
        resetPersonaForm();
        showToast(
          editingId ? "Persona diperbarui." : "Persona baru dibuat."
        );

        // Persona yang baru dibuat langsung dipakai supaya chat tetap jalan.
        if (!editingId && data.persona?.id) {
          selectPersona(data.persona.id);
        }
      } catch (error) {
        showToast(error.message);
      }
    });
  }

  function selectPersona(personaId) {
    if (personaId === currentPersonaId) return;

    currentPersonaId = personaId;
    if (personaSelect) personaSelect.value = personaId;
    renderPersonaHeader();
    renderPersonaList();

    // Ganti persona → percakapan reset (sesi chat di backend milik persona
    // sebelumnya).
    chat.replaceChildren();
    sessionId = "";
    sessionStorage.removeItem("lecturerSessionId");

    // Sesi baru untuk persona baru. Dibuat di sini, bukan ditunggu sampai
    // pesan pertama — kalau tidak, sesi lama (milik persona sebelumnya)
    // masih jadi rujukan sampai pesan itu dikirim.
    ensureSession().catch(() => {
      // Gagal membuat sesi bukan kondisi fatal: `ensureSession()` akan
      // mencoba lagi saat pesan berikutnya dikirim.
    });

    showToast("Persona diganti. Percakapan dimulai dari awal.");
  }

  if (personaSelect) {
    personaSelect.addEventListener("change", () => {
      selectPersona(personaSelect.value);
    });
  }

  async function loadPersonas() {
    try {
      const data = await getJson("/api/lecturer/personas/");
      personas = data.personas || [];
    } catch (error) {
      personas = [];
      showToast("Gagal memuat persona: " + error.message);
    }

    if (!personas.length) {
      // Belum ada persona → backend otomatis membuat satu lewat
      // GET /lecturer/persona, supaya chat selalu punya dosen untuk talking.
      try {
        const data = await getJson("/api/lecturer/persona/active/");
        if (data.persona?.id) {
          personas = [data.persona];
        }
      } catch (error) {
        showToast("Gagal menyiapkan persona: " + error.message);
      }
    }

    if (!currentPersonaId && personas.length) {
      currentPersonaId = personas[0].id;
    }

    renderPersonaSelect();
    renderPersonaHeader();
    renderPersonaList();
  }

  // =====================================================
  // LAPORAN
  // =====================================================

  const reportList = document.getElementById("lecturerReportList");
  const reportGenerate = document.getElementById("lecturerReportGenerate");

  function prettyContent(raw) {
    const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
    if (!text) return "";
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // Bukan JSON valid → tampilkan apa adanya.
      return text;
    }
  }

  // Satu definisi untuk seluruh halaman — lihat
  // ``dashboard/datetime_utils.js``. Helper ini tadinya ditulis ulang
  // di lima file JavaScript, dan tiap salinan sedikit berbeda; begitu
  // satu salah, perbaikannya harus di lima tempat.
  //
  // **Jangan destructure langsung.** Kalau modul ini gagal dimuat,
  // ``window.AkademiaDateTime`` jadi ``undefined`` dan destructure dari
  // situ melempar error — dan karena baris ini ada di top-level handler
  // ``DOMContentLoaded``, **seluruh** handler mati. Satu modul hilang
  // mematikan satu halaman penuh.
  //
  // Default per helper supaya pemanggilnya tetap dapat bekerja kalau
  // modulkya absen — nilainya "saya tidak tahu", bukan angka tebakan.
  //
  // Fallback inline **sengaja tidak menyalin logika**: menyalin helper
  // tanggal/waktu ke lima file persis masalah yang modul ini hilangkan.
  const dateTime = window.AkademiaDateTime || {};
  const { formatWallClock = () => "-", formatUtc = () => "-" } = dateTime;

  // Label untuk angka aktivitas. ``summary_data`` sekarang juga memuat
  // ``analysis`` (topik + area sulit) dan ``llm_summary`` (narasi) —
  // kalau semuanya dicetak lewat ``Object.entries``, kartu laporan
  // berubah jadi tumpukan JSON mentah.
  const SUMMARY_STATS = [
    ["total_lectures", "Rekaman kuliah"],
    ["total_completed_tasks", "Tugas selesai"],
    ["upcoming_tasks", "Tugas mendatang"],
    ["schedule_entries", "Entri jadwal"],
    ["total_questions", "Pertanyaan"],
    ["unique_questions", "Pertanyaan unik"],
  ];

  function renderSummary(summary) {
    const wrapper = document.createElement("dl");
    wrapper.className = "lecturer-summary";

    const analysis = summary.analysis || {};
    const values = {
      ...summary,
      total_questions: analysis.total_questions,
      unique_questions: analysis.unique_questions,
    };

    SUMMARY_STATS.forEach(([key, label]) => {
      const value = values[key];
      if (value === null || value === undefined) return;

      const term = document.createElement("dt");
      term.textContent = label;

      const detail = document.createElement("dd");
      detail.textContent = String(value);

      wrapper.append(term, detail);
    });

    // Laporan lama hanya punya angka aktivitas; kalau tidak ada satu pun
    // yang dikenal, tampilkan apa adanya supaya tidak ada yang hilang.
    if (!wrapper.childElementCount) {
      Object.entries(summary).forEach(([key, value]) => {
        if (value !== null && typeof value === "object") return;
        const term = document.createElement("dt");
        term.textContent = key.replace(/_/g, " ");
        const detail = document.createElement("dd");
        detail.textContent = value === null || value === undefined ? "-" : String(value);
        wrapper.append(term, detail);
      });
    }

    return wrapper;
  }

  function renderReportNarrative(summary) {
    const activity = summary.llm_summary && summary.llm_summary.activity;
    if (!activity) return null;

    const note = document.createElement("p");
    note.className = "lecturer-report-narrative";
    note.textContent = activity;
    return note;
  }

  function renderReportList(title, items, key) {
    if (!Array.isArray(items) || !items.length) return null;

    const wrapper = document.createElement("div");
    wrapper.className = "lecturer-report-section";

    const heading = document.createElement("p");
    heading.className = "lecturer-card-note";
    heading.textContent = title;

    const list = document.createElement("ul");
    list.className = "lecturer-report-list";

    items.forEach((item) => {
      const row = document.createElement("li");
      if (typeof item === "string") {
        row.textContent = item;
      } else if (item && typeof item === "object") {
        row.textContent = key(item);
      } else {
        row.textContent = String(item);
      }
      list.append(row);
    });

    wrapper.append(heading, list);
    return wrapper;
  }

  function renderReports() {
    if (!reportList) return;

    reportList.replaceChildren();

    // Kartu proses yang sedang jalan (belum ada laporannya).
    const running = reportJobs.filter(
      (job) => job.status === "queued" || job.status === "processing"
    );

    running.forEach((job) => {
      const card = document.createElement("div");
      card.className = "lecturer-card";

      const head = document.createElement("div");
      head.className = "lecturer-card-head";

      const title = document.createElement("strong");
      title.textContent = "Laporan baru sedang dibuat";

      head.append(title, videoBadge(job.status));

      const note = document.createElement("p");
      note.className = "lecturer-card-note";
      note.textContent =
        job.status === "processing"
          ? "Worker sedang merangkum aktivitas minggu ini."
          : "Menunggu worker untuk membuat laporan.";

      card.append(head, note);

      if (job.error_message) {
        const error = document.createElement("p");
        error.className = "lecturer-card-error";
        error.textContent = job.error_message;
        card.append(error);
      }

      reportList.append(card);
    });

    // Laporan yang gagal tidak pernah punya baris WeeklyReport — jadi
    // kegagalannya harus ditampilkan lewat job-nya.
    reportJobs
      .filter((job) => job.status === "failed")
      .forEach((job) => {
        const card = document.createElement("div");
        card.className = "lecturer-card";

        const head = document.createElement("div");
        head.className = "lecturer-card-head";

        const title = document.createElement("strong");
        title.textContent = "Laporan gagal dibuat";

        head.append(title, videoBadge("failed"));

        const error = document.createElement("p");
        error.className = "lecturer-card-error";
        error.textContent = job.error_message || "Tanpa keterangan.";

        card.append(head, error);

        reportList.append(card);
      });

    if (!reportReports.length && !running.length) {
      reportList.append(
        emptyState(
          "description",
          "Belum ada laporan",
          "Tekan “Buat Laporan” untuk membuat ringkasan mingguan."
        )
      );
      return;
    }

    reportReports.forEach((report) => {
      const card = document.createElement("div");
      card.className = "lecturer-card";

      const head = document.createElement("div");
      head.className = "lecturer-card-head";

      const title = document.createElement("strong");
      title.textContent = "Laporan " + formatWallClock(report.period_start);

      const badge = document.createElement("span");
      badge.className = "badge blue";
      badge.textContent = "Mingguan";

      head.append(title, badge);

      const period = document.createElement("p");
      period.className = "lecturer-card-note lecturer-card-period";
      period.textContent =
        "Periode " +
        formatWallClock(report.period_start) +
        " → " +
        formatWallClock(report.period_end);

      const content = document.createElement("pre");
      content.className = "lecturer-code";
      content.textContent = prettyContent(report.content);

      card.append(head, period);

      if (report.summary_data) {
        const narrative = renderReportNarrative(report.summary_data);
        if (narrative) card.append(narrative);

        const summaryTitle = document.createElement("p");
        summaryTitle.className = "lecturer-card-note";
        summaryTitle.textContent = "Aktivitas";
        card.append(summaryTitle, renderSummary(report.summary_data));

        // Topik + area sulit: analisis terukur dari backend. Ini bagian
        // yang menjawab spec 3.5 (b) dan (c) — bukan sekadar angka.
        const analysis = report.summary_data.analysis || {};
        const topics = renderReportList(
          "Topik yang sering ditanyakan",
          analysis.topics,
          (topic) => `${topic.topic} — ditanyakan ${topic.count}×`,
        );
        if (topics) card.append(topics);

        const difficult = renderReportList(
          "Area yang terlihat sulit",
          analysis.difficult_areas,
          (area) => `${area.area} — ${area.reason}`,
        );
        if (difficult) card.append(difficult);
      }

      card.append(content);

      // Detail laporan diambil ulang dari backend. Daftar laporan
      // (``GET /api/lecturer/reports/``) mengembalikan baris yang bisa
      // belum terisi penuh — ``summary_data``-nya sering null saat
      // worker masih menulis. Endpoint detail memberi isi terbaru.
      if (report.id) {
        const actions = document.createElement("div");
        actions.className = "lecturer-report-actions";

        // Unduh lewat BFF (Django membawa token ke FastAPI). ``download``
        // dipakai supaya browser memperlakukan respons sebagai berkas,
        // bukan navigasi halaman.
        const download = document.createElement("a");
        download.className = "lecturer-ghost-button";
        download.href =
          "/api/lecturer/reports/" + encodeURIComponent(report.id) + "/export/";
        download.textContent = "Unduh .docx";
        download.setAttribute("download", "");
        actions.append(download);

        const refresh = document.createElement("button");
        refresh.type = "button";
        refresh.className = "lecturer-card-refresh";
        refresh.textContent = "Muat detail terbaru";

        refresh.addEventListener("click", async () => {
          refresh.disabled = true;
          refresh.textContent = "Memuat...";

          try {
            const data = await getJson(
              "/api/lecturer/reports/" + encodeURIComponent(report.id) + "/"
            );

            const fresh = data.report || {};

            // Ganti isi kartu dengan data detail yang baru.
            const index = reportReports.findIndex((item) => item.id === report.id);
            if (index !== -1) reportReports[index] = { ...reportReports[index], ...fresh };

            renderReports();
            showToast("Detail laporan dimuat.");
          } catch (error) {
            refresh.disabled = false;
            refresh.textContent = "Muat detail terbaru";
            showToast("Gagal memuat detail: " + error.message);
          }
        });

        actions.append(refresh);
        card.append(actions);
      }

      reportList.append(card);
    });
  }

  let reportReports = [];

  // Job pembuatan laporan yang sedang dipolling. null = tidak ada proses
  // yang sedang berjalan.
  let reportJobs = [];

  // Timer polling status laporan. Dipisah dari ``pollTimer`` (video)
  // supaya keduanya tidak saling membatalkan timer.
  let reportPollTimer = null;

  async function loadReports() {
    if (!reportList) return;

    await fetchReports();
    await loadReportJobs();

    renderReports();
    renderReportStatus();
    scheduleReportPolling();
  }

  // Ringkasan status di bawah judul panel: berapa proses yang sedang
  // jalan, dan apakah ada yang gagal.
  function renderReportStatus() {
    const node = document.getElementById("lecturerReportStatus");

    if (!node) return;

    const running = reportJobs.filter(
      (job) => job.status === "queued" || job.status === "processing"
    );

    const failed = reportJobs.filter((job) => job.status === "failed");

    if (failed.length) {
      node.textContent =
        failed.length === 1
          ? "1 laporan gagal dibuat. Buka daftar di bawah untuk melihat alasannya."
          : `${failed.length} laporan gagal dibuat. Buka daftar di bawah untuk melihat alasannya.`;
      return;
    }

    if (running.length) {
      node.textContent =
        running.length === 1
          ? "1 laporan sedang dibuat. Statusnya diperbarui otomatis."
          : `${running.length} laporan sedang dibuat. Statusnya diperbarui otomatis.`;
      return;
    }

    node.textContent =
      "Laporan dibuat otomatis tiap minggu oleh worker. Tekan “Buat Laporan” untuk membuat sekarang.";
  }

  // Ambil daftar laporan. Dipisah dari ``loadReports`` supaya polling
  // bisa menyegarkan laporannya tanpa menarik ulang daftar job.
  async function fetchReports() {
    try {
      const data = await getJson("/api/lecturer/reports/");
      reportReports = data.reports || [];
      // Backend tidak mengurutkan → terbaru dulu.
      reportReports.sort(
        (a, b) => String(b.generated_at || "").localeCompare(String(a.generated_at || ""))
      );
    } catch (error) {
      reportReports = [];
      showToast("Gagal memuat laporan: " + error.message);
    }
  }

  // Ambil daftar proses pembuatan laporan. Job yang "queued"/"processing"
  // ikut dipolling supaya badge status di kartu laporan tetap hidup.
  async function loadReportJobs() {
    try {
      const data = await getJson("/api/lecturer/reports/jobs/");
      reportJobs = Array.isArray(data.jobs) ? data.jobs : [];
    } catch (error) {
      reportJobs = [];
    }
  }

  // Poll job laporan yang masih berjalan setiap ~3 detik. Polanya sama
  // dengan schedulePolling() untuk video.
  function scheduleReportPolling() {
    const pending = reportJobs.filter(
      (job) => job.status === "queued" || job.status === "processing"
    );

    clearTimeout(reportPollTimer);
    if (!pending.length) return;

    reportPollTimer = setTimeout(async () => {
      for (const job of pending) {
        try {
          const data = await getJson(
            "/api/lecturer/reports/jobs/" + encodeURIComponent(job.id) + "/"
          );
          const updated = data.job;
          const index = reportJobs.findIndex((item) => item.id === job.id);
          if (index !== -1 && updated) reportJobs[index] = updated;
        } catch (error) {
          showToast("Gagal memperbarui status laporan: " + error.message);
        }
      }

      // Laporan yang sudah jadi harus muncul di daftar — worker baru
      // menulis baris WeeklyReport setelah job-nya selesai.
      await fetchReports();

      renderReports();
      renderReportStatus();
      scheduleReportPolling();
    }, 3000);
  }

  if (reportGenerate) {
    reportGenerate.addEventListener("click", async () => {
      reportGenerate.disabled = true;
      try {
        const data = await postJson("/api/lecturer/reports/generate/", {});
        showToast(data.message || "Laporan sedang dibuat di latar belakang.");

        // Job-nya dipolling supaya status "diproses → selesai/gagal"
        // terlihat, dan laporannya otomatis masuk daftar.
        if (data.job_id || (data.job && data.job.id)) {
          const jobId = data.job_id || data.job.id;

          reportJobs = [
            {
              id: jobId,
              status: "queued",
              report_id: null,
              error_message: null,
            },
            ...reportJobs.filter((item) => item.id !== jobId),
          ];

          renderReports();
          renderReportStatus();
          scheduleReportPolling();
        } else {
          // Backend lama (tanpa job_id) — tidak ada yang bisa dipolling.
          setTimeout(loadReports, 3000);
        }
      } catch (error) {
        showToast(error.message);
      } finally {
        reportGenerate.disabled = false;
      }
    });
  }

  // =====================================================
  // VIDEO
  // =====================================================

  const videoList = document.getElementById("lecturerVideoList");
  const videoForm = document.getElementById("lecturerVideoForm");
  const videoSubmitLabel = document.getElementById("lecturerVideoSubmitLabel");
  const videoCourseFilter = document.getElementById("lecturerVideoCourseFilter");

  let videoJobs = [];
  let pollTimer = null;

  // Filter daftar video per mata kuliah. Dipisah dari ``selectedCourseId``
  // (dipakai chat + RAG) supaya mengubah filter video tidak ikut mengubah
  // cakupan retrieval di header chat.
  function videoCourseFilterValue() {
    return videoCourseFilter?.value || "";
  }

  // Isi dropdown filter dengan daftar mata kuliah yang sudah dimuat di
  // ``courses``. Nilai yang sedang dipilih dipertahankan.
  function renderVideoCourseFilter() {
    if (!videoCourseFilter) return;

    const previous = videoCourseFilter.value;
    videoCourseFilter.replaceChildren();

    const all = document.createElement("option");
    all.value = "";
    all.textContent = "Semua mata kuliah";
    videoCourseFilter.append(all);

    courses.forEach((course) => {
      const option = document.createElement("option");
      option.value = course.id;
      option.textContent = course.code
        ? course.code + " — " + (course.name || "")
        : course.name || course.id;
      videoCourseFilter.append(option);
    });

    // Kalau MK yang tadinya dipilih masih ada, pertahankan; kalau tidak
    // (mis. daftar mata kuliah berubah), kembalikan ke "semua".
    videoCourseFilter.value = courses.some((c) => c.id === previous)
      ? previous
      : "";
  }

  function videoBadge(status) {
    const badge = document.createElement("span");
    badge.className =
      "badge " + (VIDEO_STATUS_BADGE[status] || "blue");
    badge.textContent = VIDEO_STATUS_LABEL[status] || status || "—";
    return badge;
  }

  function renderVideos() {
    if (!videoList) return;

    videoList.replaceChildren();

    if (!videoJobs.length) {
      videoList.append(
        emptyState(
          "movie_off",
          "Belum ada video",
          "Isi formulir di samping untuk membuat video ajar."
        )
      );
      return;
    }

    videoJobs.forEach((job) => {
      const card = document.createElement("div");
      card.className = "lecturer-card";

      const head = document.createElement("div");
      head.className = "lecturer-card-head";

      const title = document.createElement("strong");
      title.textContent = job.material || "Video ajar";

      head.append(title, videoBadge(job.status));

      const meta = document.createElement("p");
      meta.className = "lecturer-card-note";
      meta.textContent =
        "Gaya " +
        (job.video_style || "professional") +
        " · dibuat " +
        formatUtc(job.created_at);

      card.append(head, meta);

      if (job.error_message) {
        const error = document.createElement("p");
        error.className = "lecturer-card-error";
        error.textContent = job.error_message;
        card.append(error);
      }

      // Video gagal → tombol "Coba Lagi". Pesan error dari backend selalu
      // berakhir "silakan buat ulang", jadi harus ada jalan untuk
      // melakukannya; menyalin ulang materi yang panjang (sampai 20.000
      // karakter) bukan langkah yang wajar.
      if (job.status === "failed") {
        const actions = document.createElement("div");
        actions.className = "lecturer-row-actions";

        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "lecturer-ghost-button";
        retry.textContent = "Coba Lagi";
        retry.addEventListener("click", () => retryVideo(job, retry));

        actions.append(retry);
        card.append(actions);
      }

      if (job.status === "done" && job.video_url) {
        const fileUrl =
          "/api/lecturer/videos/" + encodeURIComponent(job.id) + "/file/";

        // Player in-page: mahasiswa tidak perlu pindah tab untuk
        // menonton. `preload="metadata"` supaya tidak mengunduh seluruh
        // video sebelum menekan putar.
        const player = document.createElement("video");
        player.className = "lecturer-video-player";
        player.controls = true;
        player.preload = "metadata";
        player.playsInline = true;
        player.src = fileUrl;
        player.setAttribute("aria-label", "Pemutar video ajar");

        const actions = document.createElement("div");
        actions.className = "lecturer-row-actions";

        const download = document.createElement("a");
        download.className = "lecturer-ghost-button";
        download.href = fileUrl + "?download=1";
        download.textContent = "Unduh";

        const openNew = document.createElement("a");
        openNew.className = "lecturer-ghost-button";
        openNew.href = fileUrl;
        openNew.target = "_blank";
        openNew.rel = "noopener";
        openNew.textContent = "Buka di Tab Baru";

        actions.append(openNew, download);
        card.append(player, actions);
      }

      videoList.append(card);
    });
  }

  async function loadVideos() {
    if (!videoList) return;

    const courseId = videoCourseFilterValue();
    const query = courseId
      ? "/api/lecturer/videos/?course_id=" + encodeURIComponent(courseId)
      : "/api/lecturer/videos/";

    try {
      const data = await getJson(query);
      videoJobs = data.videos || [];
      videoJobs.sort(
        (a, b) => String(b.created_at || "").localeCompare(String(a.created_at || ""))
      );
    } catch (error) {
      videoJobs = [];
      showToast("Gagal memuat daftar video: " + error.message);
    }

    renderVideos();
    schedulePolling();
  }

  /**
   * Buat ulang job video yang gagal.
   *
   * Materi, gaya, mata kuliah, dan persona diambil dari job lama di
   * backend — jadi mahasiswa tidak perlu menyalin ulang teks yang
   * panjang. Kalau naskahnya masih tersimpan, backend me-render ulang
   * tanpa memanggil LLM lagi.
   *
   * Job **baru** dibuat; job lama tetap ada di riwayat sebagai catatan
   * kegagalan.
   */
  async function retryVideo(job, button) {
    if (button) {
      button.disabled = true;
      button.textContent = "Membuat Ulang...";
    }

    try {
      const data = await postJson(
        `/api/lecturer/videos/${encodeURIComponent(job.id)}/retry/`,
        {}
      );
      if (data.job) videoJobs.unshift(data.job);
      showToast(data.message || "Video sedang dibuat ulang di latar belakang.");
      renderVideos();
      schedulePolling();
    } catch (error) {
      showToast("Gagal membuat ulang video: " + error.message);
      if (button) {
        button.disabled = false;
        button.textContent = "Coba Lagi";
      }
    }
  }

  // Poll job yang masih queued/processing setiap ~3 detik.
  function schedulePolling() {
    const pending = videoJobs.filter(
      (job) => job.status === "queued" || job.status === "processing"
    );

    clearTimeout(pollTimer);
    if (!pending.length) return;

    pollTimer = setTimeout(async () => {
      for (const job of pending) {
        try {
          const data = await getJson(
            "/api/lecturer/videos/" + encodeURIComponent(job.id) + "/"
          );
          const updated = data.job;
          const index = videoJobs.findIndex((item) => item.id === job.id);
          if (index !== -1 && updated) videoJobs[index] = updated;
        } catch (error) {
          showToast("Gagal memperbarui status video: " + error.message);
        }
      }
      renderVideos();
      schedulePolling();
    }, 3000);
  }

  // Mengubah filter video memuat ulang daftar dari server. Penaringan
  // dilakukan di backend (param `course_id`), bukan di DOM — kalau
  // ditapis di sisi klien, video dari MK lain sempat muncul sekilas.
  if (videoCourseFilter) {
    videoCourseFilter.addEventListener("change", () => {
      loadVideos();
    });
  }

  if (videoForm) {
    videoForm.addEventListener("submit", async (event) => {
      event.preventDefault();

      const material = document.getElementById("videoMaterial").value.trim();
      if (!material) return;

      const payload = {
        material,
        video_style: document.getElementById("videoStyle").value,
      };
      if (currentPersonaId) payload.persona_id = currentPersonaId;

      if (videoSubmitLabel) videoSubmitLabel.textContent = "Membuat Video...";

      try {
        const data = await postJson("/api/lecturer/videos/generate/", payload);
        if (data.job) videoJobs.unshift(data.job);
        videoForm.reset();
        showToast(data.message || "Video sedang dibuat di latar belakang.");
        renderVideos();
        schedulePolling();
      } catch (error) {
        showToast(error.message);
      } finally {
        if (videoSubmitLabel) videoSubmitLabel.textContent = "Buat Video";
      }
    });
  }

  // =====================================================
  // TABS
  // =====================================================

  function capitalize(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  document.querySelectorAll(".lecturer-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;

      document.querySelectorAll(".lecturer-tab").forEach((item) => {
        const active = item === tab;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-selected", active ? "true" : "false");
      });

      document.querySelectorAll(".lecturer-panel").forEach((panel) => {
        panel.classList.toggle(
          "is-active",
          panel.id === "lecturerPanel" + capitalize(target)
        );
      });

      // Muat data lazily saat tab pertama kali dibuka.
      if (target === "reports" && !reportReports.length) loadReports();
      if (target === "video" && !videoJobs.length) loadVideos();
    });
  });

  // =====================================================
  // INIT
  // =====================================================

  loadPersonas().then(() => {
    loadHistory();
    loadReports();
    loadVideos();

    // Daftar mata kuliah untuk retrieval. Ditunggu — bukan karena chat
    // bergantung padanya, tapi karena dropdown-nya harus terisi sebelum
    // mahasiswa memilih. Gagal memuatnya tidak menghalangi chat biasa.
    loadCourses();

    // Pertanyaan yang dikirim dari dashboard home lewat sessionStorage —
    // langsung dijawab di sini supaya pengguna tidak perlu mengetiknya
    // dua kali.
    const pending = sessionStorage.getItem("akademia.prompt");
    if (pending) {
      sessionStorage.removeItem("akademia.prompt");
      sendMessage(pending);
    }
  });
});
