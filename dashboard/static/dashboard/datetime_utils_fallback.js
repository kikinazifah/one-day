/**
 * Cadangan untuk `datetime_utils.js`.
 *
 * Dimuat **sebelum** `datetime_utils.js` (lihat `_shared_scripts.html`).
 * Kalau file utama berhasil dimuat, modul ini tidak melakukan apa-apa —
 * `datetime_utils.js` menimpanya.
 *
 * Kenapa perlu cadangan: `datetime_utils.js` mendefinisikan
 * `window.AkademiaDateTime`, dan lima halaman memakainya
 * (`home.js`, `ai_lecturer.js`, `auto_scheduler.js`,
 * `reminder_system.js`, `catatan_kuliah.js`). Kalau file utamanya gagal
 * dimuat — 404, cache basi, path statis yang berubah — maka
 * `window.AkademiaDateTime` jadi `undefined`, dan pemanggilnya yang
 * melakukan destructure melempar `TypeError` **di dalam handler
 * `DOMContentLoaded`**. Satu file statis yang hilang mematikan seluruh
 * handler itu: panel jadwal, daftar tugas, dan kalender ikut mati — dan
 * tidak ada apa pun di layar yang mengetahuinya.
 *
 * Catatan penting: untuk modul waktu, fallback **tidak boleh** mengembalikan
 * placeholder seperti "--:--". Placeholder berarti "saya tidak tahu" — dan
 * kalau itu terjadi untuk setiap tanggal di halaman, panel tampil benar
 * secara visual tapi isinya salah. Jadi di sini didefinisikan versi
 * minimal yang **menghitung ulang** nilai yang sama, bukan yang
 * mengembalikan placeholder.
 *
 * Definisi ini sengaja dibuat sama dengan `datetime_utils.js`, tapi
 * tidak boleh jadi tempat perubahan: kalau aturan parsing berubah,
 * ubah `datetime_utils.js` — bukan file ini.
 */
(function (global) {
  "use strict";

  // Kalau modul utama sudah ada (dimuat lebih dulu di urutan tag), jangan
  // sentuh apa pun.
  if (global.AkademiaDateTime) return;

  const SHORT_MONTHS = [
    "Jan", "Feb", "Mar", "Apr", "Mei", "Jun",
    "Jul", "Agu", "Sep", "Okt", "Nov", "Des",
  ];

  function formatWallClock(value) {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString("id-ID", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  }

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

  function dateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");

    return year + "-" + month + "-" + day;
  }

  function formatClock(value) {
    const match = /(\d{2}):(\d{2})/.exec(String(value || ""));

    if (!match) return "--:--";

    return `${match[1]}:${match[2]}`;
  }

  function formatDuration(seconds, fallback = "00:00") {
    const total = Number(seconds);

    if (!Number.isFinite(total) || total < 0) return fallback;

    const minutes = Math.floor(total / 60);
    const secs = Math.floor(total % 60);

    return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  function toDatetimeLocal(value) {
    const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(value || "");
    return match ? match[1] + "T" + match[2] : "";
  }

  function naiveDateTime(value) {
    const text = String(value || "").trim();

    if (!text) return "";

    return text.length === 16 ? `${text}:00` : text;
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

  function formatDeadline(value) {
    if (!value) return "Tanpa tenggat";

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

  global.AkademiaDateTimeIsFallback = true;
})(window);
