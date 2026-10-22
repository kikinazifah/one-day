/**
 * Badge "mendesak" di sidebar — satu writer untuk seluruh halaman.
 *
 * Badge ini ditulis di tiga tempat sebelumnya: `script.js` (semua
 * halaman), `home.js` (dashboard), dan `reminder_system.js` (halaman
 * reminder). Tiga writer untuk satu angka berarti tiga sumber kebenaran:
 *
 *   - bentuknya beda. `script.js` dan `home.js` menyembunyikan badge saat
 *     angkanya nol; `reminder_system.js` menyembunyikannya juga saat
 *     daftarnya **belum termuat** — jadi di halaman reminder badge
 *     sempat hilang padahal ada tugas mendesak, lalu muncul belakangan.
 *   - waktunya beda. Masing-masing memanggil `/api/tasks/` sendiri, dan
 *     `api.js` menyimpan cache 10 detik — jadi dua halaman yang dibuka
 *     berdekatan bisa menampilkan angka yang berbeda.
 *   - akibatnya, angka di sidebar bisa berbeda dari angka di kartu
 *     "mendesak" halaman yang sedang dibuka.
 *
 * Modul ini jadi satu-satunya tempat yang menulis badge, dan satu
 * pemanggilan yang menyalakan semua badge di halaman (sidebar desktop +
 * sidebar mobile di `home.html` — keduanya punya `data-reminder-badge`).
 *
 * Angka "mendesak" sendiri tetap dihitung dengan definisi yang sama
 * untuk semua halaman: `task_state.js`.
 *
 * **Badge ini tidak mengambil `/api/tasks/` sendiri.** Dulu iya — dan
 * itu sumber bug "split-brain": badge dan kartu statistik di halaman
 * Reminder mengambil dua respons yang berbeda, sehingga sidebar
 * menampilkan angka yang berbeda dari kartu di halaman yang sama.
 * Sekarang keduanya membaca **snapshot yang sama** dari `api.js`, jadi
 * tidak mungkin berbeda.
 */
