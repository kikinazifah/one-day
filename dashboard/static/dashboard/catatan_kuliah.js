document.addEventListener("DOMContentLoaded", () => {
  const $ = (selector) => document.querySelector(selector);

  const notesInput = $("#lnStudentNotes");
  const saveButton = $("#lnSave");
  const saveStatus = $("#lnSaveStatus");

  // Jika tab catatan belum ada pada halaman ini, hentikan script.
  if (!notesInput) return;

  const storageKey = "akademia-catatan-kuliah";

  // Muat catatan yang sebelumnya disimpan pada browser ini.
  try {
    notesInput.value = localStorage.getItem(storageKey) || "";
  } catch (error) {
    console.warn("Catatan lokal tidak dapat dimuat.", error);
  }

  // Simpan catatan pribadi.
  saveButton?.addEventListener("click", () => {
    try {
      localStorage.setItem(storageKey, notesInput.value);

      if (saveStatus) {
        saveStatus.textContent = "Catatan berhasil disimpan di browser ini.";
      }
    } catch (error) {
      console.error("Gagal menyimpan catatan.", error);

      if (saveStatus) {
        saveStatus.textContent =
          "Catatan gagal disimpan. Periksa pengaturan browser.";
      }
    }
  });

  // Beri tanda ketika catatan diubah.
  notesInput.addEventListener("input", () => {
    if (saveStatus) {
      saveStatus.textContent = "Ada perubahan yang belum disimpan.";
    }
  });

  // Fokuskan input ketika tombol bookmark diklik.
  $("#lnEditBookmark")?.addEventListener("click", () => {
    notesInput.focus();
    notesInput.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  });

  // Tombol play masih berupa simulasi sampai file audio tersedia.
  $("#lnPlay")?.addEventListener("click", (event) => {
    const button = event.currentTarget;
    const isPlaying = button.dataset.playing === "true";

    button.dataset.playing = String(!isPlaying);
    button.textContent = isPlaying ? "▶" : "Ⅱ";

    const hint = $("#lnAudioHint");

    if (hint) {
      hint.textContent = isPlaying
        ? "Pemutar demo dijeda. File audio belum dihubungkan."
        : "Mode demo aktif. Hubungkan file audio untuk pemutaran asli.";
    }
  });

  // Unduh ringkasan materi sebagai TXT.
  $("#lnDownload")?.addEventListener("click", () => {
    const content = [
      "CATATAN KULIAH",
      "Pertemuan 7: Sequence Modeling & Attention Introduction",
      "",
      "1. Scaled Dot-Product Attention",
      "Query berperan sebagai kata kunci, key sebagai label informasi,",
      "dan value sebagai isi konten yang digunakan model.",
      "",
      "2. Multi-Head Attention",
      "Model dapat memperhatikan beberapa representasi hubungan secara paralel.",
      "",
      "CATATAN PRIBADI",
      notesInput.value || "(Belum ada catatan pribadi.)",
    ].join("\n");

    const blob = new Blob([content], {
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

  // Tombol integrasi: arahkan ke route Django ketika sudah tersedia.
  $("#lnOpenListener")?.addEventListener("click", () => {
    window.dispatchEvent(new CustomEvent("akademia:open-lecture-listener"));

    if (typeof window.openLectureListener === "function") {
      window.openLectureListener();
    } else {
      alert("Lecture Listener belum dihubungkan ke route Django.");
    }
  });

  $("#lnSendDocument")?.addEventListener("click", () => {
    window.dispatchEvent(
      new CustomEvent("akademia:send-to-document-creator", {
        detail: {
          notes: notesInput.value,
        },
      }),
    );

    if (typeof window.sendToDocumentCreator === "function") {
      window.sendToDocumentCreator(notesInput.value);
    } else {
      alert("Document Creator belum dihubungkan ke route Django.");
    }
  });
});
