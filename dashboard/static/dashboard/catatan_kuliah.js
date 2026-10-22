/**
 * Catatan kuliah pada tab "Catatan Kuliah Live Sync" di halaman Auto Scheduler.
 *
 * Catatan disimpan ke backend pada field ``description`` entri jadwal
 * (PATCH /api/schedule/<id>/), bukan ke localStorage — supaya catatan ikut
 * tersinkron di perangkat mana pun dan tidak hilang saat cache browser dibersihkan.
 *
 *   GET   /api/schedule/            → entri jadwal (untuk deskripsi tersimpan)
 *   PATCH /api/schedule/<id>/       → simpan catatan pada entri
 *   GET   /api/lecture/             → sesi rekaman terakhir (untuk transkrip)
 *   GET   /api/lecture/<id>/audio/file/ → berkas rekaman (diputar di <audio>)
 *
 * Catatan dan rangkuman ujian sama-sama disimpan di ``description`` karena
 * backend hanya punya satu field teks bebas. Keduanya dipisahkan penanda
 * ``RANGKUMAN UJIAN`` — jadi satu PATCH menulis keduanya, tidak saling
 * menimpa seperti sebelumnya.
 */
document.addEventListener("DOMContentLoaded", () => {
  const $ = (selector) => document.querySelector(selector);

  const notesInput = $("#lnStudentNotes");
  const saveButton = $("#lnSave");
  const saveStatus = $("#lnSaveStatus");

  // Jika tab catatan belum ada pada halaman ini, hentikan script.
  if (!notesInput) return;

  // Klien API bersama (dashboard/api.js). Semua request lewat sini, bukan
  // `fetch` mentah — supaya header CSRF, penanganan error, dan batas
  // waktu ditangani di satu tempat.
  //
  // Guard `if (!api) return;` itu wajib: baris ini ada di top-level
  // handler ``DOMContentLoaded``, jadi lempar di sini mematikan **seluruh**
  // handler — panel catatan, pemutar audio, dan tombol simpan ikut hilang.
  const api = window.AkademiaApi;
  if (!api) {
    if (saveStatus) {
      saveStatus.textContent = "Modul API gagal dimuat — catatan tidak bisa dimuat.";
    }
    return;
  }

  // Helper durasi (detik → "mm:ss") — satu definisi untuk seluruh halaman,
  // lihat ``dashboard/datetime_utils.js``.
  //
  // Fungsi ini tadinya ditulis ulang dengan **dua nama berbeda**:
  // `formatClock` di sini dan `formatTimestamp` di ``auto_scheduler.js``.
  // Dua nama untuk satu fungsi adalah cara paling mahal untuk menemukan
  // bug: yang satu diperbaiki, yang satunya tidak pernah diketahui ada.
  //
  // **Jangan destructure langsung.** Baris ini ada di top-level handler
  // ``DOMContentLoaded``, jadi kalau modulnya gagal dimuat, destructure
  // melempar error dan **seluruh** handler mati — panel catatan, pemutar
  // audio, dan tombol simpan ikut hilang.
  //
  // Default-nya "00:00": pemutar audio selalu punya durasi, jadi "00:00"
  // lebih jujur daripada "-".
  //
  // Fallback inline **sengaja tidak menyalin logika**: menyalin helper
  // tanggal/waktu ke lima file persis masalah yang modul ini hilangkan.
  const dateTime = window.AkademiaDateTime || {};
  const { formatDuration = () => "00:00" } = dateTime;

  // Sesi rekaman terakhir — dipakai untuk judul, ringkasan, dan pemutar.
  let latestLecture = null;

  // Entri jadwal yang sedang dibuka di modal detail.
  let activeEntryId = null;

  // Rangkuman ujian yang sedang diedit (textarea kedua).
  const summaryInput = $("#materialSummaryText");

  // Penanda yang memisahkan catatan pribadi dari rangkuman ujian di dalam
  // satu field ``description``.
  const SUMMARY_MARKER = "RANGKUMAN UJIAN";

  function setStatus(message) {
    if (saveStatus) saveStatus.textContent = message;
  }

  // ------------------------------------------------------------ memuat data

  // Deskripsi entri jadwal bisa berisi catatan ATAU rangkuman ujian - dua
  // itu disimpan di field yang sama, dipisahkan penanda.
  function splitDescription(description) {
    const text = String(description || "");
    const marker = SUMMARY_MARKER;

    if (text.includes(marker)) {
      const [notes, ...rest] = text.split(marker);
      return {
        notes: notes.trim(),
        summary: rest.join(marker).trim(),
      };
    }

    return { notes: text.trim(), summary: "" };
  }

  // Gabungkan catatan dan rangkuman jadi satu string ``description``.
  function joinDescription(notes, summary) {
    const cleanNotes = String(notes || "").trim();
    const cleanSummary = String(summary || "").trim();

    if (!cleanSummary) return cleanNotes;
    if (!cleanNotes) return `${SUMMARY_MARKER}\n\n${cleanSummary}`;

    return `${cleanNotes}\n\n${SUMMARY_MARKER}\n\n${cleanSummary}`;
  }

  // Muat entri jadwal yang sedang aktif supaya textarea terisi catatan
  // yang sudah tersimpan.
  async function loadEntryDescription(entryId) {
    if (!entryId) return;

    try {
      const data = await api.get("/api/schedule/");
      const entries = Array.isArray(data.entries) ? data.entries : [];

      const entry = entries.find((item) => item.id === entryId);
      if (!entry) return;

      const { notes, summary } = splitDescription(entry.description);

      notesInput.value = notes;
      if (summaryInput) summaryInput.value = summary;

      // Bookmark menampilkan catatan yang tersimpan, bukan contoh hardcoded.
      const bookmark = $("#lnBookmarkText");
      if (bookmark) {
        bookmark.textContent =
          notes ||
          "Belum ada bookmark. Tulis catatan lalu klik \"Simpan Catatan\" untuk menyimpannya di backend.";
      }

      setStatus("Catatan dimuat dari backend.");
    } catch (error) {
      console.warn("Catatan entri gagal dimuat:", error);
      setStatus("Catatan gagal dimuat: " + error.message);
    }
  }

  // Sesi rekaman terakhir — untuk judul tab, isi unduhan, dan pemutar audio.
  async function loadLecture() {
    try {
      const data = await api.get("/api/lecture/");
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

      latestLecture =
        withBoth[0] || withAudioOnly[0] || withTranscript[0] || withAudio[0] || null;

      setupAudioPlayer();
    } catch (error) {
      console.warn("Sesi rekaman gagal dimuat:", error);
    }
  }

  // =====================================================
  // PEMUTAR AUDIO
  // =====================================================

  // Backend menyimpan berkas rekaman di ``uploads/lectures/`` dan menyajikannya
  // lewat GET /api/lecture/<id>/audio/file/ (backend FastAPI memakai
  // Range, jadi seek di dalam rekaman bisa jalan).
  function setupAudioPlayer() {
    const player = $("#lnAudio");
    const playButton = $("#lnPlay");
    const progress = $("#lnProgressFill");
    const speedButton = $("#lnSpeed");

    if (!player || !playButton) return;

    const speeds = [1, 1.25, 1.5, 2];

    if (!latestLecture?.audioUrl) {
      // Tidak ada berkas rekaman di server — tombol dimatikan, bukan
      // berpura-pura bisa diputar.
      playButton.disabled = true;
      if (progress) progress.style.width = "0%";

      const hint = $("#lnAudioHint");
      if (hint && latestLecture) {
        hint.textContent =
          "Sesi ini belum punya berkas rekaman. Transkrip dan ringkasan tetap bisa dibaca di sini.";
      }

      return;
    }

    playButton.disabled = false;

    // `audioUrl` dari backend berupa path absolut ke origin backend. Browser
    // harus mengambilnya lewat BFF Django — token service tidak boleh
    // terlihat di sini — jadi path-nya diterjemahkan ke route Django.
    const filePath = "/api/lecture/" + encodeURIComponent(latestLecture.id) + "/audio/file/";

    player.src = filePath;
    player.preload = "metadata";

    playButton.addEventListener("click", async () => {
      if (player.paused) {
        try {
          await player.play();
        } catch (error) {
          console.warn("Pemutaran gagal:", error);
          const hint = $("#lnAudioHint");
          if (hint) hint.textContent = "Rekaman tidak bisa diputar: " + error.message;
        }
      } else {
        player.pause();
      }
    });

    player.addEventListener("play", () => {
      playButton.textContent = "Ⅱ";
      playButton.setAttribute("aria-label", "Jeda audio");
    });

    player.addEventListener("pause", () => {
      playButton.textContent = "▶";
      playButton.setAttribute("aria-label", "Putar audio");
    });

    player.addEventListener("timeupdate", () => {
      if (!progress) return;

      const total = Number(player.duration);
      const percent =
        Number.isFinite(total) && total > 0 ? (player.currentTime / total) * 100 : 0;

      progress.style.width = percent.toFixed(1) + "%";

      const clock = $("#lnAudioTime");
      if (clock && Number.isFinite(total) && total > 0) {
        clock.textContent =
          formatDuration(player.currentTime) + " / " + formatDuration(total);
      }
    });

    player.addEventListener("error", () => {
      const hint = $("#lnAudioHint");
      if (hint) {
        hint.textContent =
          "Rekaman tidak bisa dimuat dari server. Transkrip dan ringkasan tetap tersedia di bawah.";
      }
    });

    // Kecepatan pemutaran — tombol siklus 1x → 1.25x → 1.5x → 2x.
    if (speedButton) {
      let index = 0;

      speedButton.addEventListener("click", () => {
        index = (index + 1) % speeds.length;
        const speed = speeds[index];

        player.playbackRate = speed;
        speedButton.textContent = speed.toFixed(2).replace(/0$/, "") + "x";
      });
    }
  }

  // ------------------------------------------------------------------ simpan

  // Simpan catatan DAN rangkuman ujian ke backend dalam satu PATCH.
  //
  // Sebelumnya ada dua handler terpisah pada tombol yang sama: satu
  // menulis catatan saja, satu menulis rangkuman saja. Karena keduanya
  // menulis field ``description`` yang sama, yang ditekan belakangan
  // menghapus yang lain. Sekarang satu handler menulis keduanya.
  saveButton?.addEventListener("click", async () => {
    if (saveButton.dataset.busy === "true") return;

    if (!activeEntryId) {
      setStatus("Buka detail jadwal dulu untuk menyimpan catatan ke backend.");
      showSchedulerToast("Buka detail jadwal dulu untuk menyimpan catatan.");
      return;
    }

    const notes = notesInput.value;
    const summary = summaryInput ? summaryInput.value : "";

    if (!notes.trim() && !summary.trim()) {
      setStatus("Catatan masih kosong.");
      showSchedulerToast("Catatan masih kosong.");
      return;
    }

    saveButton.dataset.busy = "true";
    setStatus("Menyimpan catatan...");

    try {
      await api.patch(
        `/api/schedule/${encodeURIComponent(activeEntryId)}/`,
        { description: joinDescription(notes, summary) },
      );

      setStatus("Catatan tersimpan di backend.");
      showSchedulerToast("Catatan tersimpan.");
    } catch (error) {
      setStatus("Catatan gagal disimpan: " + error.message);
      showSchedulerToast("Catatan gagal disimpan: " + error.message);
    } finally {
      saveButton.dataset.busy = "false";
    }
  });

  // Toast milik halaman Auto Scheduler (disediakan auto_scheduler.js).
  // Kalau elemennya belum ada, biarkan saja — toast bukan hal wajib.
  function showSchedulerToast(message) {
    const toast = document.getElementById("schedulerToast");
    if (!toast) return;

    toast.textContent = message;
    toast.classList.add("show");

    clearTimeout(toast.dataset.timer);
    toast.dataset.timer = setTimeout(() => {
      toast.classList.remove("show");
    }, 3000);
  }

  // Beri tanda ketika catatan diubah.
  notesInput.addEventListener("input", () => {
    setStatus("Ada perubahan yang belum disimpan.");
  });

  summaryInput?.addEventListener("input", () => {
    setStatus("Ada perubahan yang belum disimpan.");
  });

  // Fokuskan input ketika tombol bookmark diklik.
  $("#lnEditBookmark")?.addEventListener("click", () => {
    notesInput.focus();
    notesInput.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  });

  // Unduh ringkasan materi sebagai TXT. Isinya dari backend: transkrip sesi
  // terakhir + catatan pribadi pengguna.
  $("#lnDownload")?.addEventListener("click", async () => {
    const content = [];

    content.push("CATATAN KULIAH");
    content.push(
      latestLecture?.title || "Sesi rekaman terakhir (belum ada transkrip)",
    );
    content.push("");

    if (latestLecture?.transcript) {
      content.push("TRANSKRIP");
      content.push(latestLecture.transcript);
      content.push("");
    }

    if (latestLecture?.summary) {
      content.push("RINGKASAN");
      content.push(latestLecture.summary);
      content.push("");
    }

    content.push("CATATAN PRIBADI");
    content.push(notesInput.value || "(Belum ada catatan pribadi.)");

    if (summaryInput?.value.trim()) {
      content.push("");
      content.push("RANGKUMAN UJIAN");
      content.push(summaryInput.value);
    }

    const blob = new Blob([content.join("\n")], {
      type: "text/plain;charset=utf-8",
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = "catatan-kuliah.txt";

    document.body.appendChild(link);
    link.click();
    link.remove();

    URL.revokeObjectURL(url);
  });

  // Tombol integrasi: arahkan ke halaman Django yang sebenarnya.
  $("#lnOpenListener")?.addEventListener("click", () => {
    window.location.href = "/lecture-listener/";
  });

  $("#lnSendDocument")?.addEventListener("click", () => {
    // Kirim catatan ke Document Creator lewat sessionStorage, supaya form
    // pengarang sudah terisi saat halaman dibuka.
    sessionStorage.setItem(
      "akademia.documentDraft",
      JSON.stringify({
        title: "Catatan Kuliah",
        description: notesInput.value || "",
        type: "Ringkasan materi",
      }),
    );

    window.location.href = "/document-creator/";
  });

  // Dengarkan event dari auto_scheduler.js saat modal detail dibuka, supaya
  // textarea terisi catatan entri yang dipilih.
  window.addEventListener("akademia:schedule-active", (event) => {
    const entryId = event.detail?.entryId || null;
    activeEntryId = entryId;
    loadEntryDescription(entryId);
  });

  loadLecture();
});
