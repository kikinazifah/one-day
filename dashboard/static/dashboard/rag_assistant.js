/**
 * RAG Assistant — terhubung ke backend FastAPI (student-assistant)
 * lewat endpoint JSON Django:
 *
 *   GET  /api/rag/documents/            → daftar dokumen terindeks
 *   GET  /api/rag/documents/search/     → cari dokumen (nama ATAU isi)
 *   POST /api/rag/upload/                → unggah berkas (multipart)
 *   GET  /api/rag/documents/<id>/        → status indexing (polling)
 *   GET  /api/rag/documents/<id>/file/   → unduh berkas sumber
 *   PATCH /api/rag/documents/<id>/rename/ → ubah nama / tag mata kuliah
 *   POST /api/rag/documents/<id>/delete/ → hapus dari indeks
 *   GET  /api/courses/                   → daftar mata kuliah (tagging)
 *   GET  /api/rag/chat/sessions/         → daftar sesi percakapan
 *   POST /api/rag/chat/sessions/create/  → buat sesi percakapan
 *   GET  /api/rag/chat/<id>/             → riwayat percakapan
 *   POST /api/rag/chat/<id>/message/     → tanya-jawab yang tersimpan
 *   DELETE /api/rag/chat/<id>/delete/    → hapus sesi percakapan
 *
 * Alur unggah: pilih berkas → POST /upload/ → backend mulai indexing di
 * background dan membalas status ``uploaded``. Browser lalu polling
 * /api/rag/documents/<id>/ sampai statusnya ``indexed`` (atau ``failed``).
 * Jawaban baru akurat setelah dokumen selesai terindeks.
 *
 * Percakapan disimpan di backend lewat sesi chat, jadi riwayat tetap ada
 * setelah halaman di-refresh atau dibuka di tab lain.
 */
