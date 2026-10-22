/**
 * Helper tanggal & waktu — satu definisi untuk seluruh halaman.
 *
 * Helpers ini tadinya ditulis ulang di lima file JavaScript:
 * ``home.js``, ``ai_lecturer.js``, ``auto_scheduler.js``,
 * ``reminder_system.js``, dan ``catatan_kuliah.js``. Setiap salinan
 * sedikit berbeda, dan itu justru bagian masalahnya:
 *
 *   - `formatWallClock` ada di dua file dengan isi identik.
 *   - `formatUtc` ada di dua file dengan isi identik.
 *   - `parseNaiveDateTime` ada di dua file dengan isi identik.
 *   - `formatClock` ("HH:MM") ada di dua file dengan isi identik.
 *   - `formatTimestamp` (detik → "mm:ss") di `auto_scheduler.js` dan
 *     `formatClock` (detik → "mm:ss") di `catatan_kuliah.js` — **nama
 *     berbeda, isi sama**. Dua nama untuk satu fungsi adalah cara paling
 *     mahal untuk menemukan bug: yang satu diperbaiki, yang satunya
 *     tidak pernah diketahui ada.
 *
 * Salinan seperti itu tidak selalu salah — tapi begitu salah,
 * perbaikannya harus di lima tempat, dan satu tempat yang lupa
 * diperbarui membuat dua halaman menampilkan tanggal berbeda untuk
 * data yang sama.
 *
 * **Jadi semuanya dipusatkan di sini.** Modul ini dimuat sebagai skrip
 * bersama (lihat `_shared_scripts.html`), sebelum skrip halaman mana
 * pun.
 *
 * ---
 *
 * ## Dua jenis waktu — kenapa ada dua helper
 *
 * Backend menyimpan dua jenis waktu, dan **keduanya** dikirim sebagai
 * ISO string **tanpa** sufiks zona waktu:
 *
 *   - **Jam dinding** (`due_date`, `start_time`, `period_start`) —
 *     "jam berapa di tempat pengguna berada". Tanpa sufiks, `new Date()`
 *     membacanya sebagai waktu **lokal** — persis yang kita mau.
 *   - **UTC** (`created_at`, `generated_at`) — cap waktu sistem.
 *     Tanpa sufiks, `new Date()` membacanya sebagai waktu lokal, jadi
 *     nilainya tampil tujuh jam lebih awal di WIB. Harus diberi `"Z"`
 *     eksplisit supaya dibaca sebagai instants.
 *
 * Karena itu ada `formatWallClock` dan `formatUtc` terpisah, dan call
 * site **wajib memilih** yang sesuai — satu helper yang "menebak" akan
 * salah diam-diam di salah satu call site. Lihat `docs/02-WAKTU-DAN-ZONA.md`.
 *
 * ---
 *
 * ## Fallback
 *
 * `datetime_utils_fallback.js` dimuat **sebelum** file ini dan
 * mendefinisikan API yang sama, tapi **hanya kalau modul ini absen**.
 * Jadi kalau file ini gagal dimuat (404, cache basi), halaman tetap
 * punya formatter yang benar — bukan hanya formatter cadangan yang
 * menerima "--" dan membiarkan panel kosong.
 *
 * Penanda `AkademiaDateTimeIsFallback` dihapus di akhir file ini,
 * persis seperti `task_state.js` melakukannya — kalau tidak dihapus,
 * penandanya selalu `true` dan tidak berguna untuk diagnosa.
 */
