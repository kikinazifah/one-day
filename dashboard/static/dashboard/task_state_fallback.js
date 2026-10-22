/**
 * Cadangan untuk `task_state.js`.
 *
 * Dimuat **sebelum** `task_state.js` (lihat `_shared_scripts.html`).
 * Kalau file utama berhasil dimuat, modul ini tidak melakukan apa-apa —
 * `task_state.js` menimpanya.
 *
 * Kenapa perlu cadangan: `task_state.js` mendefinisikan
 * `window.AkademiaTaskState`, dan tiga halaman memakainya
 * (`script.js`, `home.js`, `reminder_system.js`). Kalau file utamanya
 * gagal dimuat — 404, cache basi, path statis yang berubah — maka
 * `window.AkademiaTaskState` jadi `undefined`, dan pemanggilnya
 * `const { isUrgent } = window.AkademiaTaskState` melempar
 * `TypeError` **di dalam handler `DOMContentLoaded`**. Satu file statis
 * yang hilang mematikan seluruh handler itu: badge sidebar, panel
 * notifikasi, dan profil ikut mati — dan tidak ada apa pun di layar
 * yang mengetahuinya.
 *
 * Jadi di sini didefinisikan versi minimal yang **hanya dipakai kalau
 * modul utama tidak ada**. Definisi ini sengaja dibuat sama dengan
 * `task_state.js`, tapi tidak boleh jadi tempat perubahan: kalau aturan
 * "mendesak" berubah, ubah `task_state.js` — bukan file ini.
 */
(function (global) {
  "use strict";

  // Kalau modul utama sudah ada (dimuat lebih dulu di urutan tag), jangan
  // sentuh apa pun.
  if (global.AkademiaTaskState) return;

  function isCompleted(task) {
    if (!task) return false;
    return task.is_completed === true || task.status === "completed";
  }

  function isOverdue(task) {
    if (!task) return false;
    return task.status === "overdue";
  }

  function isUrgent(task) {
    if (isCompleted(task)) return false;
    return (
      task.priority === "high" ||
      task.priority === "urgent" ||
      isOverdue(task)
    );
  }

  global.AkademiaTaskState = { isCompleted, isOverdue, isUrgent };
  global.AkademiaTaskStateIsFallback = true;
})(window);
