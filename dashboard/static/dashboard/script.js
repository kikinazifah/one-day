/**
 * Akademia AI — JavaScript global
 *
 * File ini untuk hal yang dipakai bersama seluruh halaman:
 *   - identitas pengguna di sidebar & topbar (dari profil backend).
 *
 * Badge pengingat di sidebar **tidak** ditulis di sini lagi — itu
 * sekarang satu writer di ``dashboard/reminder_badge.js``, supaya
 * semua halaman menampilkan angka yang sama dari sumber yang sama.
 *
 * JavaScript khusus halaman disimpan terpisah di:
 * - document_creator.js
 * - lecture_listener.js
 * - reminder_system.js
 * - rag_assistant.js
 * - ai_lecturer.js
 * - auto_scheduler.js
 * - home.js
 *
 * Semua request ke backend lewat ``AkademiaApi`` (dashboard/api.js), yang
 * memegang satu cara memanggil fetch + cache singkat.
 */
document.addEventListener("DOMContentLoaded", () => {
  const api = window.AkademiaApi;
  if (!api) return;

  // =====================================================
  // BADGE PENGINGAT DI SIDEBAR
  // =====================================================

  // Penulisan badge diserahkan ke modul bersama — bukan ditulis ulang
  // di sini. Badge ini pernah punya tiga writer (script.js, home.js,
  // reminder_system.js) dengan tiga sumber data berbeda, jadi angkanya
  // bisa berbeda antar halaman.
  window.AkademiaReminderBadge?.mount();

  // =====================================================
  // IDENTITAS PENGGUNA
  // =====================================================

  // Nama, semester, dan jurusan diambil dari akun backend. Template
  // sebelumnya menulis "Ahmad Fauzan / NIM 13521049" sebagai teks tetap —
  // itu identitas fiktif yang tidak ada hubungannya dengan akun yang
  // benar-benar dipakai, jadi diganti dengan data asli.
  async function renderProfile() {
    const nameNodes = document.querySelectorAll("[data-profile-name]");
    const metaNodes = document.querySelectorAll("[data-profile-meta]");
    const campusNodes = document.querySelectorAll("[data-profile-campus]");
    const avatarNodes = document.querySelectorAll("[data-profile-avatar]");
    const firstNameNodes = document.querySelectorAll("[data-profile-first-name]");

    if (
      !nameNodes.length &&
      !metaNodes.length &&
      !campusNodes.length &&
      !avatarNodes.length &&
      !firstNameNodes.length
    ) {
      return;
    }

    let payload;
    try {
      payload = await api.profile();
    } catch (error) {
      console.warn("Profil gagal dimuat:", error);
      return;
    }

    const profile = payload.profile || {};
    const name = profile.name || "";
    const email = profile.email || "";
    const semester = profile.semester || "";
    const major = profile.major || "";

    nameNodes.forEach((node) => {
      node.textContent = name || email || "Pengguna";
    });

    // Sapaan di hero memakai nama depan saja. Kalau nama akun kosong,
    // pakai bagian email sebelum "@" supaya kalimat tetap masuk akal.
    const firstName =
      name.split(/\s+/).filter(Boolean)[0] ||
      email.split("@")[0] ||
      "Pengguna";
    firstNameNodes.forEach((node) => {
      node.textContent = firstName;
    });

    // Baris kecil di bawah nama: email akun (NIM tidak ada di backend).
    const meta = email || [semester, major].filter(Boolean).join(" • ");
    metaNodes.forEach((node) => {
      node.textContent = meta;
    });

    // Kartu kampus: jumlah mata kuliah aktif + semester.
    const courses = payload.courses || [];
    const activeCourses = courses.filter((course) => course.is_active !== false);
    campusNodes.forEach((node) => {
      const parts = [];
      if (activeCourses.length) {
        parts.push(activeCourses.length + " mata kuliah aktif");
      }
      if (semester && semester !== "-") parts.push("Semester " + semester);
      if (major && major !== "Service") parts.push(major);
      node.textContent = parts.join(" • ") || "Akademia AI";
    });

    // Avatar: inisial dari nama, karena backend tidak punya avatar.
    if (name) {
      const initials = name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0].toUpperCase())
        .join("");
      avatarNodes.forEach((node) => {
        node.textContent = initials || "U";
      });
    }
  }

  // =====================================================
  // UBAH PROFIL
  // =====================================================

  // Panel ubah profil. Field yang bisa diubah sama dengan ``UserUpdate`` di
  // backend (name, email, semester, major, avatar) — lihat
  // PROFILE_FIELDS di dashboard/views_api_profile.py.
  const profilePanel = document.getElementById("profilePanel");
  const profileForm = document.getElementById("profileForm");
  const editProfileButton = document.getElementById("editProfileButton");
  const closeProfileButton = document.getElementById("closeProfilePanel");
  const cancelProfileButton = document.getElementById("cancelProfileButton");
  const saveProfileButton = document.getElementById("saveProfileButton");
  const profileStatus = document.getElementById("profileFormStatus");

  const profileInputs = {
    name: document.getElementById("profileName"),
    email: document.getElementById("profileEmail"),
    semester: document.getElementById("profileSemester"),
    major: document.getElementById("profileMajor"),
  };

  function setProfileStatus(message, isError) {
    if (!profileStatus) return;

    profileStatus.textContent = message;
    profileStatus.style.color = isError ? "#b42318" : "#64748b";
  }

  function fillProfileForm(profile) {
    Object.entries(profileInputs).forEach(([key, input]) => {
      if (input) input.value = profile[key] || "";
    });
  }

  function openProfilePanel() {
    if (!profilePanel) return;

    // Isi form dari cache profil supaya tidak ada request tambahan.
    api
      .profile()
      .then((payload) => fillProfileForm(payload.profile || {}))
      .catch((error) => {
        console.warn("Profil gagal dimuat untuk form:", error);
        setProfileStatus("Profil gagal dimuat: " + error.message, true);
      });

    setProfileStatus("", false);
    profilePanel.hidden = false;
    profileInputs.name?.focus();
  }

  function closeProfilePanel() {
    if (profilePanel) profilePanel.hidden = true;
  }

  editProfileButton?.addEventListener("click", () => {
    if (profilePanel?.hidden) {
      openProfilePanel();
    } else {
      closeProfilePanel();
    }
  });

  closeProfileButton?.addEventListener("click", closeProfilePanel);
  cancelProfileButton?.addEventListener("click", closeProfilePanel);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && profilePanel && !profilePanel.hidden) {
      closeProfilePanel();
    }
  });

  // Klik di luar panel menutupnya.
  document.addEventListener("click", (event) => {
    if (!profilePanel || profilePanel.hidden) return;
    if (profilePanel.contains(event.target)) return;
    if (editProfileButton?.contains(event.target)) return;

    closeProfilePanel();
  });

  profileForm?.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (saveProfileButton) saveProfileButton.disabled = true;
    setProfileStatus("Menyimpan profil...");

    // Hanya field yang berubah yang dikirim, supaya PATCH tidak menimpa
    // field lain dengan nilai kosong.
    const payload = {};

    Object.entries(profileInputs).forEach(([key, input]) => {
      if (!input) return;
      payload[key] = input.value.trim();
    });

    try {
      const data = await api.request("PATCH", "/api/profile/", { body: payload });

      // Cache profil harus dibuang supaya sidebar & topbar menampilkan
      // data terbaru, bukan hasil fetch sebelum PATCH.
      api.invalidate("profile");

      if (data.profile) fillProfileForm(data.profile);

      await renderProfile();

      setProfileStatus("Profil tersimpan di backend.");
      closeProfilePanel();
    } catch (error) {
      setProfileStatus("Gagal menyimpan: " + error.message, true);
    } finally {
      if (saveProfileButton) saveProfileButton.disabled = false;
    }
  });

  // =====================================================
  // KARTU AKTIVITAS AKUN
  // =====================================================

  // Backend tidak punya konsep kuota token, jadi angka "84% Sisa" yang
  // tadinya ada di sidebar tidak punya dasar data. Diganti ringkasan
  // aktivitas yang bisa dihitung dari data nyata: tugas selesai, dokumen
  // terindeks, dan jadwal.
  async function renderActivity() {
    const countNodes = document.querySelectorAll("[data-activity-count]");
    const bars = document.querySelectorAll("[data-activity-bar]");
    if (!countNodes.length && !bars.length) return;

    let done = 0;
    let total = 0;
    let indexed = 0;

    try {
      const [taskData, documentData] = await Promise.all([
        api.tasks(),
        api.get("/api/rag/documents/").catch(() => ({ documents: [] })),
      ]);

      const tasks = taskData.tasks || [];
      total = tasks.length;
      done = tasks.filter(
        (task) => task.is_completed === true || task.status === "completed",
      ).length;

      const documents = documentData.documents || [];
      indexed = documents.filter((doc) => doc.status === "indexed").length;
    } catch (error) {
      console.warn("Aktivitas akun gagal dimuat:", error);
      return;
    }

    countNodes.forEach((node) => {
      node.textContent = done + "/" + total + " Tugas";
    });

    // Persentase penyelesaian = tugas yang sudah selesai. Kalau belum ada
    // tugas, bar dikosongkan — bukan diisi 100% yang menipu.
    const percent = total ? Math.round((done / total) * 100) : 0;
    bars.forEach((bar) => {
      bar.style.width = percent + "%";
    });
  }

  renderProfile();
  renderActivity();
});
