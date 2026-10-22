/**
 * Cadangan untuk ``api.js`` — hanya aktif kalau ``api.js`` gagal dimuat.
 *
 * **Kenapa file ini perlu ada.** ``api.js`` adalah tulang punggung seluruh
 * halaman: semua request ke backend lewat sana. Kalau file itu gagal
 * dimuat (404, koneksi putus, file_static yang gagal serve), maka
 * ``window.AkademiaApi`` tidak ada — dan setiap halaman yang memanggil
 * ``api.tasks()`` akan **macet selamanya** di teks "Memuat tugas...".
 * Tidak ada error, tidak ada stack trace, tidak ada tombol "Coba lagi".
 * User hanya melihat "datanya kosong" — persis gejala yang dilaporkan.
 *
 * Diperiksa secara empiris (``probe_repro_kosong.js``): dengan ``api.js``
 * diblokir, panel Dashboard menampilkan "Memuat tugas..." / "Memuat
 * jadwal..." selamanya, dan tidak ada satu pun pesan error di layar.
 *
 * **Kenapa fallback-nya bekerja, bukan sekadar placebo.** Modul ini
 * mengimplementasikan klien HTTP-nya sendiri dengan ``fetch`` bawaan
 * browser — bukan dependensi ke ``api.js``. Jadi kalau ``api.js`` hilang,
 * halamannya **tetep berfungsi**: request tetap terkirim, data tetap
 * tampil. Yang hilang cuma-ke-hal (cache TTL, batas waktu default,
 * snapshot bersama yangIFO hemat) — bukan fungsionalitas dasarnya.
 *
 * **Surface-nya sengaja LENGKAP, bukan minimal.** Modul lain memanggil
 * ``api.subscribeTasks(...)`` dan ``api.taskSnapshot()`` **tanpa**
 * optional chaining (``reminder_badge.js:161,167``). Kalau fallback
 * hanya menyediakan ``get``/``post``, pemanggilan itu jadi
 * ``TypeError: api.subscribeTasks is not a function`` — dilempar di
 * dalam ``mount()``, dan satu handler yang melempar mematikan seluruh
 * handler ``DOMContentLoaded`` di halaman itu. Badge mati **dan**
 * notifikasi + profil ikut mati. Jadi fallback wajib menyediakan
 * seluruh surface yang dipakai halaman.
 *
 * **Yang TIDAK ada di sini, dan itu disengaja.** Snapshot bersama
 * (``subscribeTasks``/``taskSnapshot``) di fallback ini bekerja, tapi
 * tidak sekompleks versi utama: tidak ada coalescing permintaan, tidak
 * ada TTL, tidak ada invalidasi lintas-widget. Fallback adalah
 * "halaman tetap jalan", bukan "semuanya tetap seoptimal biasa". Kalau
 * ``api.js`` dimuat, dialah yang menang — lihat blok ``delete`` di
 * ``api.js``.
 */
(function (global) {
  "use strict";

  // Modul utama sudah ada (dimuat lebih dulu) — jangan sentuh apa pun.
  if (global.AkademiaApi) return;

  const CSRF_SELECTOR = "input[name='csrfmiddlewaretoken']";

  function csrfToken() {
    return document.querySelector(CSRF_SELECTOR)?.value || "";
  }

  /** Batas waktu default — sama dengan ``api.js``. */
  const TIMEOUT_DEFAULT_MS = 30000;

  function timeoutSignal(milliseconds) {
    if (!milliseconds) return undefined;
    if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
      return AbortSignal.timeout(milliseconds);
    }
    return undefined;
  }

  function buildHeaders(options) {
    const headers = { "X-CSRFToken": csrfToken() };

    if (options.body !== undefined && !options.formData) {
      headers["Content-Type"] = "application/json";
    }

    if (options.headers) {
      for (const [key, value] of Object.entries(options.headers)) {
        // ``Content-Type`` multipart harus dibiarkan ke browser.
        if (options.formData && key.toLowerCase() === "content-type") continue;
        headers[key] = value;
      }
    }

    return headers;
  }

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

  function patch(url, body, options) {
    return request("PATCH", url, { ...options, body: body === undefined ? {} : body });
  }

  function del(url, options) {
    return request("DELETE", url, options);
  }

  function upload(url, formData, options) {
    return request("POST", url, { ...options, formData });
  }

  function postBinary(url, body, contentType = "application/octet-stream", options = {}) {
    return request("POST", url, {
      ...options,
      body,
      headers: { "Content-Type": contentType, ...(options.headers || {}) },
    });
  }

  /** Respons mentah — untuk SSE yang butuh `response.body` sebagai stream. */
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
      const data = await parse(response);
      throw new Error(data.error || "Permintaan gagal (" + response.status + ")");
    }

    return response;
  }

  // =====================================================
  // CACHE SINGKAT
  // =====================================================

  const cache = new Map();

  function cached(key, loader, ttl = 10000) {
    const entry = cache.get(key);
    const now = Date.now();

    if (entry && now - entry.at < ttl) return entry.promise;

    const promise = loader().catch((error) => {
      cache.delete(key);
      throw error;
    });

    cache.set(key, { at: now, promise });
    return promise;
  }

  function invalidate(key) {
    cache.delete(key);
  }

  // =====================================================
  // SNAPSHOT TUGAS
  // =====================================================

  /**
   * Snapshot tugas untuk fallback.
   *
   * Bentuknya sama persis dengan versi utama — ``{tasks, loaded, error,
   * version}`` — karena konsumen (``reminder_badge.js``,
   * ``reminder_system.js``, ``home.js``) membaca property itu langsung.
   * Yang tidak ada: coalescing permintaan (dua pemanggil = dua request)
   * dan TTL. Setengah enak, tapi benar — dan jauh lebih baik daripada
   * `TypeError` yang mematikan seluruh handler halaman.
   */
  let snapshot = { tasks: [], loaded: false, error: null, version: 0 };
  const taskListeners = new Set();

  function notifyTaskListeners() {
    taskListeners.forEach((listener) => {
      try {
        listener(snapshot);
      } catch (error) {
        console.warn("Pendengar snapshot tugas gagal:", error);
      }
    });
  }

  async function fetchTasks() {
    try {
      const data = await get("/api/tasks/");
      snapshot = {
        tasks: Array.isArray(data.tasks) ? data.tasks : [],
        loaded: true,
        error: null,
        version: snapshot.version + 1,
      };
      notifyTaskListeners();
      return { ok: true, tasks: snapshot.tasks };
    } catch (error) {
      snapshot = { ...snapshot, error: error.message };
      notifyTaskListeners();
      throw error;
    }
  }

  async function tasks() {
    return fetchTasks();
  }

  async function refreshTasks() {
    return fetchTasks();
  }

  function taskSnapshot() {
    return snapshot;
  }

  function subscribeTasks(listener) {
    taskListeners.add(listener);
    return () => taskListeners.delete(listener);
  }

  // =====================================================
  // PROFIL & NOTIFIKASI
  // =====================================================

  function profile() {
    return cached("profile", () => get("/api/profile/"), 60000);
  }

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

  // Penanda: modul ini yang aktif, bukan ``api.js``. ``api.js`` menghapus
  // penanda ini kalau ia sendiri berhasil dimuat — jadi penandanya hanya
  // `true` kalau memang fallback yang dipakai, dan bisa dipakai untuk
  // diagnosa.
  global.AkademiaApiIsFallback = true;
})(window);