(function (global) {
  "use strict";

  const SELECTOR = "[data-reminder-badge]";

  // Nilai terakhir yang digambar, dan daftar tugas yang dipakainya.
  //
  // Disimpan supaya bisa diperiksa tanpa harus mengulang request: badge
  // di DOM dan nilai ini digambar dalam satu operasi, jadi membacanya
  // berdua selalu konsisten. Ini juga yang membuat audit bisa
  // membandingkan badge dengan hitungannya di **momen yang sama** —
  // kalau badge dibaca sekarang dan daftar dihitung ulang nanti, data
  // bisa berubah di tengah (mis. tugas lain sedang diselesaikan), dan
  // hasilnya bukan bug tapi race.
  let lastValue = null;
  let lastTasks = [];

  /**
   * Hitung jumlah tugas mendesak dari daftar tugas.
   *
   * `isUrgent` dihitung dengan definisi yang sama untuk semua halaman
   * (lihat `task_state.js`) — kalau halaman ini punya daftar sendiri
   * yang berbeda, angkanya bisa berbeda dari yang di sidebar.
   */
  function countUrgent(tasks, isUrgent) {
    if (!Array.isArray(tasks)) return 0;
    return tasks.filter((task) => isUrgent(task)).length;
  }

  /**
   * Tulis angka ke semua badge yang ada di halaman.
   *
   * Badge disembunyikan kalau angkanya nol — **hanya kalau angkanya
   * memang nol**, bukan kalau datanya belum dimuat. Badge yang
   * disembunyikan karena "belum tahu" berbeda maknanya dengan badge
   * yang memang tidak ada isinya, dan yang pertama membuat user
   * salah paham bahwa tidak ada tugas mendesak.
   */
  function paint(value) {
    lastValue = value;
    document.querySelectorAll(SELECTOR).forEach((badge) => {
      badge.textContent = String(value);
      badge.hidden = value === 0;
    });
  }

  /**
   * Tulis badge dari daftar tugas yang sudah ada.
   *
   * Fungsi ini **tidak** melakukan request — pemanggilnya yang
   * memutuskan datanya dari mana. Itu titik kuncinya: kalau modul ini
   * yang mengambil datanya sendiri, isinya bisa berbeda dari yang
   * dipakai kartu statistik di halaman yang sama.
   *
   * @param {object[]} tasks  Daftar tugas.
   * @param {object} state  `window.AkademiaTaskState`.
   * @returns {number} angka yang ditulis.
   */
  function paintFromTasks(tasks, state) {
    const list = Array.isArray(tasks) ? tasks : [];
    lastTasks = list;
    const urgent = countUrgent(list, state.isUrgent);
    paint(urgent);
    return urgent;
  }

  /**
   * Muat daftar tugas lalu tulis badge-nya.
   *
   * Memakai snapshot bersama dari `api.js` — jadi hasilnya sama dengan
   * yang dilihat kartu statistik, bukan request terpisah.
   *
   * @param {object} api  `window.AkademiaApi`.
   * @param {object} state  `window.AkademiaTaskState`.
   * @returns {Promise<number>} angka yang ditulis.
   */
  async function refresh(api, state) {
    if (!api) return 0;

    try {
      const data = await api.tasks();
      return paintFromTasks(data.tasks || [], state);
    } catch (error) {
      // Badge tidak boleh jadi alasan halaman gagal dimuat. Nilai
      // terakhir dibiarkan tampil apa adanya.
      console.warn("Badge pengingat gagal dimuat:", error);
      return null;
    }
  }

  /**
   * Badge yang sedang tampil, beserta daftar tugas yang dipakainya.
   *
   * Keduanya berasal dari satu operasi `paint()`, jadi konsisten satu
   * sama lain. Dipakai audit untuk membandingkan badge dengan
   * hitungan ulang **dari data yang sama** — bukan dari request baru,
   * yang bisa mengembalikan data yang sudah berubah.
   */
  function state() {
    return { value: lastValue, tasks: lastTasks };
  }

  /**
   * Pasang badge ke halaman.
   *
   * Dipanggil sekali per halaman. Badge **berlangganan** snapshot
   * bersama — jadi setiap kali daftar tugas berubah, badge digambar
   * ulang dari data yang sama dengan yang dipakai kartu statistik.
   *
   * Polling ringan tetap ada: kalau tab dibiarkan terbuka berjam-jam,
   * angka di sidebar harus tetap benar tanpa perlu refresh manual.
   */
  function mount(options = {}) {
    const api = global.AkademiaApi;
    const taskState = global.AkademiaTaskState;

    if (!api || !taskState) return null;

    // Fungsi yang dipakai halaman untuk menyegarkan badge setelah
    // mutasi (mis. menandai tugas selesai).
    const refreshBadge = () => refresh(api, taskState);

    if (options.onRefresh) {
      options.onRefresh(refreshBadge);
    }

    // Berlangganan snapshot: badge ikut berubah **otomatis** setiap
    // kali daftar tugas berubah — termasuk perubahan yang pemicu
    // halaman lain (mis. tab lain menandai tugas selesai).
    const unsubscribe = api.subscribeTasks((snapshot) => {
      paintFromTasks(snapshot.tasks, taskState);
    });

    // Gambar dari snapshot yang sudah ada (kalau halaman ini memuat
    // ulang, snapshotnya masih berlaku — tidak perlu request lagi).
    const current = api.taskSnapshot();
    if (current && current.loaded) {
      paintFromTasks(current.tasks, taskState);
    } else {
      refreshBadge();
    }

    // Polling ringan. Badge sidebar adalah angka "sekarang" — kalau
    // user membiarkan tab terbuka berjam-jam, angkanya harus tetap
    // benar tanpa perlu refresh manual.
    const timer = setInterval(refreshBadge, 30000);

    return {
      refresh: refreshBadge,
      stop: () => {
        clearInterval(timer);
        unsubscribe();
      },
    };
  }

  global.AkademiaReminderBadge = {
    mount,
    refresh,
    paint,
    paintFromTasks,
    countUrgent,
    state,
  };
})(window);
