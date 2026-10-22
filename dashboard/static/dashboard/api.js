/**
 * Klien API bersama untuk seluruh halaman dashboard Akademia AI.
 *
 * Semua halaman talking ke backend lewat endpoint JSON Django (BFF), bukan
 * langsung ke FastAPI — token service dipegang Django, browser tidak pernah
 * melihat JWT. Modul ini menyediakan:
 *
 *   - satu cara memanggil fetch (dengan header CSRF & penanganan error),
 *   - satu cache singkat supaya beberapa widget di halaman yang sama tidak
 *     memanggil endpoint yang sama berulang-ulang (mis. badge sidebar dan
 *     daftar tugas),
 *   - **satu snapshot daftar tugas** yang dipakai seluruh halaman, supaya
 *     badge sidebar dan kartu statistik tidak pernah melihat dua daftar
 *     berbeda (lihat bagian "SNAPSHOT TUGAS"),
 *   - satu tempat invalidasi cache setelah mutasi.
 *
 * Dipakai oleh: script.js, reminder_system.js, rag_assistant.js, home.js.
 */
(function (global) {
  "use strict";

  const CSRF_SELECTOR = "input[name='csrfmiddlewaretoken']";

  // Endpoint JSON dashboard memakai proteksi Origin (bukan token CSRF),
  // tapi header ini tetap dikirim — biaya satu header, dan tetap aman kalau
  // suatu saat proteksinya diperketat.
  function csrfToken() {
    return document.querySelector(CSRF_SELECTOR)?.value || "";
  }

  /**
   * Batas waktu default satu request.
   *
   * Tanpa batas, request yang menggantung (backend restart, jaringan mati)
   * membuat spinner berputar selamanya — dan user tidak pernah tahu itu
   * "sedang memuat" atau "macet". Batas default ini cukup untuk endpoint
   * biasa; pemanggil yang tahu operation-nya lambat (upload, generate
   * dokumen) menaikkan sendiri lewat `timeoutMs`.
   */
  const TIMEOUT_DEFAULT_MS = 30000;

  /**
   * Signal pembatalan berbasis waktu.
   *
   * `AbortSignal.timeout` baru ada di browser modern. Kalau tidak ada,
   * request berjalan tanpa batas — lebih baik daripada gagal total.
   */
  function timeoutSignal(milliseconds) {
    if (!milliseconds) return undefined;
    if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
      return AbortSignal.timeout(milliseconds);
    }
    return undefined;
  }

  /**
   * Susun header request.
   *
   * Header kustom menimpa default (mis. `Accept: text/event-stream` untuk
   * SSE). Satu pengecualian: `Content-Type` untuk body multipart **tidak**
   * boleh disentuh pemanggil — browser yang harus menaruhnya, supaya
   * boundary multipart-nya benar.
   */
  function buildHeaders(options) {
    const headers = { "X-CSRFToken": csrfToken() };

    if (options.body !== undefined && !options.formData) {
      headers["Content-Type"] = "application/json";
    }

    if (options.headers) {
      for (const [key, value] of Object.entries(options.headers)) {
        if (options.formData && key.toLowerCase() === "content-type") continue;
        headers[key] = value;
      }
    }

    return headers;
  }

  /**
   * `fetch` dengan batas waktu dan pesan error yang bisa dibaca user.
   *
   * `AbortSignal.timeout` melempar `TimeoutError` — namanya tidak
   * menjelaskan apa pun ke user, jadi diterjemahkan di sini.
   */
  async function fetchWithTimeout(url, init, timeoutMs) {
    const signal = init.signal || timeoutSignal(timeoutMs);

    try {
      return await fetch(url, { ...init, signal });
    } catch (error) {
      if (error && error.name === "TimeoutError") {
        throw new Error("Permintaan terlalu lama — coba lagi.");
      }
      throw error;
    }
  }

  async function parse(response) {
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { error: text.slice(0, 300) };
    }
  }

  /**
   * Panggil endpoint JSON dashboard.
   *
   * @param {string} method  HTTP method.
   * @param {string} url     Path relatif, mis. "/api/tasks/".
   * @param {object} options
   *   - body:      objek → dikirim sebagai JSON.
   *   - formData:  FormData → dikirim sebagai multipart (tanpa set Content-Type).
   *   - headers:   header tambahan, menimpa default.
   *   - timeoutMs: batas waktu; default `TIMEOUT_DEFAULT_MS`, `0` = tanpa batas.
   *   - signal:    `AbortSignal` dari pemanggil (menimpa `timeoutMs`).
   * @returns {Promise<object>} payload JSON dari server.
   * @throws {Error} dengan pesan dari server (``error``) atau status HTTP.
   */
  async function request(method, url, options = {}) {
    const headers = buildHeaders(options);
    let payload;

    if (options.formData) {
      payload = options.formData;
    } else if (options.body !== undefined) {
      payload = JSON.stringify(options.body);
    }

    const response = await fetchWithTimeout(
      url,
      { method, headers, body: payload, signal: options.signal },
      options.timeoutMs === undefined ? TIMEOUT_DEFAULT_MS : options.timeoutMs,
    );

    const data = await parse(response);

    if (!response.ok || data.ok === false) {
      throw new Error(data.error || "Permintaan gagal (" + response.status + ")");
    }
    return data;
  }

  function get(url, options) {
    return request("GET", url, options);
  }

  function post(url, body, options) {
    return request("POST", url, { ...options, body: body === undefined ? {} : body });
  }

  /**
   * Ubah sebagian field. Backend memakai PATCH untuk pembaruan sebagian —
   *PATCH lebih jujur daripada POST yang menimpa seluruh resource.
   */
  function patch(url, body, options) {
    return request("PATCH", url, { ...options, body: body === undefined ? {} : body });
  }

  function del(url, options) {
    return request("DELETE", url, options);
  }

  function upload(url, formData, options) {
    return request("POST", url, { ...options, formData });
  }

  /**
   * Kirim body biner apa adanya (mis. potongan PCM mentah).
   *
   * Berbeda dari `upload()` yang memakai multipart, ini tidak membungkus
   * apa pun — body dikirim persis seperti yang diberikan, dengan
   * `Content-Type` yang disebutkan.
   *
   * Biner tidak boleh dibungkus base64: ukurannya jadi 4/3 lebih besar
   * tanpa ada keuntungan, dan base64 butuh dekode di kedua sisi.
   */
  function postBinary(url, body, contentType = "application/octet-stream", options = {}) {
    return request("POST", url, {
      ...options,
      body,
      headers: { "Content-Type": contentType, ...(options.headers || {}) },
    });
  }

  /**
   * Panggil endpoint dan terima `Response` mentah.
   *
   * Diperlukan untuk SSE: pemanggil harus membaca `response.body` sebagai
   * stream, sedangkan `request()` selalu mengurai body jadi JSON — begitu
   * JSON diurai, stream-nya sudah hilang.
   *
   * Status error ditangani di sini, jadi pemanggil cukup membaca
   * `response.body` tanpa perlu memeriksa `response.ok` lagi.
   */
  async function raw(method, url, options = {}) {
    const headers = buildHeaders(options);
    let payload;

    if (options.formData) {
      payload = options.formData;
    } else if (options.body !== undefined) {
      payload = JSON.stringify(options.body);
    }

    const response = await fetchWithTimeout(
      url,
      { method, headers, body: payload, signal: options.signal },
      options.timeoutMs === undefined ? TIMEOUT_DEFAULT_MS : options.timeoutMs,
    );

    if (!response.ok) {
      // Body error bisa berupa JSON (dari BFF) atau teks biasa. Dicoba
      // diurai; kalau gagal, teks mentahnya yang dipakai.
      const data = await parse(response);
      throw new Error(data.error || "Permintaan gagal (" + response.status + ")");
    }

    return response;
  }

  // =====================================================
  // CACHE SINGKAT
  // =====================================================

  const cache = new Map();

  /**
   * Jalankan `loader` paling banyak sekali dalam rentang `ttl`.
   *
   * TTL sengaja pendek (default 10 detik): cukup untuk menyatisfy beberapa
   * widget di halaman yang sama, tapi tidak cukup lama untuk membuat data
   * basi setelah ada mutasi.
   */
  function cached(key, loader, ttl = 10000) {
    const entry = cache.get(key);
    const now = Date.now();

    if (entry && now - entry.at < ttl) return entry.promise;

    const promise = loader().catch((error) => {
      // Request yang gagal jangan disimpan — percobaan berikutnya harus
      // mencoba lagi.
      cache.delete(key);
      throw error;
    });

    cache.set(key, { at: now, promise });
    return promise;
  }

  function invalidate(key) {
    cache.delete(key);

    if (key === TASKS_KEY) {
      // Tandai basi — tapi **jangan** dikosongkan. Pembaca harus tetap bisa
      // menampilkan data terakhir yang diketahui sampai data baru datang.
      snapshotAt = 0;
    }
  }

  // Kunci cache daftar tugas. Disdeclare di sini supaya `invalidate()`
  // di atas bisa memakainya tanpa kena temporal dead zone.
  const TASKS_KEY = "tasks";

  // Profil akun dipakai sidebar + topbar di semua halaman.
  const PROFILE_KEY = "profile";

  function profile() {
    return cached(PROFILE_KEY, () => get("/api/profile/"), 60000);
  }

  // =====================================================
  // SNAPSHOT TUGAS — SATU SUMBER KEBENARAN
  // =====================================================

  /**
   * Daftar tugas untuk seluruh halaman — **satu** snapshot.
   *
   * Kenapa tidak biarkan tiap pemanggil mengambil `/api/tasks/` sendiri:
   * dua pemanggil di halaman yang sama bisa mendapat **dua respons yang
   * berbeda**. Kalau isinya berbeda, angka di sidebar beda dengan angka
   * di kartu — di halaman yang sama, pada saat yang sama.
   *
   * Ini bukan risiko teoretis. `probe_race_splitbrain.js` memunculkan
   * badge=1 sementara kartu "mendesak"=0 di halaman Reminder yang sama:
   * badge menunggu respons yang lebih lambat, dan menimpa angka kartu
   * dengan data yang lebih lama.
   *
   * Jadi aturannya satu: **satu permintaan, satu snapshot, semua
   * pembaca.** Badge sidebar, kartu statistik, panel dashboard, dan baris
   * di daftar tugas semuanya membaca snapshot yang sama — dan semuanya
   * digambar ulang bersama-sama saat snapshot berubah.
   */

  // Seberapa lama snapshot dianggap masih segar. Cukup untuk satisfy
  // beberapa widget di halaman yang sama, tidak cukup lama untuk
  // membuat data basi setelah ada mutasi.
  const TASKS_TTL = 10000;

  // Snapshot yang sedang berlaku. `version` naik setiap kali diganti,
  // jadi pembaca bisa tahu datanya sudah berganti.
  let snapshot = { tasks: [], loaded: false, error: null, version: 0 };
  let snapshotAt = 0;

  // Permintaan yang sedang berjalan. Permintaan yang sedang berjalan
  // dipakai bersama: pemanggil kedua menunggu request yang sama, bukan
  // memulai request baru.
  let taskRequest = null;

  // Nomor urut permintaan — dipakai untuk melacak request mana yang
  // sedang berjalan. Snapshot sendiri ditulis dengan aturan "respons
  // terakhir yang tiba yang menang" (lihat `publishTasks`).
  let taskRequestSeq = 0;

  // Pendengar snapshot. Dipanggil setiap kali snapshot diganti, supaya
  // semua tampilan yang memakainya menggambar ulang dari data yang sama.
  const taskListeners = new Set();

  function notifyTaskListeners() {
    taskListeners.forEach((listener) => {
      try {
        listener(snapshot);
      } catch (error) {
        // Satu pendengar yang gagal tidak boleh menghentikan pendengar lain.
        console.warn("Pendengar snapshot tugas gagal:", error);
      }
    });
  }

  /**
   * Tulis daftar tugas ke snapshot.
   *
   * **Respons yang tiba terakhir menang.** Dua permintaan bisa berjalan
   * bersamaan, dan server bisa menjawabnya dalam urutan yang terbalik.
   * Aturan "yang tiba terakhir menang" dipilih karena:
   *
   *   - tidak pernah membuang data — respons apa pun yang diterima
   *     pasti dipakai, dan
   *   - sesuai dengan pengalaman: respons yang tiba belakangan umumnya
   *     dibaca server belakangan juga, jadi isinya lebih baru.
   *
   * Yang penting: respons ini hanya menulis snapshot, dan **semua
   * pembaca membaca snapshot yang sama**. Ketidakkonsistenan tidak
   * terjadi di dalam snapshot — tapi di antara dua pembaca.
   */
  function publishTasks(tasks) {
    snapshot = {
      tasks: Array.isArray(tasks) ? tasks : [],
      loaded: true,
      error: null,
      version: snapshot.version + 1,
    };
    snapshotAt = Date.now();
    notifyTaskListeners();
  }

  function failTasks(message) {
    // Kegagalan tidak boleh menghapus data yang sudah dimuat — snapshot
    // lama masih lebih berguna daripada tidak ada sama sekali.
    snapshot = { ...snapshot, error: message };
    notifyTaskListeners();
  }

  /**
   * Ambil daftar tugas dari server.
   *
   * Setiap respons yang tiba menulis snapshot — jadi snapshot selalu
   * mencerminkan respons server terakhir yang diterima, terlepas dari
   * urutan kedatangannya.
   */
  async function fetchTasks() {
    taskRequestSeq += 1;

    try {
      const data = await get("/api/tasks/");
      publishTasks(data.tasks || []);
      return data;
    } catch (error) {
      failTasks(error.message);
      throw error;
    }
  }

  /** Isi snapshot dalam bentuk payload, sama seperti respons server. */
  function taskPayload() {
    return { ok: true, tasks: snapshot.tasks };
  }

  /**
   * Daftar tugas — mungkin dari snapshot, mungkin dari server.
   *
   * Permintaan yang sedang berjalan dipakai bersama: pemanggil kedua
   * tidak memulai request baru, tapi menunggu request yang sama. Jadi
   * satu snapshot dipakai semua, bukan satu per pemanggil.
   *
   * Yang dikembalikan selalu **snapshot yang berlaku saat ini** — bukan
   * body respons milik pemanggil itu sendiri. Kalau ada permintaan yang
   * lebih baru selesai lebih dulu, pemanggil ini ikut melihat data
   * yang lebih baru, bukan data lamanya. Inilah yang membuat badge dan
   * kartu tidak pernah melihat dua daftar berbeda.
   */
  async function tasks() {
    if (taskRequest) {
      await taskRequest;
      return taskPayload();
    }

    if (snapshot.loaded && Date.now() - snapshotAt < TASKS_TTL) {
      return taskPayload();
    }

    const request = fetchTasks();
    taskRequest = request;
    try {
      await request;
    } finally {
      if (taskRequest === request) taskRequest = null;
    }
    return taskPayload();
  }

  /**
   * Muat ulang daftar tugas dari server.
   *
   * Dipakai setelah mutasi (buat, ubah, hapus, tandai selesai). Selalu
   *=request baru — data mungkin berubah sejak snapshot terakhir, jadi
   * snapshot lama tidak boleh dipakai.
   */
  async function refreshTasks() {
    const request = fetchTasks();
    taskRequest = request;
    try {
      await request;
    } finally {
      if (taskRequest === request) taskRequest = null;
    }
    return taskPayload();
  }

  /** Snapshot yang berlaku sekarang — untuk pembaca sinkron. */
  function taskSnapshot() {
    return snapshot;
  }

  /**
   * Daftar snapshot yang berlaku setiap kali berubah.
   *
   * @param {(snapshot: object) => void} listener
   * @returns {() => void} Fungsi untuk berhenti berlangganan.
   */
  function subscribeTasks(listener) {
    taskListeners.add(listener);
    return () => taskListeners.delete(listener);
  }

  /**
   * Notifikasi yang belum sempat ditampilkan ke peramban.
   *
   * `since` adalah cap waktu notifikasi terakhir yang sudah dilihat
   * peramban (naive UTC, format sama dengan `created_at` yang dikirim
   * backend). Backend membandingkan kolom `created_at` — jadi formatnya
   * harus sama persis, tanpa sufiks zona waktu.
   *
   * Sengaja **tidak** memakai `cached()`: kunci cache-nya berisi
   * `since` yang terus berubah, jadi setiap polling menambah kunci baru
   * tanpa pernah dipakai lagi (pertumbuhan tanpa batas), dan data yang
   * di-cache justru berlawanan dengan tujuan polling — yang dicari
   * adalah yang *baru*.
   */
  function notificationsPending(since) {
    const query = since ? "?since=" + encodeURIComponent(since) : "";
    return get("/api/notifications/pending/" + query);
  }

  global.AkademiaApi = {
    request,
    get,
    post,
    patch,
    del,
    upload,
    postBinary,
    raw,
    cached,
    invalidate,
    tasks,
    refreshTasks,
    taskSnapshot,
    subscribeTasks,
    profile,
    notificationsPending,
  };

  // Modul utama yang menang. Penanda ini **wajib dihapus** di sini:
  // `api_fallback.js` dimuat lebih dulu dan men-set
  // `AkademiaApiIsFallback = true`. Kalau modul utama hanya menimpa
  // `AkademiaApi` tanpa menghapus penandanya, penanda itu tetap `true`
  // pada kasus normal — jadi penanda yang selalu benar tidak berguna
  // untuk diagnosa, dan lebih buruk: penanda yang selalu `true`-trained
  // jadi tidak dibaca sama sekali.
  delete global.AkademiaApiIsFallback;
})(window);
