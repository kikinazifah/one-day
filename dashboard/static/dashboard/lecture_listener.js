/**
 * Lecture Listener — terhubung ke backend FastAPI (student-assistant)
 * lewat endpoint JSON Django (dashboard/views_api_lecture.py):
 *
 *   POST /api/lecture/start/          → buat sesi rekaman
 *   POST /api/lecture/<id>/audio/     → unggah rekaman (multipart, field "file")
 *   POST /api/lecture/<id>/chunks/    → unggah potongan PCM live (raw binary)
 *   GET  /api/lecture/<id>/live/      → transkrip parsial (polling)
 *   POST /api/lecture/<id>/stop/      → hentikan sesi
 *   GET  /api/lecture/<id>/status/    → status sesi (dipakai polling)
 *   GET  /api/lecture/<id>/transcript/→ transkrip + segmen
 *   GET  /api/lecture/<id>/summary/   → ringkasan
 *   GET  /api/lecture/                → daftar sesi
 *   DELETE /api/lecture/<id>/delete/  → hapus sesi (transkrip + berkas audio)
 *
 * Catatan penting soal alur backend:
 *
 * 1. `POST /api/lecture/<id>/audio/` hanya menandai status `transcribing` lalu
 *    men-kick off Whisper di background. Transkrip BELUM ada saat respons
 *    balik, jadi setelah upload kita polling `/status/` sampai `completed`
 *    (atau `failed`). Revisi: `POST .../stop/` juga men-set `transcribing`,
 *    bukan `completed` — makanya polling, bukan menunggu status selesai.
 * 2. Transkripsi di CPU butuh waktu (puluhan detik sampai beberapa menit),
 *    jadi UI menampilkan status "Memproses transkrip…" selama polling —
 *    halaman tidak boleh terlihat beku.
 * 3. Kalau mikrofon ditolak/tidak ada, UI menawarkan unggah berkas rekaman
 *    yang ada (fallback). Backend tetap mentranskrip berkas via Whisper.
 *
 * **Jalur live (FR-05).** Mic dicapture sebagai PCM mentah (bukan
 * `MediaRecorder` — lihat `lecture_capture.js` untuk alasannya). Tiap
 * potongan dikirim ke `/chunks/`; transkrip parsial dibaca dari `/live/`
 * tiap ~2 detik. Potongan yang gagal dikirim disimpan di IndexedDB
 * (`lecture_offline.js`) lalu dikirim ulang saat koneksi kembali.
 */