(function (global) {
  "use strict";

  // Nama bulan singkat Indonesia.
  //
  // Dipakai `formatTaskDeadline`. Sengaja **tidak** memakai
  // `toLocaleDateString("id-ID", { month: "short" })`: bawaan peramban
  // bisa menghasilkan "Okt" atau "okt" tergantung implementasi, dan
  // string ini dipakai sebagai label jadwal yang harus stabil antar
  // peramban.
  const SHORT_MONTHS = [
    "Jan", "Feb", "Mar", "Apr", "Mei", "Jun",
    "Jul", "Agu", "Sep", "Okt", "Nov", "Des",
  ];

  /**
   * Jam dinding → teks.
   *
   * Untuk field yang maknanya "jam berapa di tempat pengguna":
   * `due_date`, `start_time`, `end_time`, `period_start`, `period_end`.
   *
   * Nilai kosong → `"-"`. Nilai yang tidak bisa diuraikan → string
   * aslinya (bukan `Invalid Date`).
   */
  function formatWallClock(value) {
    if (!value) return "-";

    // String naive tanpa sufiks zona dibaca `new Date()` sebagai waktu
    // lokal — itu yang kita mau untuk jam dinding.
    const date = new Date(value);

    if (Number.isNaN(date.getTime())) return String(value);

    return date.toLocaleString("id-ID", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  }

  /**
   * Cap waktu UTC → teks.
   *
   * Untuk field yang maknanya instants: `created_at`, `updated_at`,
   * `generated_at`, `completed_at`.
   *
   * Kalau string-nya sudah punya sufiks zona (`Z` atau `+07:00`), ia
   * dipakai apa adanya; kalau tidak, `"Z"` ditambahkan supaya dibaca
   * sebagai UTC, bukan sebagai waktu lokal.
   */
  function formatUtc(value) {
    if (!value) return "-";

    const text = String(value);
    const hasZone = /Z$|[+-]\d{2}:?\d{2}$/.test(text);
    const date = new Date(hasZone ? text : text + "Z");

    if (Number.isNaN(date.getTime())) return String(value);

    return date.toLocaleString("id-ID", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  }

  /**
   * Naive datetime backend → `Date` lokal.
   *
   * Parsing manual lebih aman daripada `new Date(...)`: komponen diambil
   * apa adanya, tanpa dipengaruhi konversi UTC. `null` kalau formatnya
   * tidak cocok.
   */
  function parseNaiveDateTime(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(
      String(value || ""),
    );

    if (!match) return null;

    return new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      0,
      0,
    );
  }

  /**
   * `Date` lokal → "YYYY-MM-DD".
   *
   * Dipakai untuk membandingkan tanggal server dengan tanggal entri.
   */
  function dateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");

    return year + "-" + month + "-" + day;
  }

  /**
   * Ambil "HH:MM" dari string apa pun.
   *
   * Untuk jam dinding yang sudah jadi string ("2026-10-21T08:00:00" →
   * "08:00"). `"--:--"` kalau tidak ada pola jamnya — dipakai supaya
   * panel jadwal menampilkan placeholder, bukan `null` atau "undefined".
   */
  function formatClock(value) {
    const match = /(\d{2}):(\d{2})/.exec(String(value || ""));

    if (!match) return "--:--";

    return `${match[1]}:${match[2]}`;
  }

  /**
   * Durasi dalam detik → "mm:ss".
   *
   * Untuk durasi rekaman dan posisi pemutar — **bukan** jam dinding.
   * Kalau tidak, "1:30" (satu menit tiga puluh detik) akan tercampur
   * dengan "01:30" (satu jam tiga puluh menit) di panel yang sama.
   *
   * @param {number} seconds
   * @param {string} fallback  Dikembalikan kalau nilainya bukan angka
   *   atau negatif. Default `"00:00"` — pemutar audio selalu punya
   *   durasi, jadi "00:00" lebih jujur daripada "-".
   */
  function formatDuration(seconds, fallback = "00:00") {
    const total = Number(seconds);

    if (!Number.isFinite(total) || total < 0) return fallback;

    const minutes = Math.floor(total / 60);
    const secs = Math.floor(total % 60);

    return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  /**
   * Naive datetime backend → nilai `<input type="datetime-local">`.
   *
   * Backend menyimpan jam dinding tanpa zona waktu
   * ("2026-10-25T23:59:00"), sedangkan `datetime-local` butuh
   * "2026-10-25T23:59". Ambil komponennya langsung dari string supaya
   * nilainya pasti sama dengan yang diketik pengguna.
   */
  function toDatetimeLocal(value) {
    const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(value || "");
    return match ? match[1] + "T" + match[2] : "";
  }

  /**
   * Nilai `<input type="datetime-local">` → naive datetime backend.
   *
   * `<input type="datetime-local">` sudah memberi nilai
   * "YYYY-MM-DDTHH:mm" dalam zona waktu browser. Backend menyimpan
   * waktu NAIVE (tanpa zona), jadi string itu dikirim apa adanya —
   * jangan lewat `toISOString()`, karena itu menggeser jam dinding
   * sebesar offset browser.
   */
  function naiveDateTime(value) {
    const text = String(value || "").trim();

    if (!text) return "";

    // Buang detik kalau ada, lalu tambahkan ":00" supaya backend
    // menerima format lengkap.
    return text.length === 16 ? `${text}:00` : text;
  }

  /**
   * `Date` → "20 Okt".
   *
   * Untuk label kalender mingguan. Menerima `Date`, bukan string —
   * kalau string, hasilnya bisa salah diam-diam (lihat catatan di
   * `docs/02-WAKTU-DAN-ZONA.md` § "Jebakan parsing tanggal Indonesia").
   */
  function formatDate(date) {
    return date.toLocaleDateString("id-ID", {
      day: "numeric",
      month: "short",
    });
  }

  /**
   * `Date` → "Senin, 20 Oktober 2026".
   */
  function formatLongDate(date) {
    return date.toLocaleDateString("id-ID", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  }

  /**
   * Tenggat → "Senin, 25 Oktober 2026 • 23:59".
   *
   * Bentuk **panjang** — dipakai halaman Reminder System, di mana
   * tenggat adalah hal utama yang dilihat user.
   *
   * Sengaja **tidak** sama dengan `formatTaskDeadline` (lihat di
   * bawah). Dua bentuk itu melayani dua halaman berbeda; menyamakan
   * keduanya berarti salah satu halaman berubah tampilannya tanpa
   * sengaja.
   */
  function formatDeadline(value) {
    if (!value) return "Tanpa tenggat";

    // Tenggat disimpan sebagai jam dinding (tanpa zona waktu) — maknanya
    // "23:59 di tempat pengguna berada". Ambil komponen waktu apa adanya
    // dari string ISO-nya supaya tidak ada konversi zona waktu di
    // tengah jalan.
    //
    // Catatan: untuk bentuk *date-time* ("2026-10-25T23:59:00"),
    // `new Date()` sudah memarsingnya sebagai waktu **lokal** (spesifikasi
    // ECMAScript — hanya bentuk tanggal-saja yang dianggap UTC). Jadi
    // parsing manual di sini bukan soal memperbaiki bug `new Date()`,
    // melainkan supaya perilakunya jelas dan tidak berubah diam-diam.
    const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(value);

    if (!match) return value;

    const [, year, month, day, hour, minute] = match;
    const date = new Date(Number(year), Number(month) - 1, Number(day));
    const weekday = date.toLocaleDateString("id-ID", { weekday: "long" });

    return (
      weekday +
      ", " +
      Number(day) +
      " " +
      date.toLocaleDateString("id-ID", { month: "long", year: "numeric" }) +
      " • " +
      hour +
      ":" +
      minute
    );
  }

  /**
   * Tenggat → "31 Des 2026, 23:59".
   *
   * Bentuk **pendek** — dipakai Auto Scheduler, di mana tenggat cuma
   * satu baris di antara banyak baris lain dan tempatnya sempit.
   *
   * Bentuknya berbeda dari `formatDeadline` secara sengaja; lihat
   * catatan di function itu.
   */
  function formatTaskDeadline(value) {
    const match =
      /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(value || ""));

    if (!match) return value ? String(value) : "-";

    const [, year, month, day, hour, minute] = match;
    const monthName = SHORT_MONTHS[Number(month) - 1] || month;

    return `${Number(day)} ${monthName} ${year}, ${hour}:${minute}`;
  }

  global.AkademiaDateTime = {
    formatWallClock,
    formatUtc,
    parseNaiveDateTime,
    dateKey,
    formatClock,
    formatDuration,
    toDatetimeLocal,
    naiveDateTime,
    formatDate,
    formatLongDate,
    formatDeadline,
    formatTaskDeadline,
  };

  // Modul utama yang menang. Penanda ini **wajib dihapus** di sini:
  // `datetime_utils_fallback.js` dimuat lebih dulu dan men-set
  // `AkademiaDateTimeIsFallback = true`. Kalau modul utama hanya
  // menimpa `AkademiaDateTime` tanpa menghapus penandanya, penanda itu
  // tetap `true` pada kasus normal — jadi penanda yang selalu benar
  // tidak berguna untuk diagnosa, dan lebih buruk: penanda yang
  // selalu `true`-trained jadi tidak dibaca sama sekali.
  delete global.AkademiaDateTimeIsFallback;
})(window);