document.addEventListener("DOMContentLoaded", () => {
  const api = window.AkademiaApi;
  const fileInput = document.getElementById("ragFiles");
  const fileList = document.getElementById("ragFileList");
  const questionForm = document.getElementById("ragQuestionForm");
  const messages = document.getElementById("chatMessages");
  const courseSelect = document.getElementById("ragCourse");
  const searchInput = document.getElementById("ragSearch");
  const searchNote = document.getElementById("ragSearchNote");
  const renameDialog = document.getElementById("ragRenameDialog");
  const renameForm = document.getElementById("ragRenameForm");
  const renameName = document.getElementById("ragRenameName");
  const renameCourse = document.getElementById("ragRenameCourse");
  const renameError = document.getElementById("ragRenameError");
  const renameCancel = document.getElementById("ragRenameCancel");
  const taskChips = document.getElementById("ragTaskChips");
  const formatHint = document.getElementById("ragFormatHint");
  const clearChatButton = document.getElementById("ragClearChat");

  if (!api) return;

  // Sapaan pembuka yang ada di template (statis). Disalin di sini
  // supaya bisa dikembalikan setelah riwayat dihapus — kalau tidak,
  // panel chat jadi kosong total tanpa penjelasan.
  //
  // `innerHTML` (bukan `replaceChildren`) dipakai karena isinya HTML
  // statis dari template milik kita sendiri, bukan input pengguna.
  const greetingMarkup = messages ? messages.innerHTML : "";

  // Format yang bisa diindeks backend.
  //
  // Daftar ini **dimuat dari server**, bukan ditulis di sini. Kalau
  // daftarnya ada di dua tempat, keduanya pasti akan berbeda — dan user
  // melihat "format tidak didukung" untuk berkas yang sebenarnya bisa
  // diproses (mis. .tsv, .yaml, .py).
  //
  // Nilai awal hanya cadangan: kalau server gagal dihubungi, jangan
  // tutup semua format — lebih baik biarkan server yang menolak berkasnya
  // dengan pesan yang jelas.
  let acceptedExtensions = null;

  function extensionOf(filename) {
    const name = String(filename || "").toLowerCase();
    const dot = name.lastIndexOf(".");
    // Berkas tanpa titik = tanpa ekstensi. Backend memperlakukannya
    // sebagai teks biasa, jadi bukan berarti "tidak didukung".
    return dot === -1 ? "" : name.slice(dot);
  }

  function isAccepted(filename) {
    if (!acceptedExtensions) return true;   // belum diketahui -> biarkan server yang menilai
    return acceptedExtensions.has(extensionOf(filename));
  }

  async function loadFormats() {
    try {
      const data = await api.get("/api/rag/formats/");
      const formats = Array.isArray(data.formats) ? data.formats : [];
      if (formats.length) {
        acceptedExtensions = new Set(
          formats.map((f) => String(f).toLowerCase()),
        );
        // Atribut `accept` dipakai server apa adanya kalau ada — backend
        // sudah tahu format mana yang bisa ditulis di sana (ekstensi
        // kosong tidak bisa). Kalau tidak ada, disusun di sini.
        const real = Array.from(acceptedExtensions).filter((ext) => ext);
        if (fileInput) {
          const fromServer = typeof data.accept === "string" ? data.accept.trim() : "";
          if (fromServer) {
            fileInput.setAttribute("accept", fromServer);
          } else if (real.length) {
            fileInput.setAttribute(
              "accept",
              real.map((ext) => ext.replace(".", "")).join(","),
            );
          }
        }
        // Teks petunjuk di drop-zone juga dari server, supaya tidak
        // menampilkan format yang sudah tidak didukung.
        if (formatHint && real.length) {
          const shown = real
            .map((ext) => ext.replace(".", "").toUpperCase())
            .slice(0, 9)
            .join(", ");
          const more = real.length > 9 ? ", dan lain-lain" : "";
          formatHint.textContent = shown + more;
        }
      }
    } catch (error) {
      // Tidak kritis: server yang akan menolak format yang salah dengan
      // pesan yang jelas. Daftar lokal sengaja tidak dipakai sebagai
      // sumber kebenaran.
      console.warn("daftar format tidak dimuat:", error);
    }
  }

  // Dokumen di server: { id, fileName, status, chunksCount, ... }.
  //
  // `allDocuments` = seluruh dokumen milik pengguna (sumber kebenaran).
  // `documents` = yang sedang ditampilkan — sama dengan `allDocuments`,
  // kecuali saat mode pencarian aktif, di mana isinya hasil pencarian.
  // Dua pemisahan ini yang membuat statistik "Total Dokumen" tetap
  // menghitung semua dokumen meski yang tampil cuma hasil cari.
  let allDocuments = [];
  let documents = [];
  // Status pemuatan daftar dokumen: belum pernah dimuat / sedang memuat /
  // sudah pernah dimuat / gagal memuat.
  //
  // Tanpa ini, `renderDocuments()` menampilkan "Belum ada dokumen yang
  // diunggah." selama request masih berjalan — padahal kita belum tahu
  // apakah dokumennya ada atau tidak. User mengira datanya hilang.
  let documentsLoaded = false;
  let documentsLoading = false;
  let documentsError = null;
  // Daftar mata kuliah — dipakai untuk picker dan untuk dialog ubah.
  let courses = [];
  // Mode pencarian: ketika true, `documents` berisi **hasil pencarian**,
  // bukan seluruh dokumen.
  let searchMode = false;
  // Berapa banyak pertanyaan yang sudah terjawab di sesi ini.
  let questionCount = 0;
  // Penanda pesan live di panel chat. `loadHistory()` membandingkan nilai ini
  // sebelum dan sesudah permintaan riwayat — kalau berubah, berarti ada
  // pesan yang muncul DURATAN permintaan, jadi riwayat server tidak boleh
  // menimpanya.
  let liveMessageSeq = 0;
  // Timer polling indexing — satu per dokumen.
  const pollers = new Map();
  // Id dokumen yang sedang diedit di dialog ubah.
  let editingDocumentId = "";
  // Tag mata kuliah dokumen itu, seperti yang diketahui server. Dipakai
  // untuk membedakan "pengguna melepas tag" dari "dropdown tidak bisa
  // dipakai karena daftarnya gagal dimuat".
  let editingCourseId = "";
  // Id sesi percakapan di backend. Disimpan di sessionStorage supaya
  // refresh tidak memutus percakapan, tapi tetap terikat ke tab ini.
  let chatSessionId = sessionStorage.getItem("akademia.ragSessionId") || "";

  // =====================================================
  // HTTP
  // =====================================================

  async function uploadFile(file) {
    const form = new FormData();
    form.append("file", file);
    // Tag mata kuliah ikut dikirim. Kalau kosong, backend menebak sendiri
    // dari isi dokumen (auto-tag).
    const courseId = courseSelect?.value || "";
    if (courseId) form.append("course_id", courseId);
    return api.upload("/api/rag/upload/", form);
  }

  // =====================================================
  // MATA KULIAH
  // =====================================================

  function fillCourseOptions(select, selected, placeholder) {
    if (!select) return;

    select.replaceChildren();

    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = placeholder;
    select.append(empty);

    courses.forEach((course) => {
      const option = document.createElement("option");
      option.value = course.id;
      option.textContent = course.code
        ? course.code + " — " + course.name
        : course.name;
      select.append(option);
    });

    if (selected) select.value = selected;
  }

  /**
   * True kalau daftar mata kuliah **berhasil** dimuat.
   *
   * Dipakai untuk memutuskan apakah tag mata kuliah boleh dikirim saat
   * rename. Kalau daftar gagal dimuat, dropdown hanya berisi placeholder —
   * dan nilainya yang terkirim akan "lepaskan tag", bukan "jangan ubah".
   */
  let coursesLoaded = false;

  async function loadCourses() {
    try {
      const data = await api.get("/api/courses/");
      courses = Array.isArray(data.courses) ? data.courses : [];
      coursesLoaded = true;
      fillCourseOptions(courseSelect, courseSelect?.value || "", "Semua mata kuliah");
      fillCourseOptions(renameCourse, renameCourse?.value || "", "Tanpa mata kuliah");

      // Dialog rename mungkin sudah terbuka saat daftarnya arrive. Isi
      // ulang dengan tag dokumen yang sedang diedit — kalau tidak, dropdown
      // kembali ke placeholder dan tag yang sudah benar ikut hilang saat
      // pengguna menekan simpan.
      if (editingDocumentId) {
        const doc = allDocuments.find((item) => item.id === editingDocumentId);
        if (doc) {
          fillCourseOptions(
            renameCourse,
            doc.courseId || doc.course_id || "",
            "Tanpa mata kuliah",
          );
        }
        if (renameError && renameError.hidden === false &&
            renameError.textContent.includes("gagal dimuat")) {
          renameError.hidden = true;
          renameError.textContent = "";
        }
      }
    } catch (error) {
      // Kegagalan memuat daftar mata kuliah **tidak boleh** memblokir
      // halaman: dokumen tetap bisa diunggah tanpa tag, dan auto-tag di
      // backend tetap jalan karena dia ambil daftar dari server.
      //
      // Tapi rename jadi lebih hati-hati: `coursesLoaded` tetap false, jadi
      // tag mata kuliah tidak ikut dikirim (lihat penjelasan di
      // `openRenameDialog`).
      coursesLoaded = false;
      console.warn("daftar mata kuliah gagal dimuat:", error);
    }
  }

  // =====================================================
  // RENDER DOKUMEN
  // =====================================================

  const STATUS_LABEL = {
    uploaded: "Menunggu indeks",
    processing: "Sedang diindeks",
    indexed: "Terindeks",
    failed: "Gagal diindeks",
  };

  const STATUS_BADGE = {
    uploaded: "blue",
    processing: "blue",
    indexed: "green",
    failed: "red",
  };

  // Penjelasan kenapa dokumen muncul di hasil pencarian.
  const MATCH_LABEL = {
    name: "Cocok pada nama berkas",
    content: "Cocok pada isi dokumen",
    both: "Cocok pada nama dan isi",
  };

  function renderDocuments() {
    if (!fileList) return;

    fileList.replaceChildren();

    // Banner error dibuat ulang tiap render (bukan di-prepend sekali),
    // karena `replaceChildren()` di atas membersihkannya.
    if (documentsError && !searchMode) {
      const err = document.createElement("div");
      err.className = "form-note list-load-error";
      err.style.color = "#b42318";
      err.setAttribute("role", "alert");
      err.textContent = documentsError;

      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "small-outline";
      retry.textContent = "Coba lagi";
      retry.addEventListener("click", async () => {
        retry.disabled = true;
        await loadDocuments();
      });
      err.append(" ", retry);
      fileList.append(err);
    }

    if (!documents.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state compact-empty";

      const icon = document.createElement("span");
      icon.className = "material-symbols-outlined";

      const text = document.createElement("p");

      if (searchMode) {
        // Mode pencarian: hasilnya memang milik pencarian, bukan daftar
        // awal — jadi status pemuatan tidak relevan di sini.
        icon.textContent = "search_off";
        text.textContent = "Tidak ada dokumen yang cocok dengan pencarian.";
      } else if (documentsError) {
        icon.textContent = "cloud_off";
        text.textContent = "Daftar dokumen gagal dimuat.";
      } else if (documentsLoading || !documentsLoaded) {
        // `documentsLoading` menutup kasus reload manual: daftar sudah
        // pernah dimuat (jadi `documentsLoaded` true) tapi sedang dimuat
        // ulang — kalau tidak dicek, halaman sempat lagi menampilkan
        // "Belum ada dokumen" padahal yang lama masih valid.
        icon.textContent = "hourglass_empty";
        text.textContent = "Memuat dokumen...";
      } else {
        icon.textContent = "folder_off";
        text.textContent = "Belum ada dokumen yang diunggah.";
      }

      empty.append(icon, text);
      fileList.append(empty);
    } else {
      documents.forEach((doc) => {
        const row = document.createElement("div");
        row.className = "file-row";

        const icon = document.createElement("span");
        icon.className = "material-symbols-outlined";
        icon.textContent = "description";

        const details = document.createElement("div");
        details.className = "file-details";

        const name = document.createElement("strong");
        name.textContent = doc.fileName || doc.original_filename || "Dokumen";

        const size = document.createElement("small");
        const chunks = doc.chunkCount ?? doc.chunksCount;
        const parts = [STATUS_LABEL[doc.status] || doc.status || "Diproses"];
        if (chunks) parts.push(chunks + " potongan");

        // Saat mencari, jelaskan kenapa dokumen ini muncul.
        if (searchMode && doc.matchType) {
          const match = MATCH_LABEL[doc.matchType] || doc.matchType;
          parts.push(match + (doc.matchCount ? " (" + doc.matchCount + ")" : ""));
        }

        size.textContent = parts.join(" • ");

        details.append(name, size);

        const badge = document.createElement("span");
        badge.className = "badge " + (STATUS_BADGE[doc.status] || "blue");
        badge.textContent = STATUS_LABEL[doc.status] || "Diproses";

        // Unduh berkas sumber. `fileUrl` dari backend sudah diarahkan ke
        // route BFF (lihat views_api_misc._rewrite_file_url), jadi browser
        // tidak pernah menyentuh origin FastAPI secara langsung.
        const download = document.createElement("a");
        download.className = "icon-button file-download";
        download.href =
          doc.fileUrl ||
          "/api/rag/documents/" + encodeURIComponent(doc.id) + "/file/";
        download.setAttribute(
          "aria-label",
          "Unduh " + name.textContent,
        );
        download.title = "Unduh berkas sumber";
        download.setAttribute("download", "");
        download.innerHTML =
          '<span class="material-symbols-outlined">download</span>';

        // Ubah nama tampilan / koreksi tag mata kuliah (FR-07, FR-21).
        const edit = document.createElement("button");
        edit.className = "icon-button";
        edit.type = "button";
        edit.setAttribute("aria-label", "Ubah " + name.textContent);
        edit.title = "Ubah nama dan mata kuliah";
        edit.innerHTML = '<span class="material-symbols-outlined">edit</span>';
        edit.addEventListener("click", () => openRenameDialog(doc));

        const remove = document.createElement("button");
        remove.className = "icon-button";
        remove.type = "button";
        remove.setAttribute("aria-label", "Hapus " + name.textContent);
        remove.textContent = "×";
        remove.disabled = doc.status === "processing";

        remove.addEventListener("click", async () => {
          remove.disabled = true;
          try {
            await api.post(
              "/api/rag/documents/" + encodeURIComponent(doc.id) + "/delete/",
            );
            stopPolling(doc.id);
            // Hapus dari daftar induk dan dari hasil pencarian — kalau
            // hanya salah satu, dokumennya masih muncul di salah satu
            // tampilan.
            allDocuments = allDocuments.filter((item) => item.id !== doc.id);
            documents = documents.filter((item) => item.id !== doc.id);
            renderDocuments();
          } catch (error) {
            remove.disabled = false;
            appendNotice(error.message, "error");
          }
        });

        row.append(icon, details, badge, edit, download, remove);
        fileList.append(row);
      });
    }

    // Statistik "Total Dokumen" — dalam mode pencarian ini menghitung
    // dokumen yang cocok, bukan seluruh dokumen. Angka "Vector Index"
    // tetap menghitung semua dokumen yang terindeks.
    const count = document.getElementById("fileCount");
    if (count) {
      count.textContent = searchMode ? documents.length : allDocuments.length;
    }

    const vectorStat = document.querySelector("#ragVectorCount");
    if (vectorStat) {
      const indexed = allDocuments.filter((d) => d.status === "indexed").length;
      vectorStat.textContent = indexed;
    }
  }

  // =====================================================
  // PENCARIAN DOKUMEN
  // =====================================================

  // Debounce 250 ms: mengetik "normalisasi" tidak boleh memicu sebelas
  // request.
  let searchTimer = null;

  // Nomor urut pencarian. Tiap pencarian baru incremented; sebuah respons
  // hanya dipakai kalau urutannya masih yang terbaru.
  //
  // Tanpa ini, dua pencarian yang tumpang tindih bisa selesai terbalik:
  // permintaan "a" (lambat) selesai setelah permintaan "ab" (cepat), lalu
  // hasil "a" menimpa hasil "ab" — layar menampilkan dokumen yang tidak
  // cocok dengan isi kotak pencarian. Urutan balasan tidak dijamin server.
  let searchSeq = 0;

  function scheduleSearch() {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 250);
  }

  async function runSearch() {
    const query = (searchInput?.value || "").trim();

    if (!query) {
      // Kotak dikosongkan → kembali ke daftar semua dokumen.
      searchSeq += 1;
      searchMode = false;
      documents = allDocuments;
      if (searchNote) searchNote.hidden = true;
      renderDocuments();
      return;
    }

    const seq = ++searchSeq;

    try {
      const data = await api.get(
        "/api/rag/documents/search/?q=" + encodeURIComponent(query),
      );

      // Sudah ada pencarian lain yang lebih baru → abaikan balasan ini.
      if (seq !== searchSeq) return;

      documents = Array.isArray(data.documents) ? data.documents : [];
      searchMode = true;

      if (searchNote) {
        const total = data.total ?? documents.length;
        // Backend membatasi jumlah hasil (50). Kalau total lebih besar
        // dari yang ditampilkan, sebutkan keduanya — kalau tidak, angka
        // "57 dokumen cocok" bertabrakan dengan 50 baris yang tampil.
        searchNote.textContent =
          total === 0
            ? "Tidak ada dokumen yang cocok dengan \"" + query + "\"."
            : total > documents.length
              ? total +
                " dokumen cocok dengan \"" +
                query +
                "\" — menampilkan " +
                documents.length +
                "."
              : total + " dokumen cocok dengan \"" + query + "\".";
        searchNote.hidden = false;
      }

      renderDocuments();
    } catch (error) {
      // Pencarian gagal: hasil lama harus dibuang. Kalau tidak, panel
      // menampilkan dokumen dari kueri sebelumnya — padahal isinya sudah
      // tidak cocok dengan yang diketik pengguna.
      documents = [];
      searchMode = true;

      if (searchNote) {
        searchNote.textContent = "Pencarian gagal: " + error.message;
        searchNote.hidden = false;
      }

      renderDocuments();
      appendNotice(error.message, "error");
    }
  }

  if (searchInput) {
    searchInput.addEventListener("input", scheduleSearch);
    // Enter di kotak pencarian tidak boleh submits form halaman.
    searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        if (searchTimer) clearTimeout(searchTimer);
        runSearch();
      }
    });
  }

  // =====================================================
  // DIALOG UBAH DOKUMEN
  // =====================================================

  function openRenameDialog(doc) {
    if (!renameDialog) return;

    editingDocumentId = doc.id;
    editingCourseId = doc.courseId || doc.course_id || "";
    fillCourseOptions(renameCourse, editingCourseId, "Tanpa mata kuliah");
    renameName.value = doc.fileName || doc.original_filename || "";

    // Daftar mata kuliah gagal dimuat → dropdown hanya berisi placeholder,
    // jadi nilainya selalu "". Kalau tag terkirim apa adanya, backend akan
    // melepas tag yang mungkin sudah benar (auto-tag). Tandai supaya
    // handler submit tahu tag ini **tidak boleh** ikut dikirim.
    if (!coursesLoaded && editingCourseId) {
      if (renameError) {
        renameError.textContent =
          "Daftar mata kuliah gagal dimuat, jadi tag mata kuliah tidak ikut diubah. Coba muat ulang halaman untuk memperbaiki tag.";
        renameError.hidden = false;
      }
    }

    if (renameError && coursesLoaded) {
      renameError.hidden = true;
      renameError.textContent = "";
    }

    renameDialog.showModal();
    renameName.focus();
  }

  if (renameCancel) {
    renameCancel.addEventListener("click", () => {
      if (renameDialog?.open) renameDialog.close();
    });
  }

  if (renameForm) {
    renameForm.addEventListener("submit", async (event) => {
      // `method="dialog"` punya default yang menutup dialog; kita
      // menundanya supaya pengiriman yang gagal tetap menampilkan error
      // di dalam dialog, bukan menutupnya diam-diam.
      event.preventDefault();

      const name = (renameName.value || "").trim();
      if (!name) {
        if (renameError) {
          renameError.textContent = "Nama dokumen tidak boleh kosong.";
          renameError.hidden = false;
        }
        return;
      }

      const saveButton = document.getElementById("ragRenameSave");
      if (saveButton) saveButton.disabled = true;

      // Id dokumen yang sedang diubah. Balasannya bisa datang terlambat:
      // pengguna mungkin sudah menutup dialog dan membuka dokumen lain.
      // Id ini supaya jawaban lama tidak menutup dialog yang sekarang.
      const targetId = editingDocumentId;

      try {
        const payload = { display_name: name };

        // Tag mata kuliah hanya ikut kalau dropdown-nya bisa dipercaya.
        // Kalau daftar mata kuliah gagal dimuat, nilainya hanya placeholder
        // dan mengirimkannya berarti "lepaskan tag" — bukan "jangan ubah".
        if (coursesLoaded) {
          // Tag yang sedang terpasang di dokumen.
          const current = allDocuments.find((item) => item.id === targetId);
          const currentCourseId =
            (current && (current.courseId || current.course_id)) || "";

          // Apakah tag lama masih bisa dipilih di dropdown? Kalau mata
          // kuliahnya dihapus di server, tag itu tidak ada sebagai opsi —
          // dan nilai dropdown otomatis jadi "" (placeholder). Itu artefak,
          // bukan pilihan pengguna.
          const options = renameCourse
            ? renameCourse.children.filter((c) => c.tagName === "OPTION")
            : [];
          const currentSelectable = options.some(
            (o) => o.value === currentCourseId,
          );

          const chosen = renameCourse.value || "";

          if (chosen) {
            // Pengguna memilih mata kuliah.
            payload.course_id = chosen;
          } else if (!currentCourseId) {
            // memang tidak ada tag sebelumnya — tidak ada yang berubah.
            payload.course_id = "";
          } else if (currentSelectable) {
            // Tag lama masih ada di dropdown dan pengguna memilih
            // "Tanpa mata kuliah" → lepaskan tag. Ini yang FR-21 minta:
            // pengguna boleh mengoreksi tag yang keliru.
            payload.course_id = "";
          }
          // Kalau `chosen` kosong, tag lama ada, tapi tag itu tidak ada di
          // dropdown → jangan sentuh tag sama sekali.
        }

        const data = await api.patch(
          "/api/rag/documents/" + encodeURIComponent(targetId) + "/rename/",
          payload,
        );

        const updated = data.document || {};

        // Balasan untuk dokumen lain (mis. server mengembalikan id yang
        // tidak cocok) → abaikan, jangan sentuh state.
        if (updated.id && updated.id !== targetId) return;

        // Perbarui dokumen yang sedang tampil — baik di daftar biasa
        // maupun di hasil pencarian.
        const applyUpdate = (list) =>
          list.map((item) => (item.id === updated.id ? { ...item, ...updated } : item));
        allDocuments = applyUpdate(allDocuments);
        documents = applyUpdate(documents);

        renderDocuments();

        // Dialog yang ditutup hanya dialog untuk dokumen yang sama. Kalau
        // pengguna sudah pindah ke dokumen lain, dialognya harus tetap
        // terbuka — isinya milik orang itu.
        if (editingDocumentId === targetId) renameDialog.close();
      } catch (error) {
        // Error untuk dokumen yang sudah tidak dibuka → jangan tampilkan di
        // dialog dokumen lain yang sekarang terbuka.
        if (editingDocumentId !== targetId) return;

        if (renameError) {
          renameError.textContent = error.message;
          renameError.hidden = false;
        }
      } finally {
        if (saveButton) saveButton.disabled = false;
      }
    });
  }

  // =====================================================
  // POLLING INDEXING
  // =====================================================

  function stopPolling(documentId) {
    const timer = pollers.get(documentId);
    if (timer) {
      clearInterval(timer);
      pollers.delete(documentId);
    }
    pollFailures.delete(documentId);
  }

  // Berapa kali polling tiap dokumen gagal berturut-turut. Error jaringan
  // bersifat transient (backend restart, timeout) — satu kegagalan tidak
  // boleh menghentikan polling selamanya, karena dokumennya tetap akan
  // selesai diindeks di server.
  const pollFailures = new Map();

  // Batas percobaan setelah error terus-menerus. Setelah ini, Polling
  // dihentikan supaya halaman tidak=request tanpa henti.
  const MAX_POLL_FAILURES = 5;

  function pollDocument(documentId) {
    // Jangan buat dua poller untuk dokumen yang sama.
    if (pollers.has(documentId)) return;

    const timer = setInterval(async () => {
      try {
        const data = await api.get(
          "/api/rag/documents/" + encodeURIComponent(documentId) + "/",
        );
        const doc = data.document || {};
        pollFailures.delete(documentId);
        const index = allDocuments.findIndex((item) => item.id === documentId);

        if (index !== -1) {
          allDocuments[index] = { ...allDocuments[index], ...doc };
          // Dalam mode pencarian, dokumennya mungkin tidak lagi cocok —
          // tapi statusnya tetap berubah (mis. "Menunggu indeks" →
          // "Terindeks"), jadi baris yang sedang tampil ikut disegarkan.
          if (searchMode) {
            const visible = documents.findIndex((item) => item.id === documentId);
            if (visible !== -1) {
              documents[visible] = { ...documents[visible], ...doc };
            }
          } else {
            const visible = allDocuments.findIndex((item) => item.id === documentId);
            if (visible !== -1) documents[visible] = allDocuments[visible];
          }
          renderDocuments();
        }

        if (doc.status === "indexed" || doc.status === "failed") {
          stopPolling(documentId);
          if (doc.status === "failed") {
            appendNotice(
              "Dokumen “" + (doc.fileName || "") + "” gagal diindeks.",
              "error",
            );
          }
        }
      } catch (error) {
        const failures = (pollFailures.get(documentId) || 0) + 1;
        pollFailures.set(documentId, failures);

        // Kesalahan sementara (jaringan, backend restart) — coba lagi di
        // tick berikutnya. Hanya setelah berkali-kali gagal terus polling
        // dihentikan, karena itu menandakan ada yang benar-benar salah.
        if (failures < MAX_POLL_FAILURES) {
          appendNotice(
            error.message + " (mencoba lagi dalam beberapa detik)",
            "error",
          );
          return;
        }

        stopPolling(documentId);
        appendNotice(error.message, "error");
      }
    }, 2000);

    pollers.set(documentId, timer);
  }

  // =====================================================
  // CHAT
  // =====================================================

  function appendNotice(text, kind) {
    if (!messages) return;

    const notice = document.createElement("p");
    notice.className = "form-note";
    notice.textContent = text;
    if (kind === "error") notice.style.color = "#b42318";
    messages.append(notice);
    messages.scrollTop = messages.scrollHeight;
  }

  function addUserMessage(text) {
    // Naikkan penanda pesan live. `loadHistory()` memakainya untuk tahu
    // apakah ada pesan yang muncul selama riwayat server dimuat — kalau
    // ada, riwayat tidak boleh menimpanya.
    liveMessageSeq += 1;

    const message = document.createElement("div");
    message.className = "user-message";
    message.textContent = text;
    messages.append(message);
    messages.scrollTop = messages.scrollHeight;
  }

  function addThinkingMessage() {
    const reply = document.createElement("div");
    reply.className = "assistant-message";

    const avatar = document.createElement("span");
    avatar.className = "chat-avatar material-symbols-outlined";
    avatar.textContent = "smart_toy";

    const body = document.createElement("div");

    const title = document.createElement("strong");
    title.textContent = "Akademia AI";

    const text = document.createElement("p");
    text.textContent = "Mencari jawaban dari dokumenmu...";

    body.append(title, text);
    reply.append(avatar, body);
    messages.append(reply);
    messages.scrollTop = messages.scrollHeight;

    return reply;
  }

  function buildAnswer(answer, sources, confidence, kind) {
    const reply = document.createElement("div");
    reply.className = "assistant-message";

    const avatar = document.createElement("span");
    avatar.className = "chat-avatar material-symbols-outlined";
    avatar.textContent = "smart_toy";

    const body = document.createElement("div");

    const title = document.createElement("strong");
    title.textContent = "Akademia AI";

    const text = document.createElement("p");
    text.textContent = answer || "Informasi tidak ditemukan pada dokumenmu.";
    // Pertahankan baris baru dari jawaban LLM.
    text.style.whiteSpace = "pre-wrap";

    body.append(title, text);

    // Referensi dokumen sumber — jawaban RAG tanpa sumber tidak bisa
    // diverifikasi mahasiswa, jadi selalu ditampilkan kalau ada.
    if (Array.isArray(sources) && sources.length) {
      const list = document.createElement("ul");
      list.className = "form-note";

      sources.forEach((source) => {
        const item = document.createElement("li");
        const name = source.fileName || source.file_name || "Dokumen";
        const score = Number(source.score || 0);
        item.textContent = name + " (skor " + score.toFixed(2) + ")";
        list.append(item);
      });

      // Jawaban status tugas diberi label berbeda — sumbernya adalah
      // daftar tugas, bukan potongan dokumen.
      const label = document.createElement("p");
      label.className = "form-note";
      const sourceLabel = kind === "task" ? "Tugas terkait" : "Sumber";
      label.textContent =
        sourceLabel +
        " (" +
        sources.length +
        ")" +
        (confidence ? " • keyakinan " + Number(confidence).toFixed(2) : "");

      body.append(label, list);
    }

    reply.append(avatar, body);
    return reply;
  }

  // =====================================================
  // SESI PERCAKAPAN
  // =====================================================

  // Sesi sudah dipastikan masih hidup di backend? (dicek satu kali saja —
  // setiap pertanyaan tidak perlu GET tambahan.)
  let sessionChecked = false;

  // Promise pembuatan sesi yang sedang berjalan.
  //
  // Tanpa ini, dua pertanyaan yang dikirim bersamaan (mis. pengguna
  // menekan Enter dua kali, atau chip + ketikan) keduanya masuk ke
  // `ensureSession()` sebelum `sessionChecked` berubah. Keduanya lalu
  // membuat sesi sendiri — riwayat percakapan terpecah ke dua sesi dan
  // satu sesi jadi sampah di server.
  //
  // Dengan menyimpan promise-nya, pemanggil kedua menunggu hasil yang
  // sama. Sesi yang sama dipakai, dan hanya satu yang dibuat.
  let sessionPromise = null;

  // Pastikan ada sesi percakapan di backend. Sesi yang hilang (mis. sudah
  // dihapus dari server) diganti dengan yang baru, bukan menggagalkan chat.
  function ensureSession() {
    // Sedang berjalan → pakai hasil yang sama, jangan buat sesi kedua.
    if (sessionPromise) return sessionPromise;

    sessionPromise = (async () => {
      if (chatSessionId && !sessionChecked) {
        const stillThere = await api
          .get("/api/rag/chat/" + encodeURIComponent(chatSessionId) + "/")
          .then(() => true)
          .catch(() => false);

        sessionChecked = true;

        if (stillThere) return chatSessionId;

        // Sesi sudah tidak ada di server. Kalau id-nya dibiarkan, baris
        // ``if (chatSessionId && sessionChecked)`` di bawah akan
        // mengembalikan id mati — setiap pertanyaan berikutnya gagal 404.
        chatSessionId = "";
        sessionStorage.removeItem("akademia.ragSessionId");
      }

      if (chatSessionId && sessionChecked) return chatSessionId;

      const data = await api.post("/api/rag/chat/sessions/create/", {
        title: "Percakapan baru",
      });

      chatSessionId = data.session?.id || "";
      sessionChecked = true;
      sessionStorage.setItem("akademia.ragSessionId", chatSessionId);

      // Sesi baru dibuat → tombol "hapus riwayat" jadi punya target.
      //
      // Dipanggil di sini, bukan hanya di dalam `syncClearButton()` yang
      // dipanggil sekali di awal: pada halaman yang di-refresh, sesi
      // **sudah ada** (disimpan di ``sessionStorage``), jadi taksonya
      // sudah tampil sejak awal — tanpa perlu menunggu pertanyaan
      // pertama.
      syncClearButton();

      return chatSessionId;
    })();

    // Kalau gagal, penanda harus dibuang supaya percobaan berikutnya
    // mencoba lagi. Kalau sukses, `chatSessionId` + `sessionChecked`
    // sudah cukup — pemanggilan berikutnya tidak perlu HTTP sama sekali.
    sessionPromise = sessionPromise.catch((error) => {
      sessionPromise = null;
      throw error;
    });

    return sessionPromise;
  }

  // Muat riwayat sesi terakhir ke panel chat.
  async function loadHistory() {
    if (!chatSessionId || !messages) return;

    // Id sesi yang **sedang dimuat**. Sesi bisa berubah di tengah perjalanan:
    // `ensureSession()` bisa membuat sesi baru kalau yang lama sudah hilang
    // di server. Tanpa ini, `catch` di bawah akan menghapus id sesi yang
    // baru dibuat — riwayat jadi terpecah ke dua sesi.
    const requestedId = chatSessionId;

    // Ada pesan live yang muncul sejak permintaan ini dimulai? Kalau ya,
    // riwayat server tidak boleh menimpanya — tidak ada yang tahu urutan
    // kedua sumber itu, dan pesan yang baru saja dikirim bisa hilang dari
    // layar (jawabannya sudah tersimpan di server tapi tidak terlihat).
    const liveSeqAtStart = liveMessageSeq;

    try {
      const data = await api.get(
        "/api/rag/chat/" + encodeURIComponent(requestedId) + "/",
      );

      // Sesi sudah diganti (mis. `ensureSession` membuat yang baru) atau
      // ada pesan live — jangan sentuh state.
      if (chatSessionId !== requestedId) return;
      if (liveMessageSeq !== liveSeqAtStart) return;

      sessionChecked = true;

      const history = Array.isArray(data.messages) ? data.messages : [];
      if (!history.length) return;

      messages.replaceChildren();

      history.forEach((message) => {
        if (message.role === "user") {
          addUserMessage(message.content || "");
        } else {
          messages.appendChild(
            buildAnswer(
              message.content || "",
              Array.isArray(message.sources) ? message.sources : [],
              0,
              message.kind,
            ),
          );
        }
      });

      messages.scrollTop = messages.scrollHeight;

      // Jumlah pertanyaan dihitung dari riwayat server, bukan dari counter
      // lokal — supaya angka di kartu statistik tetap benar setelah reload.
      setQuestionCount(history.filter((m) => m.role === "user").length);
    } catch (error) {
      // Sesi hilang di backend → mulai baru tanpa mengganggu pengguna.
      //
      // Tapi kalau sesi yang diminta **bukan** sesi yang aktif sekarang
      // (mis. `ensureSession` sudah membuat sesi baru sementara permintaan
      // ini jalan), kegagalan ini bukan tentang sesi yang aktif — jangan
      // hapus id yang baru dibuat.
      if (chatSessionId !== requestedId) return;

      chatSessionId = "";
      sessionChecked = false;
      sessionStorage.removeItem("akademia.ragSessionId");
    }
  }

  function setQuestionCount(value) {
    questionCount = value;
    const counter = document.getElementById("questionCount");
    if (counter) counter.textContent = questionCount;
  }

  async function askQuestion(question) {
    if (!question) return;

    addUserMessage(question);
    const pending = addThinkingMessage();
    const input = document.getElementById("ragQuestion");
    if (input) input.value = "";

    try {
      const sessionId = await ensureSession();

      const data = await api.post(
        "/api/rag/chat/" + encodeURIComponent(sessionId) + "/message/",
        {
          question,
          n_results: 5,
        },
      );

      pending.replaceWith(
        buildAnswer(data.answer, data.sources, data.confidence, data.kind),
      );

      setQuestionCount(questionCount + 1);
    } catch (error) {
      pending.remove();
      appendNotice(error.message, "error");
    }
  }

  if (questionForm) {
    questionForm.addEventListener("submit", async (event) => {
      event.preventDefault();

      const input = document.getElementById("ragQuestion");
      const question = input?.value.trim();

      if (!question) return;

      await askQuestion(question);
    });
  }

  // Chip pertanyaan siap-pakai — mengisi kotak lalu mengirim.
  if (taskChips) {
    taskChips.addEventListener("click", (event) => {
      const chip = event.target.closest(".rag-chip");
      if (!chip) return;

      const question = chip.textContent.trim();
      const input = document.getElementById("ragQuestion");
      if (input) input.value = question;

      askQuestion(question);
    });
  }

  // =====================================================
  // HAPUS RIWAYAT PERCAKAPAN
  // =====================================================

  // Tombol hanya tampil kalau ada sesi yang bisa dihapus. Sesi dibuat
  // backend saat pertanyaan pertama dikirim, jadi sebelum itu tombolnya
  // tidak punya apa-apa untuk dihapus.
  function syncClearButton() {
    if (!clearChatButton) return;
    clearChatButton.hidden = !chatSessionId;
  }

  syncClearButton();

  if (clearChatButton) {
    clearChatButton.addEventListener("click", async () => {
      if (!chatSessionId) return;

      // Konfirmasi dulu: menghapus sesi tidak bisa dibatalkan, dan
      // "hapus" tanpa konfirmasi sering salah kena karena letaknya
      // di panel yang sama dengan tombol kirim.
      if (!window.confirm("Hapus riwayat percakapan ini?")) return;

      const targetId = chatSessionId;

      clearChatButton.disabled = true;

      try {
        await api.del(
          "/api/rag/chat/" + encodeURIComponent(targetId) + "/delete/",
        );

        // Sesi yang dihapus harus **dilepas** dari state lokal, bukan
        // hanya disembunyikan dari layar. Kalau id-nya dibiarkan di
        // `sessionStorage`, halaman di-refresh akan memuat ulang sesi
        // yang sudah dihapus — backend membalas 404, dan `loadHistory()`
        // diam-diam menghapus id-nya tanpa memberi tahu user.
        if (chatSessionId === targetId) {
          chatSessionId = "";
          sessionChecked = false;
          sessionPromise = null;
          sessionStorage.removeItem("akademia.ragSessionId");
        }

        // Kembalikan panel ke kondisi awal: sapaan pembuka + penghitung
        // pertanyaan kembali ke nol.
        if (messages) {
          messages.innerHTML = greetingMarkup;
          messages.scrollTop = messages.scrollHeight;
        }
        setQuestionCount(0);

        syncClearButton();
        appendNotice("Riwayat percakapan dihapus.", "info");
      } catch (error) {
        clearChatButton.disabled = false;
        appendNotice(
          "Gagal menghapus riwayat: " + (error.message || "tidak diketahui"),
          "error",
        );
      }
    });
  }

  // =====================================================
  // UNGGAH BERKAS
  // =====================================================

  if (fileInput) {
    fileInput.addEventListener("change", async () => {
      const incoming = Array.from(fileInput.files || []);
      fileInput.value = "";

      for (const file of incoming) {
        if (!isAccepted(file.name)) {
          const list = acceptedExtensions
            ? Array.from(acceptedExtensions)
                .filter((ext) => ext)
                .map((ext) => ext.replace(".", ""))
                .join(", ")
            : "belum diketahui";
          appendNotice(
            "Format berkas tidak didukung: " +
              file.name +
              ". Yang bisa diindeks: " +
              list +
              ".",
            "error",
          );
          continue;
        }

        const placeholder = {
          id: "pending-" + file.name + "-" + Date.now(),
          fileName: file.name,
          status: "uploaded",
        };
        allDocuments = [placeholder, ...allDocuments];
        if (!searchMode) documents = allDocuments;
        renderDocuments();

        try {
          const data = await uploadFile(file);
          const doc = data.document || {};

          // Ganti placeholder dengan dokumen asli dari server.
          allDocuments = allDocuments.map((item) =>
            item.id === placeholder.id ? doc : item,
          );
          if (!searchMode) documents = allDocuments;
          renderDocuments();

          if (doc.id) pollDocument(doc.id);
        } catch (error) {
          allDocuments = allDocuments.filter((item) => item.id !== placeholder.id);
          if (!searchMode) documents = allDocuments;
          renderDocuments();
          appendNotice(error.message, "error");
        }
      }
    });
  }

  // =====================================================
  // MUAT DOKUMEN AWAL
  // =====================================================

  async function loadDocuments() {
    // Tandai sedang memuat SEBELUM request, lalu render. Tanpa ini, halaman
    // sempat menampilkan "Belum ada dokumen yang diunggah." selama
    // menunggu jawaban server — padahal jawabannya belum diketahui.
    documentsLoading = true;
    documentsError = null;
    renderDocuments();

    try {
      const data = await api.get("/api/rag/documents/");
      const fromServer = data.documents || [];

      // Jangan buang dokumen yang sedang diunggah pengguna. Kalau pengguna
      // mengunggah file sebelum daftar awal ini selesai dimuat, dokumen itu
      // (placeholder-nya, atau dokumen asli yang barusan tiba) akan hilang
      // dari daftar — ada di server tapi tidak terlihat sampai halaman
      // di-refresh.
      //
      // Yang dipertahankan: dokumen lokal yang id-nya tidak ada di daftar
      // server. Placeholder (id "pending-…") dan dokumen yang barusan
      // diunggah termasuk ini — keduanya belum tentu ada di daftar server
      // yang diminta **sebelum** unggahan selesai.
      const serverIds = new Set(fromServer.map((doc) => doc.id));
      const localOnly = allDocuments.filter((doc) => !serverIds.has(doc.id));

      allDocuments = [...localOnly, ...fromServer];
      if (!searchMode) documents = allDocuments;
      documentsLoaded = true;

      // Lanjutkan polling untuk dokumen yang masih diproses (mis. setelah
      // halaman di-refresh saat indexing berjalan).
      allDocuments
        .filter((doc) => doc.status === "uploaded" || doc.status === "processing")
        .forEach((doc) => pollDocument(doc.id));
    } catch (error) {
      documentsError = "Daftar dokumen gagal dimuat: " + (error.message || "tidak diketahui");
    } finally {
      documentsLoading = false;
      renderDocuments();
    }
  }

  renderDocuments();
  loadCourses();
  loadFormats();
  loadDocuments();
  loadHistory();
});
