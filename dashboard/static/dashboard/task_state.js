/**
 * Status tugas — satu definisi untuk seluruh halaman.
 *
 * Dua predicate ini sebelumnya ditulis ulang di empat file
 * (``script.js``, ``home.js``, ``reminder_system.js``,
 * ``auto_scheduler.js``). Salinan seperti itu tidak selalu salah — tapi
 * begitu salah, perbaikannya harus diempat tempat, dan satu tempat
 * yang lupa diperbarui membuat badge di sidebar beda dengan angka di
 * halaman. Jadi keduanya dipusatkan di sini.
 *
 * **"Terlambat" dibaca dari server, bukan dihitung ulang di peramban.**
 * `due_date` adalah jam dinding (zona aplikasi, `APP_TIMEZONE`), bukan
 * instants. `Date.now()` adalah jam browser. Kalau browser berada di
 * zona lain — dan itu hal yang wajar — perbandingan di sisi peramban
 * salah sebesar offset zona: di UTC, tugas yang sudah lewat tenggat
 * 7 jam tidak ditandai, dan badge "mendesak" di sidebar jadi berbeda
 * dari angka server selama jendela itu.
 *
 * Backend sudah menghitung statusnya dari jam dinding yang benar
 * (`_effective_status()` di `app/api/routes/tasks.py`) dan mengirimkannya
 * di field `status`. Jadi di sini cukup dibaca.
 */
(function (global) {
  "use strict";

  /**
   * Sudah selesai?
   *
   * Dua sumbernya bisa berbeda: `is_completed` (boolean) dan `status`
   * (enum). Keduanya dibaca, dan salah satunya cukup.
   */
  function isCompleted(task) {
    if (!task) return false;
    return task.is_completed === true || task.status === "completed";
  }

  /**
   * Sudah lewat tenggat?
   *
   * Verdict-nya milik server — lihat catatan di atas file ini.
   */
  function isOverdue(task) {
    if (!task) return false;
    return task.status === "overdue";
  }

  /**
   * Mendesak? Prioritas tinggi/mendesak yang belum selesai, atau sudah
   * lewat tenggat.
   */
  function isUrgent(task) {
    if (isCompleted(task)) return false;
    return (
      task.priority === "high" ||
      task.priority === "urgent" ||
      isOverdue(task)
    );
  }

  global.AkademiaTaskState = {
    isCompleted,
    isOverdue,
    isUrgent,
  };

  // Modul utama yang menang. Penanda ini **wajib dihapus** di sini:
  // `task_state_fallback.js` dimuat lebih dulu dan men-set
  // `AkademiaTaskStateIsFallback = true`. Kalau modul utama hanya
  // menimpa `AkademiaTaskState` tanpa menghapus penandanya, penanda
  // itu tetap `true` pada kasus normal — jadi penanda yang selalu
  // benar tidak berguna untuk diagnosa, dan lebih buruk: penanda
  // yang selalu `true`-trained jadi tidak dibaca sama sekali.
  delete global.AkademiaTaskStateIsFallback;
})(window);