document.addEventListener("DOMContentLoaded", () => {
  // =====================================================
  // ELEMEN
  // =====================================================

  const form = document.getElementById("lectureForm");
  const timeNode = document.getElementById("recordingTime");
  const recordButton = document.getElementById("recordButton");
  const recordLabel = document.getElementById("recordButtonLabel");
  const statusNode = document.getElementById("recordingStatus");
  const hintNode = document.getElementById("recordHint");
  const titleInput = document.getElementById("lectureTitle");
  const fileInput = document.getElementById("audioFileInput");
  const transcriptArea = document.getElementById("transcript");
  const segmentsNode = document.getElementById("transcriptSegments");
  const summaryBox = document.getElementById("lectureSummary");
  const summarizeButton = document.getElementById("summarizeButton");
  const summarizeLabel = document.getElementById("summarizeLabel");
  const historyNode = document.getElementById("sessionHistory");
  const historyHint = document.getElementById("historyHint");

  // Elemen live (FR-05).
  const liveIndicator = document.getElementById("liveIndicator");
  const liveIndicatorText = document.getElementById("liveIndicatorText");
  const liveIndicatorBuffer = document.getElementById("liveIndicatorBuffer");
  const liveBufferCount = document.getElementById("liveBufferCount");
  const liveTranscript = document.getElementById("liveTranscript");
  const liveTranscriptMeta = document.getElementById("liveTranscriptMeta");
  const liveTranscriptSegments = document.getElementById("liveTranscriptSegments");

  const csrfToken =
    form?.querySelector("input[name='csrfmiddlewaretoken']")?.value || "";

  // =====================================================
  // STATE
  // =====================================================

  let mediaRecorder = null;
  let mediaStream = null;
  let chunks = [];
  let elapsed = 0;
  let intervalId = null;
  let recording = false;
  let busy = false;
  let currentSessionId = null;
  let pollTimer = null;
  let pollAttempts = 0;

  // Status pemuatan riwayat sesi: belum pernah dimuat / sedang memuat /
  // sudah pernah dimuat / gagal memuat.
  //
  // Tanpa ini, panel riwayat menampilkan "Belum ada sesi rekaman." selama
  // request berjalan — padahal ada belasan sesi di server. User mengira
  // rekamannya hilang.
  let sessionsLoaded = false;
  let sessionsLoading = false;
  let sessionsError = null;
  // Sesi terakhir yang berhasil dimuat. Disimpan supaya render ulang
  // selama reload tidak menghapus daftar yang sedang ditampilkan.
  let currentSessions = [];

  // ---- State pemilihan sesi (pulih setelah ganti halaman) ----
  //
  // Navigasi dashboard adalah `<a href>` biasa: tiap klik menu = reload
  // penuh, jadi `currentSessionId` (sebagai "sesi yang sedang ditampilkan")
  // hilang dan panel transkrip kosong. Padahal ekspor & ringkasan juga
  // membaca id yang sama — akibatnya kembali dari halaman lain membuat
  // tombol ekspor menolak dengan "Rekaman atau unggah berkas dulu".
  //
  // `viewSessionId` = sesi yang sedang ditampilkan di panel (bisa berbeda
  // dari `currentSessionId`, yang hanya berarti "sesi milik rekaman yang
  // sedang berjalan"). Pemilihan terakhir ditulis ke sessionStorage supaya
  // reload membukanya lagi.
  const LAST_SESSION_KEY = "akademia.lectureLastSession";
  let viewSessionId = null;
  let restoreSeq = 0;

  // ---- State live (FR-05) ----
  // `capture` = instance LectureCapture (PCM) atau null kalau jatuh ke
  // jalur MediaRecorder. `offlineStore` = buffer IndexedDB.
  // `socket` = koneksi WebSocket ke FastAPI (jalur realtime).
  let capture = null;
  let offlineStore = null;
  let socket = null;
  let liveTimer = null;
  let liveSeq = 0;
  let liveSent = 0;
  let livePending = 0;
  let liveMode = "idle"; // idle | pcm | mediatracer
  let liveSegments = [];

  // Transport: "ws" (WebSocket realtime) atau "http" (potongan via POST).
  //
  // WebSocket adalah jalur utama — transkrip muncul **saat** rekaman
  // berjalan. Jalur HTTP dipertahankan sebagai cadangan: kalau tiket
  // tidak bisa terbit atau WebSocket ditolak server, rekaman tetap
  // berhasil lewat upload per potongan.
  let liveTransport = "http";
  let liveReconnectTimer = null;
  let liveReconnectAttempts = 0;
  let liveStopping = false;
  let liveSocketDone = false;

  // Alasan penolakan live terakhir dari server (mis. "Tiket tidak valid
  // atau kedaluwarsa."). Disimpan supaya indikator bisa menampilkan
  // penyebab **spesifik** — bukan pesan generik yang tidak membantu
  // operator diagnosa.
  let liveRejectionReason = "";

  // Angka potongan & detik terekam yang ditampilkan di panel live.
  //
  // Dipisah dari teks DOM karena frame `status` datang dalam dua
  // bentuk: yang **pertama** (menanda server sudah validasi tiket)
  // membawa `last_seq`, sedangkan frame lanjutan (yang dikirim kalau
  // satu jendela transkripsi kosong) tidak. Kalau teks langsung ditulis
  // ke DOM, frame lanjutan itu akan mereset hitungan potongan ke nol.
  let liveMetaChunks = 0;
  let liveMetaSeconds = 0;

  // Whisper di CPU lambat; batas polling longgar supaya rekaman panjang
  // tidak dianggap gagal. 400 × 3 detik ≈ 20 menit.
  const POLL_INTERVAL_MS = 3000;
  const POLL_MAX_ATTEMPTS = 400;

  // Polling transkrip live: 2 detik. Transkripsi satu potongan di CPU
  // butuh ~1 detik, jadi 2 detik cukup responsif tanpa membanjiri
  // backend.
  const LIVE_POLL_MS = 2000;

  // =====================================================
  // TOAST
  // =====================================================

  const toast = document.getElementById("toast");
  let toastTimeout;

  function showToast(message) {
    if (!toast) {
      console.info(message);
      return;
    }

    toast.textContent = message;
    toast.classList.add("visible");

    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove("visible"), 4000);
  }

  // =====================================================
  // HTTP
  // =====================================================

  async function parseJson(response) {
    try {
      return await response.json();
    } catch {
      return {};
    }
  }

  async function postJson(url, body) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRFToken": csrfToken,
      },
      body: JSON.stringify(body),
    });

    const data = await parseJson(response);

    if (!response.ok || data.ok === false) {
      throw new Error(data.error || "Permintaan gagal (" + response.status + ")");
    }
    return data;
  }

  async function getJson(url) {
    const response = await fetch(url, {
      headers: { "X-CSRFToken": csrfToken },
    });

    const data = await parseJson(response);

    if (!response.ok || data.ok === false) {
      throw new Error(data.error || "Permintaan gagal (" + response.status + ")");
    }
    return data;
  }

  /**
   * Hapus sumber daya.
   *
   * Backend `DELETE /lecture/{id}` membalas 204 No Content — body-nya kosong,
   * jadi `parseJson` akan mengembalikan `{}` dan `data.ok` jadi `undefined`.
   * Karena itu error yang dicek hanya dari status HTTP: `ok: false` yang
   * dikembalikan BFF untuk status non-2xx sudah tertangkap oleh
   * `!response.ok`.
   */
  async function deleteJson(url) {
    const response = await fetch(url, {
      method: "DELETE",
      headers: { "X-CSRFToken": csrfToken },
    });

    const data = await parseJson(response);

    if (!response.ok || data.ok === false) {
      throw new Error(data.error || "Permintaan gagal (" + response.status + ")");
    }
    return data;
  }

  /**
   * Unggah audio sebagai multipart.
   *
   * Penting: JANGAN set header "Content-Type" secara manual di sini —
   * browser harus menambahkan sendiri `multipart/form-data; boundary=...`.
   * Kalau header dipaksa, boundary hilang dan backend tidak bisa memparse.
   */
  async function postFile(url, blob, filename) {
    const formData = new FormData();
    formData.append("file", blob, filename);

    const response = await fetch(url, {
      method: "POST",
      headers: { "X-CSRFToken": csrfToken },
      body: formData,
    });

    const data = await parseJson(response);

    if (!response.ok || data.ok === false) {
      throw new Error(data.error || "Unggahan gagal (" + response.status + ")");
    }
    return data;
  }

  /**
   * Kirim satu potongan PCM mentah ke server.
   *
   * Body-nya byte mentah (`application/octet-stream`), bukan multipart
   * dan bukan JSON — PCM tidak punya konsep field, dan base64 hanya
   * menambah 33% ukuran.
   */
  async function postChunk(sessionId, seq, rate, bytes) {
    const url =
      "/api/lecture/" +
      encodeURIComponent(sessionId) +
      "/chunks/?seq=" +
      encodeURIComponent(seq) +
      "&rate=" +
      encodeURIComponent(rate);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "X-CSRFToken": csrfToken,
        "Content-Type": "application/octet-stream",
      },
      body: bytes,
    });

    const data = await parseJson(response);

    if (!response.ok || data.ok === false) {
      throw new Error(data.error || "Unggahan potongan gagal (" + response.status + ")");
    }
    return data;
  }

  // =====================================================
  // TIMER
  // =====================================================

  function renderTime() {
    if (!timeNode) return;

    const h = String(Math.floor(elapsed / 3600)).padStart(2, "0");
    const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, "0");
    const s = String(elapsed % 60).padStart(2, "0");

    timeNode.textContent = `${h}:${m}:${s}`;
  }

  function startTimer() {
    stopTimer();
    intervalId = setInterval(() => {
      elapsed++;
      renderTime();
    }, 1000);
  }

  function stopTimer() {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  function setStatus(text) {
    if (statusNode) statusNode.textContent = text;
  }

  function setRecordLabel(text) {
    if (recordLabel) recordLabel.textContent = text;
    else if (recordButton) recordButton.textContent = text;
  }

  function setBusy(state, label) {
    busy = state;

    if (recordButton) recordButton.disabled = state;
    if (summarizeButton) summarizeButton.disabled = state;

    if (summarizeLabel) {
      summarizeLabel.textContent = state ? label || "Memproses..." : "Buat Ringkasan";
    }
  }

  // =====================================================
  // RENDER
  // =====================================================

  /** detik → mm:ss (timestamp per segmen transkrip). */
  function formatStamp(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const m = String(Math.floor(total / 60)).padStart(2, "0");
    const s = String(total % 60).padStart(2, "0");
    return `${m}:${s}`;
  }

  /**
   * Render segmen transkrip. Semua teks masuk lewat textContent, jadi
   * isi transkrip (yang berasal dari model Whisper) tidak pernah
   * diperlakukan sebagai HTML.
   */
  function renderSegments(segments) {
    if (!segmentsNode) return;

    segmentsNode.replaceChildren();

    if (!Array.isArray(segments) || segments.length === 0) {
      const empty = document.createElement("p");
      empty.className = "form-note";
      empty.textContent = "Belum ada segmen transkrip.";
      segmentsNode.append(empty);
      return;
    }

    segments.forEach((segment) => {
      const row = document.createElement("div");
      row.className = "transcript-segment";

      const stamp = document.createElement("span");
      stamp.className = "transcript-time";
      stamp.textContent = formatStamp(segment.start);

      const text = document.createElement("p");
      text.className = "transcript-text";
      text.textContent = segment.text || "";

      row.append(stamp, text);
      segmentsNode.append(row);
    });
  }

  function renderTranscript(transcript) {
    if (transcriptArea && typeof transcript === "string") {
      transcriptArea.value = transcript;
    }
  }

  function renderSummary(summary) {
    if (!summaryBox) return;

    summaryBox.replaceChildren();

    const heading = document.createElement("h3");
    heading.textContent = "Ringkasan Materi";

    const body = document.createElement("p");
    body.textContent =
      summary && summary.trim()
        ? summary
        : "Ringkasan belum tersedia untuk sesi ini.";

    summaryBox.append(heading, body);
  }

  function renderHistory(sessions) {
    if (!historyNode) return;

    historyNode.replaceChildren();

    if (!Array.isArray(sessions) || sessions.length === 0) {
      // Empat kondisi dibedakan: gagal memuat, sedang memuat, belum sempat
      // dimuat, dan memang tidak ada sesi. Semuanya terlihat "kosong"
      // kalau cuma dilihat dari isi panel — padahal maknanya berbeda.
      historyNode.className = "history-empty";

      if (sessionsError) {
        historyNode.textContent = "Gagal memuat riwayat sesi. " + sessionsError;
      } else if (sessionsLoading || !sessionsLoaded) {
        historyNode.textContent = "Memuat riwayat sesi...";
      } else {
        historyNode.textContent = "Belum ada sesi rekaman.";
      }
      return;
    }

    historyNode.className = "history-list";

    sessions.forEach((session) => {
      const row = document.createElement("div");
      row.className = "history-row";

      const body = document.createElement("div");
      body.className = "history-body";

      // Judul berperan sebagai tombol "buka sesi ini" — jalur utama untuk
      // mengembalikan transkrip setelah halaman direload saat ganti menu.
      const name = document.createElement("strong");
      name.textContent = session.title || "Sesi tanpa judul";

      const isOpen = session.id === viewSessionId;
      if (isOpen) row.classList.add("is-selected");
      name.setAttribute("role", "button");
      name.setAttribute("tabindex", "0");
      name.setAttribute(
        "aria-label",
        (isOpen ? "Sedang dibuka: " : "Buka sesi ") + name.textContent,
      );

      const openSelected = () => {
        if (recording || busy) {
          // Membuka sesi lain di tengah rekaman/upload akan menimpa
          // `currentSessionId` dan isi panel — proses yang sedang berjalan
          // bisa menulis transkrip ke sesi yang salah.
          showToast("Tunggu proses rekaman yang sedang berjalan selesai.");
          return;
        }
        openSession(session.id);
      };

      name.addEventListener("click", openSelected);
      name.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openSelected();
        }
      });

      const meta = document.createElement("span");
      meta.className = "history-meta";

      const status = document.createElement("span");
      status.className = "badge " + statusBadgeClass(session.status);
      status.textContent = session.status || "unknown";

      meta.append(status);

      if (session.duration_seconds) {
        const duration = document.createElement("span");
        duration.textContent = formatStamp(session.duration_seconds);
        meta.append(duration);
      }

      // Hapus sesi. Backend menghapus baris sesi, segmen transkrip, dan
      // berkas rekaman di disk sekaligus.
      const remove = document.createElement("button");
      remove.className = "history-delete";
      remove.type = "button";
      remove.setAttribute("aria-label", "Hapus sesi " + name.textContent);
      remove.title = "Hapus sesi rekaman";
      remove.textContent = "×";
      // Sesi yang sedang direkam tidak boleh dihapus — poll status-nya masih
      // berjalan dan akan gagal setelah barisnya hilang.
      remove.disabled = recording && session.id === currentSessionId;

      remove.addEventListener("click", async () => {
        const label = name.textContent || "Sesi tanpa judul";
        if (!window.confirm('Hapus sesi rekaman "' + label + '"?')) return;

        remove.disabled = true;
        try {
          await deleteJson(
            "/api/lecture/" + encodeURIComponent(session.id) + "/delete/"
          );

          // Sesi yang sedang dibuka ikut terhapus: jangan biarkan id mati
          // tersimpan sebagai pilihan terakhir — reload berikutnya akan
          // mencoba membuka sesi yang sudah tidak ada.
          if (session.id === viewSessionId) {
            viewSessionId = null;
            if (currentSessionId === session.id) currentSessionId = null;
            try {
              sessionStorage.removeItem(LAST_SESSION_KEY);
            } catch {
              /* lihat rememberLastSession */
            }
            setHistoryHint(false);
          }

          await loadSessions();
          showToast("Sesi rekaman dihapus.");
        } catch (error) {
          remove.disabled = false;
          showToast(error.message);
        }
      });

      body.append(name, meta);
      row.append(body, remove);
      historyNode.append(row);
    });
  }

  function statusBadgeClass(status) {
    switch (status) {
      case "completed":
        return "green";
      case "failed":
        return "red";
      case "transcribing":
      case "recording":
        return "blue";
      default:
        return "";
    }
  }

  // =====================================================
  // LIVE (FR-05)
  // =====================================================

  /**
   * Perbarui indikator koneksi live.
   *
   * @param {"idle"|"live"|"offline"|"error"} state
   * @param {string} text
   */
  function setLiveState(state, text) {
    if (!liveIndicator) return;

    liveIndicator.hidden = false;
    liveIndicator.classList.remove("is-live", "is-offline", "is-error");

    if (state === "live") liveIndicator.classList.add("is-live");
    else if (state === "offline") liveIndicator.classList.add("is-offline");
    else if (state === "error") liveIndicator.classList.add("is-error");

    if (liveIndicatorText) liveIndicatorText.textContent = text;
  }

  /** Tampilkan jumlah potongan yang masih tersimpan lokal. */
  function setLiveBuffer(count) {
    if (!liveIndicatorBuffer || !liveBufferCount) return;

    liveBufferCount.textContent = String(count);
    liveIndicatorBuffer.hidden = count <= 0;
  }

  /** Render segmen transkrip parsial. */
  function renderLiveSegments(segments) {
    if (!liveTranscriptSegments) return;

    liveTranscriptSegments.replaceChildren();

    if (!Array.isArray(segments) || segments.length === 0) {
      const empty = document.createElement("p");
      empty.className = "form-note";
      empty.textContent = "Menunggu potongan pertama…";
      liveTranscriptSegments.append(empty);
      return;
    }

    segments.forEach((segment) => {
      const row = document.createElement("div");
      row.className = "live-transcript-line";

      const stamp = document.createElement("span");
      stamp.className = "live-transcript-time";
      stamp.textContent = formatStamp(segment.start);

      const text = document.createElement("p");
      text.className = "live-transcript-text";
      text.textContent = segment.text || "";

      row.append(stamp, text);
      liveTranscriptSegments.append(row);
    });

    // Gulung ke bawah supaya segmen terbaru selalu terlihat.
    liveTranscriptSegments.scrollTop = liveTranscriptSegments.scrollHeight;
  }

  /**
   * Kirim satu potongan ke server, lalu bersihkan dari buffer offline.
   *
   * Dua jalur, satu aturan: potongan baru **dihapus dari buffer hanya
   * setelah server mengonfirmasi** sudah menerimanya. Kalau dihapus
   * begitu saja setelah "dikirim", lalu server ternyata tidak
   * menerimanya, audio itu hilang selamanya.
   *
   * - Jalur WS: kirim bingkai, tunggu frame `ack`.
   * - Jalur HTTP: `POST /chunks/` — respons 200 berarti server sudah
   *   menyimpan potongannya.
   *
   * #### Beralih jalur itu aman
   *
   * Kedua jalur menulis potongan ke **berkas yang sama**: server
   * memakai jalur persis `chunk_{seq:04d}.pcm` (lihat
   * `lecture_chunks.write_chunk`), jadi potongan bernomor sama dari
   * jalur mana pun **menimpa** berkas yang sama — bukan menggandakan
   * audio. Transkripsi akhir tetap utuh: `finalize_lecture_audio_task`
   * menggabungkan seluruh potongan menjadi satu WAV, lalu
   * `transcribe_lecture` menghapus semua segmen lama dan menulis ulang
   * dari audio penuh.
   *
   * Yang terlihat selama transisi hanyalah segmen live partial
   * (`chunk_seq = NULL`) yang masih ada sampai transkripsi final
   * menggantikannya — bukan duplikasi permanen. `startLivePolling()`
   * juga mengganti `liveSegments` secara utuh, jadi UI tidak pernah
   * merender dua kali.
   */
  async function deliverChunk(seq, bytes, rate) {
    if (liveTransport === "ws") {
      if (!socket || !socket.connected) {
        throw new Error("WebSocket belum siap — potongan ditahan.");
      }

      const sent = socket.sendChunk(seq, bytes);

      if (!sent) {
        // Socket mati di tengah jalan — biarkan di buffer offline.
        throw new Error("WebSocket tidak siap.");
      }

      await waitForAck(seq);
      return;
    }

    await postChunk(currentSessionId, seq, rate, bytes);
  }

  /**
   * Kirim satu potongan yang baru direkam.
   *
   * Urutannya penting: **simpan dulu ke IndexedDB, baru kirim**. Kalau
   * tab ditutup di tengah pengiriman, potongannya sudah aman di disk
   * dan bisa dikirim ulang.
   */
  async function sendLiveChunk(seq, pcm, rate) {
    if (!currentSessionId) return;

    const bytes = window.LectureCapture
      ? window.LectureCapture.toBytes(pcm)
      : new Uint8Array(pcm);

    if (offlineStore) {
      await offlineStore.put(currentSessionId, seq, bytes, rate);
    }

    livePending += 1;
    updateLiveBufferCount();

    try {
      await deliverChunk(seq, bytes, rate);

      liveSent += 1;

      if (offlineStore) {
        await offlineStore.remove(currentSessionId, seq);
      }

      setLiveState("live", "Live — transkrip berjalan");
    } catch (error) {
      // Potongan tetap tersimpan di IndexedDB. Antrean offline akan
      // dikirim ulang saat koneksi kembali.
      setLiveState("offline", "Offline — potongan disimpan lokal");
    } finally {
      livePending -= 1;
      updateLiveBufferCount();
    }
  }

  /**
   * Tunggu server meng-ack satu potongan.
   *
   * Timeout-nya longgar (10 detik): kalau server lambat, lebih baik
   * potongannya dianggap "belum pasti" dan diulang daripada hilang.
   */
  function waitForAck(seq, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;

      const check = () => {
        if (socket && socket.lastAckedSeq >= seq) {
          resolve();
          return true;
        }
        return false;
      };

      if (check()) return;

      const timer = setInterval(() => {
        if (check()) {
          clearInterval(timer);
          resolve();
          return;
        }

        if (Date.now() > deadline) {
          clearInterval(timer);
          reject(new Error("Server tidak meng-ack potongan " + seq + "."));
        }
      }, 100);
    });
  }

  async function updateLiveBufferCount() {
    if (!offlineStore || !currentSessionId) return;

    const count = await offlineStore.count(currentSessionId);
    setLiveBuffer(count);
  }

  /**
   * Kirim ulang potongan yang tertinggal.
   *
   * Dipanggil saat event `online`, saat koneksi WS tersambung kembali,
   * dan saat halaman dimuat ulang. Urutan pengiriman mengikuti nomor
   * potongan, jadi server menerimanya berurutan.
   *
   * Potongan yang **sudah ada** di server tidak apa-apa: server
   * meng-ack-nya tanpa menulis ulang, jadi audio tidak terduplikasi.
   */
  async function flushOfflineQueue() {
    if (!offlineStore || !currentSessionId) return;
    if (!navigator.onLine) return;

    const pending = await offlineStore.list(currentSessionId);

    if (pending.length === 0) {
      await updateLiveBufferCount();
      return;
    }

    setLiveState("offline", "Mengirim " + pending.length + " potongan tertunda…");

    let sent = 0;

    for (const row of pending) {
      try {
        await deliverChunk(row.seq, row.bytes, row.rate);
        await offlineStore.remove(currentSessionId, row.seq);
        sent += 1;
      } catch {
        // Masih gagal — sisa antrean dibiarkan untuk dicoba lagi nanti.
        break;
      }
    }

    await updateLiveBufferCount();

    if (sent > 0) {
      setLiveState("live", "Live — transkrip berjalan");
    }
  }

  /**
   * Kembalikan transport ke jalur HTTP dan kirim antrean tertunda.
   *
   * Dipanggil saat live ditolak server di tengah rekaman. Potongan yang
   * sudah tertahan di IndexedDB langsung dikirim lewat HTTP — jadi
   * rekaman tetap utuh meski realtime-nya mati.
   *
   * Idempoten: flush hanya dijalankan kalau transport benar-benar
   * berubah, supaya `error` frame dan `close` event (yang keduanya
   * menandai penolakan) tidak memicu dua flush paralel.
   */
  function fallBackToHttp() {
    const berubah = liveTransport !== "http";
    liveTransport = "http";

    if (berubah) {
      flushOfflineQueue().catch(() => {});
    }
  }

  // =====================================================
  // WEBSOCKET (FR-04, FR-05)
  // =====================================================

  /**
   * Buka koneksi WebSocket ke backend FastAPI.
   *
   * Kalau gagal (tiket tidak terbit, server tidak menerima cross-origin,
   * dsb) rekaman **tidak** gagal: jalur HTTP per potongan tetap dipakai.
   * Jadi user tidak pernah kehilangan rekaman karena masalah jaringan
   * di jalur realtime.
   *
   * #### Transport **hanya** pindah ke WS setelah server mengonfirmasi
   *
   * `connect()` baru resolve setelah frame `status` pertama — yang
   * server kirim setelah tiket divalidasi, sesi ditemukan, dan sesi
   * masih RECORDING. Jadi saat fungsi ini return `true`, jalur WS
   * memang bisa dipakai. Kalau return `false`, `liveTransport` **tetap
   * "http"**: jangan pernah menyetelnya ke "ws" sebelum server
   * mengonfirmasi, karena saat itu potongan akan masuk antrean WS yang
   * tidak pernah terkirim.
   */
  async function connectLiveSocket() {
    if (!window.LectureSocket || !currentSessionId) return false;

    if (socket) {
      socket.close();
      socket = null;
    }

    const instance = new window.LectureSocket.LectureSocket({
      sessionId: currentSessionId,
      wsBase: "",
      onMessage: handleSocketMessage,
      onState: handleSocketState,
    });

    try {
      await instance.connect();
    } catch (error) {
      // Server menolak, atau tidak pernah mengonfirmasi. Kembalikan ke
      // jalur HTTP — rekaman harus tetap berjalan.
      liveRejectionReason = (error && error.message) || "";
      liveTransport = "http";
      setLiveState(
        "offline",
        liveRejectionReason
          ? "Live ditolak: " + liveRejectionReason
          : "Koneksi live gagal — memakai jalur unggah"
      );
      return false;
    }

    liveSocketDone = false;
    liveRejectionReason = "";

    socket = instance;
    liveTransport = "ws";

    // Antrean offline baru dikirim **setelah** transport terpasang.
    //
    // Ini sengaja ada di sini, bukan di `handleSocketState("connected")`:
    // event itu dipanggil dari dalam `connect()`, yaitu **sebelum**
    // `liveTransport = "ws"` dieksekusi. Kalau flush dari sana, antrean
    // bisa terkirim lewat HTTP hanya karena urutan microtask — perilaku
    // yang benar secara kebetulan, salah secara sebab.
    flushOfflineQueue().catch(() => {});

    return true;
  }

  /**
   * Status koneksi socket → indikator di UI.
   *
   * "connected" berarti server sudah **mengonfirmasi** koneksi (frame
   * `status` pertama), bukan sekadar handshake. "rejected" berarti
   * server menolak secara final — lalu transport dikembalikan ke HTTP
   * supaya rekaman tetap mengalir.
   */
  function handleSocketState(state) {
    if (liveStopping) return;

    switch (state) {
      case "connecting":
        setLiveState("offline", "Menyambung ke server…");
        break;
      case "handshake":
        // Handshake HTTP 101 berhasil, tapi server masih memvalidasi
        // tiket. Belum tentu siap — tunggu frame `status`.
        setLiveState("offline", "Memvalidasi tiket…");
        break;
      case "connected":
        setLiveState("live", "Live — transkrip berjalan");
        liveReconnectAttempts = 0;
        // Antrean offline **tidak** di-flush di sini: event ini dipanggil
        // dari dalam `connect()`, sebelum `liveTransport = "ws"` terpasang.
        // Flush dilakukan `connectLiveSocket()` setelah transport siap.
        break;
      case "disconnected":
        setLiveState("offline", "Koneksi terputus — menyambung ulang…");
        scheduleReconnect();
        break;
      case "rejected":
        // Server menolak koneksi secara final (tiket basi, sesi sudah
        // berhenti, sesi tidak ada, origin tak diizinkan). Menyambung
        // ulang tidak akan membantu — dan akan jadi loop tanpa henti.
        //
        // Tapi rekaman **tidak boleh ikut mati**: kembalikan transport
        // ke HTTP supaya potongan tetap terkirim per request.
        fallBackToHttp();
        setLiveState(
          "error",
          liveRejectionReason
            ? "Live ditolak: " + liveRejectionReason
            : "Server menolak koneksi live — memakai jalur unggah"
        );
        break;
      case "error":
        setLiveState("error", "Koneksi bermasalah");
        break;
      default:
        break;
    }
  }

  /**
   * Tulis metadata live (jumlah potongan + detik terekam) ke panel.
   *
   * Keadaan disimpan di variabel modul, bukan langsung ditulis ke DOM,
   * karena frame `status` datang dalam dua bentuk: yang **pertama**
   * (menanda server sudah memvalidasi tiket) membawa `last_seq`,
   * sedangkan frame lanjutan — yang dikirim kalau satu jendela
   * transkripsi tidak menghasilkan teks — **tidak** membawa `last_seq`.
   * Kalau teks langsung ditulis ke DOM, frame lanjutan itu akan
   * mereset jumlah potongan ke nol.
   */
  function applyLiveMeta(chunks, seconds) {
    if (typeof chunks === "number") liveMetaChunks = chunks;
    if (typeof seconds === "number") liveMetaSeconds = seconds;

    if (!liveTranscriptMeta) return;

    liveTranscriptMeta.textContent =
      liveMetaChunks +
      " potongan · " +
      formatStamp(liveMetaSeconds) +
      " terekam";
  }

  /**
   * Pesan dari server.
   *
   * `transcript` dan `summary` diproses **langsung** — inilah yang
   * membuat transkrip muncul selama rekaman berjalan, bukan setelah
   * rekaman berhenti.
   */
  function handleSocketMessage(message) {
    switch (message.type) {
      case "status":
        applyLiveMeta(
          typeof message.last_seq === "number"
            ? message.last_seq + 1
            : undefined,
          message.seconds_received
        );
        break;

      case "ack":
        // Server sudah menyimpan potongannya. Buffer offline membersih
        // dirinya sendiri lewat `sendLiveChunk` yang menunggu ack ini.
        break;

      case "transcript": {
        const segments = Array.isArray(message.segments) ? message.segments : [];
        if (!segments.length) break;

        liveSegments = liveSegments.concat(segments);
        renderLiveSegments(liveSegments);
        break;
      }

      case "summary":
        renderSummary(message.summary);
        break;

      case "done":
        liveSocketDone = true;
        setLiveState("idle", "Rekaman selesai");
        break;

      case "error":
        liveRejectionReason = message.error || "";

        // Penolakan server bersifat final: jangan sambung ulang.
        if (liveReconnectTimer) {
          clearTimeout(liveReconnectTimer);
          liveReconnectTimer = null;
        }

        // Kalau rekaman masih berjalan, kembalikan transport ke HTTP.
        // Server menolak audio live (mis. sesi sudah dihentikan dari
        // tempat lain) — rekaman tidak boleh ikut mati.
        if (recording && !liveStopping) {
          fallBackToHttp();
          setLiveState(
            "offline",
            liveRejectionReason
              ? "Live ditolak: " + liveRejectionReason + " — memakai jalur unggah"
              : "Live ditolak — memakai jalur unggah"
          );
          break;
        }

        setLiveState(
          "error",
          liveRejectionReason || "Server menolak koneksi."
        );
        break;

      default:
        break;
    }
  }

  /**
   * Jadwalkan sambung ulang.
   *
   * Jeda naik (1 dtk, 2 dtk, 4 dtk, … maksimum 15 dtk) supaya server
   * yang sedang sibuk tidak kewalahan percobaan berulang.
   *
   * Transport **tidak** dialihkan ke HTTP saat WS putus: potongannya
   * ditahan di buffer offline sampai WS tersambung lagi. Yang perlu
   * dijaga cuma satu: rekaman tidak boleh kehilangan potongan.
   *
   * Kalau sambung ulang **gagal**, transport dikembalikan ke HTTP
   * supaya rekaman tetap mengalir selama percobaan berikutnya berjalan
   * di latar belakang.
   */
  function scheduleReconnect() {
    if (liveStopping || !recording) return;
    if (liveReconnectTimer) return;

    liveReconnectAttempts += 1;

    const delay = Math.min(1000 * 2 ** (liveReconnectAttempts - 1), 15000);

    liveReconnectTimer = setTimeout(async () => {
      liveReconnectTimer = null;

      if (liveStopping || !recording) return;

      const ok = await connectLiveSocket();

      if (!ok) {
        // Sambung ulang gagal → jalan lewat HTTP sementara. Antrean
        // offline tetap aman; begitu WS tersambung lagi, flush
        // memindahkannya ke jalur WS.
        liveTransport = "http";
        setLiveState("offline", "Menyambung ulang ke server…");
        // Coba lagi — belum menyerah.
        scheduleReconnect();
      }
    }, delay);
  }

  /** Poll transkrip parsial selama rekaman berjalan. */
  function startLivePolling() {
    stopLivePolling();

    const tick = async () => {
      if (!recording || !currentSessionId) return;

      try {
        const data = await getJson(
          "/api/lecture/" + encodeURIComponent(currentSessionId) + "/live/"
        );

        liveSegments = Array.isArray(data.segments) ? data.segments : [];
        renderLiveSegments(liveSegments);

        applyLiveMeta(data.chunks_received || 0, data.seconds_captured || 0);
      } catch {
        // Jaringan putus — polling berikutnya akan mencoba lagi.
        setLiveState("offline", "Koneksi ke server terputus");
      }

      if (recording) {
        liveTimer = setTimeout(tick, LIVE_POLL_MS);
      }
    };

    tick();
  }

  function stopLivePolling() {
    if (liveTimer) {
      clearTimeout(liveTimer);
      liveTimer = null;
    }
  }

  // Koneksi kembali → sambung ulang WebSocket, lalu kirim ulang antrean.
  //
  // Dua hal harus dilakukan di sini, dan **urutannya penting**:
  //
  // 1. WebSocket harus disambung ulang dulu. Event ``online`` hanya
  //    menandai koneksi internet pulih: socket yang diputus jaringan
  //    *biasanya* memicu ``onclose`` -- tapi tidak selalu. Kalau
  //    ``onclose`` tidak dipanggil, tidak ada yang menyambung ulang dan
  //    rekaman diam-diam berhenti terkirim.
  // 2. Baru antrean offline dikirim. Mengirim antrean tanpa socket
  //    akan gagal, dan potongannya kembali tertahan — tidak ada
  //    kemajuan.
  window.addEventListener("online", () => {
    if (liveStopping || !recording) {
      flushOfflineQueue().catch(() => {});
      return;
    }

    if (!socket || !socket.connected) {
      // Socket belum hidup. Sambung ulang; ``onState("connected")``
      // yang akan memicu flush antrean.
      connectLiveSocket().catch(() => {});
      return;
    }

    flushOfflineQueue().catch(() => {});
  });

  // =====================================================
  // SESI
  // =====================================================

  async function startSession() {
    const title = (titleInput?.value || "").trim() || "Sesi Perkuliahan";

    const data = await postJson("/api/lecture/start/", { title });

    if (!data.session_id) {
      throw new Error("Backend tidak mengembalikan id sesi.");
    }

    currentSessionId = data.session_id;

    // Sesi rekaman baru menggantikan tampilan: panel jangan terus
    // menampilkan transkrip sesi lama di bawah timer yang berjalan.
    viewSessionId = currentSessionId;
    rememberLastSession(currentSessionId);
    renderHistory(currentSessions);
    setHistoryHint(false);

    return data;
  }

  async function loadSessions() {
    // Tandai sedang memuat SEBELUM request, lalu render ulang supaya panel
    // tidak lagi menampilkan "Belum ada sesi rekaman." selama menunggu.
    sessionsLoading = true;
    sessionsError = null;
    renderHistory(currentSessions);

    try {
      const data = await getJson("/api/lecture/");
      currentSessions = data.sessions || [];
      sessionsLoaded = true;
    } catch (error) {
      sessionsError = error.message || "tidak diketahui";
      showToast(error.message);
    } finally {
      sessionsLoading = false;
      renderHistory(currentSessions);
    }
  }

  // =====================================================
  // PEMILIHAN & PEMULIHAN SESI
  // =====================================================

  /**
   * Tampilkan sesi di panel: transkrip, segmen, ringkasan.
   *
   * `restoreSeq` menandai pemanggilan terbaru. Fetch tidak bisa dibatalkan,
   * jadi tanpa penanda ini dua pemilihan cepat bisa saling menimpa —
   * respons yang datang belakangan menulis isi sesi yang sudah tidak
   * dipilih lagi.
   */
  async function openSession(sessionId, { persist = true } = {}) {
    if (!sessionId) return;

    const seq = ++restoreSeq;
    viewSessionId = sessionId;
    if (persist) rememberLastSession(sessionId);
    renderHistory(currentSessions);
    setHistoryHint(true);

    try {
      const data = await fetchTranscriptAndSummary(
        sessionId,
        () => seq === restoreSeq,
      );
      if (seq !== restoreSeq) return;

      // `currentSessionId` ikut diset supaya ekspor & ringkasan memakai
      // sesi yang sedang ditampilkan — itulah perilaku sebelum halaman
      // direload, dan tanpa ini tombol ekspor menolak dengan pesan
      // "Rekaman atau unggah berkas dulu".
      if (!recording && !busy) currentSessionId = sessionId;

      if (data.status && data.status !== "completed") {
        showToast('Sesi "' + (data.title || sessionId) + '" masih ' + data.status + ".");
      }
    } catch (error) {
      if (seq !== restoreSeq) return;
      showToast(error.message);
    }
  }

  /** Tampilkan/sembunyikan catatan cara membuka sesi lain. */
  function setHistoryHint(visible) {
    if (!historyHint) return;
    historyHint.hidden = !visible;
  }

  function rememberLastSession(sessionId) {
    try {
      sessionStorage.setItem(LAST_SESSION_KEY, sessionId);
    } catch {
      // sessionStorage bisa diblokir (mode privasi) — bukan alasan gagal.
    }
  }

  function readLastSession() {
    try {
      return sessionStorage.getItem(LAST_SESSION_KEY);
    } catch {
      return null;
    }
  }

  /**
   * Pulihkan tampilan setelah halaman dimuat ulang (ganti menu).
   *
   * Urutannya: sesi yang terakhir dipilih pengguna → sesi terbaru di
   * riwayat → biarkan kosong (belum ada sesi sama sekali).
   *
   * Peringatan: `currentSessionId` di sini **bukan** "sesi rekaman yang
   * sedang berjalan" — kalau ada rekaman berjalan (tab sama, event kasar),
   * sesi itu jangan dibuka ulang di panel.
   */
  async function restoreLastSession() {
    const preferred = readLastSession();
    let preferredId = null;

    if (preferred && currentSessions.some((s) => s.id === preferred)) {
      preferredId = preferred;
    } else {
      if (preferred) {
        // Sesi pilihan terakhir sudah dihapus (mis. lewat tombol ×, atau
        // tab lain) — lupakan, jangan mencoba membukanya lagi.
        try {
          sessionStorage.removeItem(LAST_SESSION_KEY);
        } catch {
          /* lihat rememberLastSession */
        }
      }

      // Cadangan: sesi dengan `created_at` terbaru. Backend mengembalikan
      // daftar tanpa `order_by` (urutan = urutan simpan), jadi baris
      // pertama bukan yang terbaru — jangan menebak lewat indeks.
      const newest = [...currentSessions].sort((a, b) =>
        String(b.created_at || "").localeCompare(String(a.created_at || "")),
      );
      preferredId = newest[0]?.id || null;
    }

    if (!preferredId) return;
    await openSession(preferredId);
  }


  // =====================================================
  // POLLING STATUS
  // =====================================================

  function stopPolling() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  /**
   * Poll status sesi sampai `completed`/`failed`.
   *
   * Upload audio hanya menandai `transcribing`; transkrip baru ada setelah
   * Whisper selesai di background. Karena itu polling (bukan satu request)
   * yang dipakai, dengan jeda supaya backend tidak dibanjiri permintaan.
   */
  async function pollUntilDone(sessionId) {
    pollAttempts = 0;

    return new Promise((resolve, reject) => {
      const tick = async () => {
        pollAttempts++;

        try {
          const data = await getJson("/api/lecture/" + encodeURIComponent(sessionId) + "/status/");
          const status = data.status;

          if (status === "completed") {
            setStatus("Transkrip Selesai");
            resolve(data);
            return;
          }

          if (status === "failed") {
            reject(new Error("Transkripsi gagal di backend."));
            return;
          }

          if (pollAttempts >= POLL_MAX_ATTEMPTS) {
            reject(new Error("Transkripsi belum selesai dalam batas waktu."));
            return;
          }

          pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
        } catch (error) {
          // Jaringan sempat putus: coba lagi, jangan langsung gagal —
          // transkripsi di backend tetap berjalan.
          if (pollAttempts >= POLL_MAX_ATTEMPTS) {
            reject(error);
            return;
          }
          pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
        }
      };

      tick();
    });
  }

  /**
   * Ambil + render transkrip & ringkasan sesi.
   *
   * `isCurrent` (opsional) dipanggil sebelum menulis DOM. Diperlukan
   * karena fetch tidak bisa dibatalkan: kalau pengguna memilih sesi lain
   * di tengah jalan, respons yang datang belakangan tidak boleh menimpa
   * panel — guard di pemanggil saja terlambat, karena fungsi inilah yang
   * menulis.
   */
  async function fetchTranscriptAndSummary(sessionId, isCurrent = null) {
    const base = "/api/lecture/" + encodeURIComponent(sessionId) + "/";
    const stillWanted = () => !isCurrent || isCurrent();

    const transcriptData = await getJson(base + "transcript/");
    if (stillWanted()) {
      renderTranscript(transcriptData.transcript);
      renderSegments(transcriptData.segments);
    }

    let summary = transcriptData.summary;
    if (!summary) {
      try {
        const summaryData = await getJson(base + "summary/");
        summary = summaryData.summary;
      } catch {
        summary = "";
      }
    }
    if (stillWanted()) renderSummary(summary);

    return transcriptData;
  }

  /**
   * Alur lengkap setelah rekaman selesai: stop → upload → polling → transkrip.
   */
  async function finalizeRecording(blob, filename) {
    if (!currentSessionId) {
      showToast("Sesi rekaman belum dimulai.");
      return;
    }

    const sessionId = currentSessionId;

    setBusy(true, "Mengunggah...");
    setStatus("Mengunggah Rekaman");
    if (hintNode) {
      hintNode.textContent = "Mengunggah berkas rekaman ke server...";
    }

    try {
      // Stop dulu: backend menutup sesi. Statusnya jadi `transcribing`,
      // dan transkripsi tetap jalan di background.
      await postJson("/api/lecture/" + encodeURIComponent(sessionId) + "/stop/");

      await postFile(
        "/api/lecture/" + encodeURIComponent(sessionId) + "/audio/",
        blob,
        filename
      );

      setStatus("Memproses transkrip...");
      if (hintNode) {
        hintNode.textContent =
          "Rekaman terunggah. Backend sedang mentranskrip (Whisper di CPU) — biasanya butuh beberapa detik sampai beberapa menit.";
      }

      await pollUntilDone(sessionId);
      await fetchTranscriptAndSummary(sessionId);

      showToast("Transkrip dan ringkasan siap.");
      await loadSessions();
    } catch (error) {
      setStatus("Gagal Diproses");
      if (hintNode) {
        hintNode.textContent = "Terjadi kesalahan: " + error.message;
      }
      showToast(error.message);
      await loadSessions();
    } finally {
      setBusy(false, "");
      stopPolling();
    }
  }

  // =====================================================
  // REKAMAN — live (PCM) dulu, MediaRecorder sebagai fallback
  // =====================================================

  /** Format blob MediaRecorder ke ekstensi yang dikenali backend. */
  function filenameForMimeType(mimeType) {
    const type = (mimeType || "").toLowerCase();

    if (type.includes("webm")) return "rekaman.webm";
    if (type.includes("ogg")) return "rekaman.ogg";
    if (type.includes("mp4")) return "rekaman.m4a";
    if (type.includes("mpeg")) return "rekaman.mp3";
    if (type.includes("wav")) return "rekaman.wav";

    return "rekaman.webm";
  }

  function stopStream() {
    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop());
      mediaStream = null;
    }
  }

  /** Pesan untuk setiap kondisi mikrofon gagal. */
  function microphoneFailure(error) {
    return error && error.name === "NotAllowedError"
      ? "Izin mikrofon ditolak. Aktifkan akses mikrofon di pengaturan browser, atau unggah berkas rekaman yang sudah ada."
      : "Mikrofon tidak tersedia atau sedang dipakai aplikasi lain. Unggah berkas rekaman yang sudah ada sebagai gantinya.";
  }

  /** Tampilkan panel unggah berkas (fallback). */
  function showUploadFallback() {
    const fallback = document.getElementById("uploadFallback");
    if (fallback) fallback.classList.add("upload-fallback-visible");
  }

  /**
   * Jalur live: rekam sebagai PCM, kirim per potongan, transkrip tampil
   * selama rekaman.
   */
  async function startLiveRecording() {
    setBusy(true, "Menyiapkan live...");
    setStatus("Menyiapkan Live");

    try {
      capture = await window.LectureCapture.create({ chunkSeconds: 4 });
    } catch (error) {
      setBusy(false, "");
      setStatus("Izin Mikrofon Ditolak");

      const message = microphoneFailure(error);
      if (hintNode) hintNode.textContent = message;
      showToast(message);
      showUploadFallback();
      return false;
    }

    if (capture.mode === "mediatracer") {
      // AudioWorklet tidak tersedia — pakai jalur MediaRecorder yang
      // sudah ada. Tidak ada regresi: rekaman tetap bisa diselesaikan.
      capture = null;
      return false;
    }

    try {
      await startSession();
    } catch (error) {
      setStatus("Gagal Memulai Sesi");
      if (hintNode) hintNode.textContent = "Gagal memulai sesi: " + error.message;
      showToast(error.message);
      try {
        await capture.stop();
      } catch {
        // Lepas mikrofon sudah cukup.
      }
      capture = null;
      return false;
    }

    if (!offlineStore) {
      offlineStore = await window.LectureOffline.OfflineChunkStore.open();
    }

    liveSeq = 0;
    liveSent = 0;
    livePending = 0;
    liveMode = "pcm";
    liveTransport = "http";
    liveStopping = false;
    liveReconnectAttempts = 0;
    liveRejectionReason = "";
    liveMetaChunks = 0;
    liveMetaSeconds = 0;

    // ---- Sambung ke server (FR-04) --------------------------------
    //
    // WebSocket adalah jalur utama: transkrip masuk **selama** rekaman
    // berjalan. Kalau sambung gagal, rekaman tetap jalan lewat jalur
    // HTTP per potongan — jadi user tidak kehilangan apa pun.
    //
    // `connectLiveSocket()` yang memutuskan transport: ia hanya
    // menyetel `liveTransport = "ws"` setelah server **mengonfirmasi**
    // koneksi lewat frame `status`. Jadi di bawah ini cukup membaca
    // hasilnya — jangan menebak.
    setLiveState("offline", "Menyambung ke server…");
    const wsReady = await connectLiveSocket();

    if (!wsReady) {
      setLiveState("offline", "Koneksi live gagal — memakai jalur unggah");
    }

    capture.on("chunk", ({ seq, pcm, rate }) => {
      // Kirim tanpa await supaya pencuplikan audio tidak terblokir
      // selama jaringan lambat.
      sendLiveChunk(seq, pcm, rate).catch(() => {});
    });

    capture.start();

    recording = true;
    elapsed = 0;
    renderTime();
    startTimer();

    if (liveTranscript) liveTranscript.hidden = false;
    renderLiveSegments([]);
    liveSegments = [];

    setLiveState(
      liveTransport === "ws" ? "live" : "offline",
      liveTransport === "ws"
        ? "Live — menunggu potongan pertama"
        : "Koneksi live gagal — memakai jalur unggah"
    );
    setLiveBuffer(0);
    startLivePolling();

    // Antrean offline dari sesi sebelumnya (mis. tab yang ditutup
    // saat offline) dikirim ulang sekarang.
    flushOfflineQueue().catch(() => {});

    setBusy(false, "");
    setStatus("Merekam (Live)");
    setRecordLabel("Hentikan Rekaman");
    if (hintNode) {
      hintNode.textContent =
        "Sedang merekam. Transkrip muncul di panel “Transkrip langsung” saat rekaman berjalan.";
    }

    return true;
  }

  /** Jalur fallback: rekam utuh dengan MediaRecorder, unggah di akhir. */
  async function startMediaRecorderRecording() {
    setBusy(true, "Meminta izin mikrofon...");
    setStatus("Meminta Izin Mikrofon");

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      setBusy(false, "");
      setStatus("Izin Mikrofon Ditolak");

      const message = microphoneFailure(error);
      if (hintNode) hintNode.textContent = message;
      showToast(message);
      showUploadFallback();
      return;
    }

    setBusy(false, "");

    mediaStream = stream;
    chunks = [];

    const mimeType = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/mp4",
    ].find((candidate) => MediaRecorder.isTypeSupported?.(candidate));

    try {
      mediaRecorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined
      );
    } catch {
      // Beberapa browser menolak tipe tertentu; pakai default.
      mediaRecorder = new MediaRecorder(stream);
    }

    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data);
      }
    };

    mediaRecorder.onstop = () => {
      const blob = new Blob(chunks, {
        type: mediaRecorder.mimeType || "audio/webm",
      });
      const filename = filenameForMimeType(mediaRecorder.mimeType);

      chunks = [];
      stopStream();

      finalizeRecording(blob, filename);
    };

    try {
      await startSession();
    } catch (error) {
      setStatus("Gagal Memulai Sesi");
      if (hintNode) hintNode.textContent = "Gagal memulai sesi: " + error.message;
      showToast(error.message);
      stopStream();
      mediaRecorder = null;
      return;
    }

    mediaRecorder.start(1000);

    recording = true;
    elapsed = 0;
    renderTime();
    startTimer();

    liveMode = "mediatracer";
    setLiveState("live", "Merekam — transkrip setelah selesai");

    setStatus("Merekam");
    setRecordLabel("Hentikan Rekaman");
    if (hintNode) {
      hintNode.textContent = "Sedang merekam. Klik Hentikan Rekaman untuk mengakhiri.";
    }
  }

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia) {
      showToast(
        "Browser ini tidak mendukung perekaman mikrofon. Gunakan unggah berkas rekaman di bawah."
      );
      return;
    }

    // Coba live dulu; kalau tidak bisa, jatuh ke MediaRecorder.
    const started = await startLiveRecording();

    if (started) return;

    await startMediaRecorderRecording();
  }

  /**
   * Hentikan rekaman.
   *
   * Jalur live: server menggabungkan semua potongan menjadi satu WAV dan
   * menjalankan transkripsi utuh. Jalur MediaRecorder: blob diunggah lalu
   * ditranskrip.
   */
  async function stopRecording() {
    if (!recording) return;

    setStatus("Menghentikan...");
    setRecordLabel("Mulai Rekaman");
    recording = false;
    stopTimer();
    stopLivePolling();

    if (liveMode === "pcm" && capture) {
      await finalizeLiveRecording();
      return;
    }

    if (!mediaRecorder || mediaRecorder.state === "inactive") {
      return;
    }

    // onstop akan membersihkan stream dan memulai alur upload.
    mediaRecorder.stop();
  }

  /**
   * Akhiri jalur live.
   *
   * Ada satu jeda penting: potongan terakhir mungkin masih dalam antrean
   * kirim. Menunggu antrean kosong memastikan server benar-benar punya
   * semua potongan sebelum digabung — kalau tidak, rekaman terakhir beberapa
   * detik akan hilang.
   */
  async function finalizeLiveRecording() {
    const sessionId = currentSessionId;

    setBusy(true, "Mengirim potongan terakhir...");
    liveStopping = true;

    try {
      await capture.stop();
    } catch {
      // Mikrofon sudah lepas — tidak apa-apa.
    }
    capture = null;

    // Tunggu antrean upload yang sedang berjalan selesai.
    const deadline = Date.now() + 15000;

    while (livePending > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // Potongan yang gagal terkirim dicoba sekali lagi.
    if (navigator.onLine) {
      await flushOfflineQueue().catch(() => {});
    }

    setBusy(true, "Menggabungkan rekaman...");
    setStatus("Memproses Transkrip");

    if (hintNode) {
      hintNode.textContent =
        "Menggabungkan potongan menjadi satu rekaman, lalu mentranskrip utuh (Whisper di CPU)...";
    }

    try {
      // Jalur WebSocket: server tahu kapan semua potongan sudah ia punya
      // dan langsung memulai penggabungan. "stop" lewat WebSocket
      // menggantikan POST /stop/ supaya tidak ada dua jalur yang
      // menggabungkan potongan yang sama.
      if (liveTransport === "ws" && socket && socket.connected) {
        socket.sendCommand({ type: "stop" });
        await waitForSocketDone(8000);
        socket.close();
        socket = null;
      } else {
        await postJson("/api/lecture/" + encodeURIComponent(sessionId) + "/stop/");
      }

      setStatus("Memproses transkrip...");
      await pollUntilDone(sessionId);
      await fetchTranscriptAndSummary(sessionId);

      showToast("Transkrip dan ringkasan siap.");
      await loadSessions();
    } catch (error) {
      setStatus("Gagal Diproses");
      if (hintNode) hintNode.textContent = "Terjadi kesalahan: " + error.message;
      showToast(error.message);
      await loadSessions();
    } finally {
      setBusy(false, "");
      stopPolling();
      setLiveState("idle", "Rekaman selesai");

      if (liveReconnectTimer) {
        clearTimeout(liveReconnectTimer);
        liveReconnectTimer = null;
      }
    }
  }

  /**
   * Tunggu frame ``done`` dari server.
   *
   * Timeout-nya ada supaya halaman tidak menggantung kalau server
   * menutup koneksi tanpa membalas.
   */
  function waitForSocketDone(timeoutMs) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;

      const check = () => {
        if (liveSocketDone) {
          resolve();
          return true;
        }
        return false;
      };

      if (check()) return;

      const timer = setInterval(() => {
        if (check()) {
          clearInterval(timer);
          resolve();
          return;
        }

        if (Date.now() > deadline) {
          clearInterval(timer);
          reject(new Error("Server tidak menutup sesi."));
        }
      }, 100);
    });
  }

  // =====================================================
  // EVENT
  // =====================================================

  if (recordButton) {
    recordButton.addEventListener("click", () => {
      if (busy) return;

      if (recording) {
        stopRecording();
      } else {
        startRecording();
      }
    });
  }

  if (fileInput) {
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file || busy) return;

      setBusy(true, "Mengunggah...");
      setStatus("Mengunggah Rekaman");
      if (hintNode) {
        hintNode.textContent = "Mengunggah " + file.name + " ke server...";
      }

      try {
        if (!currentSessionId) {
          await startSession();
        }

        await postJson(
          "/api/lecture/" + encodeURIComponent(currentSessionId) + "/stop/"
        );

        await postFile(
          "/api/lecture/" + encodeURIComponent(currentSessionId) + "/audio/",
          file,
          file.name
        );

        setStatus("Memproses transkrip...");
        if (hintNode) {
          hintNode.textContent =
            "Berkas terunggah. Backend sedang mentranskrip (Whisper di CPU) — biasanya butuh beberapa detik sampai beberapa menit.";
        }

        await pollUntilDone(currentSessionId);
        await fetchTranscriptAndSummary(currentSessionId);

        showToast("Transkrip dan ringkasan siap.");
        await loadSessions();
      } catch (error) {
        setStatus("Gagal Diproses");
        if (hintNode) hintNode.textContent = "Terjadi kesalahan: " + error.message;
        showToast(error.message);
        await loadSessions();
      } finally {
        setBusy(false, "");
        stopPolling();
        // Kosongkan input supaya berkas sama bisa diunggah ulang.
        fileInput.value = "";
      }
    });
  }

  if (summarizeButton) {
    summarizeButton.addEventListener("click", async () => {
      const box = summaryBox;
      if (!box || busy) return;

      const sessionId = currentSessionId;

      if (!sessionId) {
        showToast("Rekam atau unggah berkas dulu untuk membuat ringkasan.");
        return;
      }

      setBusy(true, "Mengambil ringkasan...");

      try {
        const data = await getJson(
          "/api/lecture/" + encodeURIComponent(sessionId) + "/summary/"
        );
        renderSummary(data.summary);
        showToast("Ringkasan dimuat dari backend.");
      } catch (error) {
        showToast(error.message);
      } finally {
        setBusy(false, "");
      }
    });
  }

  // Ekspor transkrip + ringkasan ke dokumen (FR-05).
  // Hasil ekspor disimpan di sessionStorage, lalu Document Creator mengambil
  // dan mengisinya ke form — jadi pengguna tidak perlu menyalin manual.
  const exportButton = document.getElementById("exportButton");
  const exportLabel = document.getElementById("exportLabel");

  if (exportButton) {
    exportButton.addEventListener("click", async () => {
      if (busy) return;

      const sessionId = currentSessionId;

      if (!sessionId) {
        showToast("Rekam atau unggah berkas dulu untuk mengekspor.");
        return;
      }

      setBusy(true, "Mengekspor...");

      try {
        const data = await getJson(
          "/api/lecture/" + encodeURIComponent(sessionId) + "/export/"
        );

        const transcript = (data.transcript || "").trim();
        const summary = (data.summary || "").trim();

        if (!transcript && !summary) {
          showToast("Sesi ini belum punya transkrip atau ringkasan.");
          return;
        }

        // Siapkan isi dokumen untuk Document Creator.
        const sections = [];
        if (summary) sections.push("RINGKASAN\n\n" + summary);
        if (transcript) sections.push("TRANSKRIP\n\n" + transcript);

        sessionStorage.setItem(
          "akademia.documentDraft",
          JSON.stringify({
            title: "Transkrip Kuliah",
            description: sections.join("\n\n"),
            type: "Ringkasan materi",
          }),
        );

        if (exportLabel) exportLabel.textContent = "Mengekspor...";
        window.location.href = "/document-creator/";
      } catch (error) {
        showToast(error.message);
      } finally {
        setBusy(false, "");
      }
    });
  }

  // Ekspor ke berkas .docx sungguhan (FR-05, FR-17).
  //
  // Berbeda dari tombol "Ekspor ke Dokumen" — yang hasilnya Form
  // Document Creator, yang ini membuat file .docx di server lalu
  // mengunduhnya langsung. Dokumennya juga nempel ke mata kuliah sesi
  // rekaman, jadi bisa dicari lewat RAG seperti dokumen lain.
  const exportDocxButton = document.getElementById("exportDocxButton");
  const exportDocxLabel = document.getElementById("exportDocxLabel");

  if (exportDocxButton) {
    exportDocxButton.addEventListener("click", async () => {
      if (busy) return;

      const sessionId = currentSessionId;

      if (!sessionId) {
        showToast("Rekam atau unggah berkas dulu untuk mengekspor.");
        return;
      }

      setBusy(true, "Mengekspor...");

      if (exportDocxLabel) exportDocxLabel.textContent = "Mengekspor...";

      try {
        const data = await postJson(
          "/api/lecture/" + encodeURIComponent(sessionId) + "/export/doc/"
        );

        const document = data.document || {};

        if (!document.id) {
          throw new Error("Backend tidak mengembalikan dokumen.");
        }

        // Unduh lewat route Django yang sudah ada — file .docx asli,
        // bukan payload JSON.
        window.location.href =
          "/api/document/download/" + encodeURIComponent(document.id);

        showToast("Dokumen .docx berhasil dibuat.");
      } catch (error) {
        showToast(error.message);
      } finally {
        setBusy(false, "");

        if (exportDocxLabel) exportDocxLabel.textContent = "Ekspor .docx";
      }
    });
  }

  // Halaman ditutup saat rekaman berjalan: lepaskan mikrofon.
  window.addEventListener("beforeunload", () => {
    liveStopping = true;
    stopTimer();
    stopPolling();
    stopLivePolling();
    stopStream();
    socket?.close?.();
    capture?.stop?.();
  });

  // Muat riwayat sesi saat halaman dibuka, lalu pulihkan sesi yang sedang
  // ditampilkan sebelum pindah halaman (navigasi = reload penuh).
  loadSessions().then(restoreLastSession);

  // Buka buffer offline lebih awal, supaya ada saat rekaman dimulai.
  // Potongan yang tertinggal dari tab sebelumnya ikut dikirim ulang.
  window.LectureOffline?.OfflineChunkStore.open().then(async (store) => {
    offlineStore = store;

    if (!store.available) return;

    const sessions = await store.sessions();

    if (sessions.length > 0) {
      setLiveState("offline", "Ada " + sessions.length + " sesi dengan potongan tersimpan");
    }
  });
});
