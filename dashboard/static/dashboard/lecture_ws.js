/**
 * Transport WebSocket untuk rekaman live (FR-04, FR-05).
 *
 * Modul ini bicara ke server FastAPI **secara langsung** lewat WebSocket
 * — bukan lewat Django. Alasannya: Django di repo ini WSGI-only (tidak
 * bisa melayani WebSocket), dan menambah ASGI berarti mengubah cara
 * seluruh 6 halaman lain dijalankan.
 *
 * Yang membuatnya aman: browser memegang **tiket** berumur pendek
 * (default 60 detik), bukan kredensial service. Tiket itu JWT bertipe
 * `ws_ticket` — tipe yang ditolak `get_current_user` di backend, jadi
 * tiket tidak bisa dipakai memanggil endpoint REST mana pun.
 *
 * Protocol
 * --------
 * Binary frame (browser → server): potongan PCM mentah, dibungkus bingkai
 *
 *     b"LLC1" (4 byte) | seq (uint32 BE) | len (uint32 BE) | PCM
 *
 * `seq` adalah nomor urut potongan. Tanpa nomor urut, server tidak bisa
 * membedakan "potongan baru" dari "kiriman ulang" — dan dua potongan
 * hening yang identik akan dianggap duplikat.
 *
 * Text frame (server → browser): JSON dengan `type`:
 *
 *   - `status`    — koneksi **siap dipakai**; `last_seq` memberi tahu
 *                   nomor potongan terakhir yang berurutan di server.
 *                   Server hanya mengirim frame ini **setelah** tiket
 *                   divalidasi, sesi ditemukan, dan sesi masih
 *                   berstatus RECORDING — jadi frame inilah penanda
 *                   otoritatif bahwa koneksi benar-benar bisa dipakai,
 *                   bukan sekadar handshake yang berhasil.
 *   - `ack`       — potongan `seq` sudah tersimpan di server. **Hanya
 *                   setelah ini** browser boleh menghapus potongan dari
 *                   buffer offline.
 *   - `transcript` — segmen transkrip baru.
 *   - `summary`   — ringkasan parsial.
 *   - `done`      — rekaman selesai.
 *   - `error`     — koneksi ditolak.
 *
 * Antrean yang tersisa tidak dikelola di sini: `lecture_offline.js`
 * (IndexedDB) yang menjadi antrean. Modul ini cuma transport —
 * "potongan ini tersimpan di server" adalah urusan server yang
 * dijawab lewat frame `ack`.
 */
(function (global) {
  "use strict";

  const CHUNK_MAGIC = "LLC1";
  const HEADER_SIZE = 12;

  /**
   * Bungkus potongan PCM jadi bingkai bernomor urut.
   *
   * Fungsi murni — bisa dipakai di test tanpa browser.
   */
  function encodeChunk(seq, pcm) {
    let bytes;

    if (pcm instanceof Uint8Array) {
      bytes = pcm;
    } else if (pcm instanceof ArrayBuffer) {
      bytes = new Uint8Array(pcm);
    } else {
      bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    }

    const frame = new Uint8Array(HEADER_SIZE + bytes.length);
    const view = new DataView(frame.buffer);

    frame[0] = 0x4c; // "L"
    frame[1] = 0x4c; // "L"
    frame[2] = 0x43; // "C"
    frame[3] = 0x31; // "1"

    view.setUint32(4, seq, false);
    view.setUint32(8, bytes.length, false);

    frame.set(bytes, HEADER_SIZE);

    return frame;
  }

  /** Socket WebSocket yang tahu cara menyambung ulang. */
  class LectureSocket {
    /**
     * @param {object} options
     * @param {string} options.wsBase     — "ws://host:port" tanpa path.
     * @param {string} options.sessionId
     * @param {function} options.onMessage — dipanggil untuk tiap JSON server.
     * @param {function} options.onState   — dipanggil saat status koneksi berubah.
     */
    constructor(options) {
      this.wsBase = options.wsBase || "";
      this.sessionId = options.sessionId;
      this.onMessage = options.onMessage || (() => {});
      this.onState = options.onState || (() => {});

      /**
       * Batas waktu (ms) menunggu frame `status` yang menandai server
       * sudah memvalidasi tiket.
       *
       * Tanpa pengaman ini, server yang menerima koneksi lalu diam
       * (hang, worker-nya macet) akan menggantung `connect()` selamanya
       * — dan karena `await connectLiveSocket()` ada di tengah
       * `startLiveRecording()`, rekaman **tidak pernah mulai**.
       */
      this.readyTimeoutMs = options.readyTimeoutMs || 15000;

      this.socket = null;
      this.ticket = null;
      this.connected = false;
      this.closedByUser = false;

      /**
       * True kalau server menolak koneksi (frame `error`).
       *
       * Penolakan itu **final** — bukan gangguan sesaat. Jadi saat socket
       * subsequently tertutup, event-nya bukan "terputus lalu sambung
       * ulang", tapi "ditolak". Tanpa penanda ini, `onclose` akan memicu
       * sambung ulang tanpa henti ke server yang memang tidak mau menerima.
       */
      this.serverRejected = false;

      /**
       * Alasan penolakan yang dikirim server (isi field `error`).
       *
       * Disimpan supaya UI bisa menampilkan alasan yang **spesifik**
       * ("Tiket kedaluwarsa") alih-alih pesan umum yang tidak membantu
       * operator diagnosa.
       */
      this.serverRejectionReason = "";

      /** Nomor potongan terakhir yang disahkan server. */
      this.lastAckedSeq = -1;
    }

    // -------------------------------------------------------------- tiket
    /**
     * Minta tiket WS ke BFF Django.
     *
     * Tiket berumur pendek, jadi tiket baru diminta setiap kali
     * sambung ulang — bukan disimpan selamanya.
     */
    async fetchTicket() {
      const response = await fetch("/api/lecture/ticket/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRFToken": readCsrfToken(),
        },
        body: "{}",
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok || data.ok === false || !data.ticket) {
        throw new Error(data.error || "Gagal meminta tiket WebSocket.");
      }

      if (data.ws_base) this.wsBase = data.ws_base;

      return data;
    }

    // ---------------------------------------------------------- koneksi
    /**
     * Sambungkan ke server.
     *
     * Tiket diambil **baru setiap sambungan**. Tiket berumur pendek
     * (default 60 detik), jadi tiket lama bisa saja sudah kedaluwarsa
     * saat koneksi berikutnya dibuat — dan server akan menolaknya.
     * Ambil ulang tiket menambah satu request, tapi menghindari sambung
     * gagal karena tiket basi.
     *
     * #### Promise resolve-nya **tidak** berlaku pada `onopen`
     *
     * Server melakukan `accept()` **lebih dulu**, baru memvalidasi
     * tiket dan sesi (lihat ``lectures.py``: ``await
     * websocket.accept()`` mendahului cek tiket/sesi). Jadi handshake
     * yang sukses **tidak** berarti koneksi bisa dipakai — penolakan
     * datang belakangan sebagai frame ``{"type": "error"}`` +
     * ``close(1008)``.
     *
     * Kalau promise di-resolve pada `onopen`, pemanggil mengira
     * "live siap" lalu mengatur transport ke WS, padahal server sudah
     * menolak. Akibatnya setiap potongan audio tertahan di IndexedDB
     * tanpa pernah terkirim — rekaman hilang.
     *
     * Karena itu penanda otoritatifnya adalah frame ``{"type":
     * "status"}``, yang server kirim **hanya setelah** tiket valid,
     * sesi ditemukan, dan sesi masih berstatus RECORDING. Frame
     * ``status`` kedua (yang dikirim kalau satu jendela transkripsi
     * kosong) tidak dihitung — hanya status **pertama** yang berarti
     * "siap".
     */
    async connect() {
      this.closedByUser = false;
      this.serverRejected = false;
      this.serverRejectionReason = "";

      const data = await this.fetchTicket();
      this.ticket = data.ticket;

      const url =
        this.wsBase.replace(/^http/, "ws") +
        "/api/v1/lecture/" +
        encodeURIComponent(this.sessionId) +
        "/stream?ticket=" +
        encodeURIComponent(this.ticket);

      this.onState("connecting");

      return new Promise((resolve, reject) => {
        let socket;

        try {
          socket = new WebSocket(url);
        } catch (error) {
          reject(error);
          return;
        }

        socket.binaryType = "arraybuffer";
        this.socket = socket;

        // Promise harus **selalu** settle.
        //
        // WebSocket bisa ditutup **sebelum** `onopen` pernah dipanggil:
        // server restart, port mati, handshake ditolak. Tanpa penjaga di
        // sini, `onclose` berjalan tapi promise-nya menggantung selamanya
        // — pemanggilnya (`await connectLiveSocket()`) tidak pernah
        // lanjut, jadi sambung ulang berikutnya tidak pernah dijadwalkan
        // dan rekaman diam-diam berhenti mengalir.
        //
        // `settled` memastikan hanya yang pertama yang menang: `onopen`
        // setelah `onclose` (atau sebaliknya) tidak boleh memanggil
        // resolve/reject dua kali.
        let settled = false;

        // Guard waktu: server yang menerima koneksi lalu diam akan
        // menggantung promise selamanya. Batas ini memastikan rekaman
        // tetap punya jalan (jalur HTTP).
        let readyTimer = null;

        const clearReadyTimer = () => {
          if (readyTimer) {
            clearTimeout(readyTimer);
            readyTimer = null;
          }
        };

        const settleOk = () => {
          if (settled) return;
          settled = true;
          clearReadyTimer();
          this.connected = true;
          this.onState("connected");
          resolve();
        };

        const settleFail = (reason) => {
          if (settled) return;
          settled = true;
          clearReadyTimer();
          this.connected = false;
          reject(
            reason instanceof Error
              ? reason
              : new Error("Koneksi WebSocket gagal: " + String(reason))
          );
        };

        socket.onopen = () => {
          // Handshake berhasil — **belum** berarti koneksi siap dipakai.
          // Server masih bisa menolak sebentar lagi lewat frame
          // ``error``. Jangan resolve di sini; tunggu frame ``status``.
          this.onState("handshake");
        };

        socket.onmessage = (event) => {
          if (typeof event.data !== "string") return;

          let payload;
          try {
            payload = JSON.parse(event.data);
          } catch {
            return;
          }

          if (payload.type === "ack" && typeof payload.seq === "number") {
            this.lastAckedSeq = Math.max(this.lastAckedSeq, payload.seq);
          }

          if (payload.type === "error") {
            // Penolakan server bersifat final — tandai supaya `onclose`
            // tidak memicu sambung ulang tanpa henti.
            this.serverRejected = true;
            this.serverRejectionReason = payload.error || "";

            // Alasan server dipakai sebagai pesan error, supaya operator
            // bisa tahu itu tiket basi, sesi sudah berhenti, atau origin
            // ditolak — bukan sekadar "gagal".
            settleFail(
              new Error(
                this.serverRejectionReason ||
                  "Server menolak koneksi live."
              )
            );
          }

          if (payload.type === "status" && !settled) {
            // Frame `status` **pertama** = server sudah memvalidasi
            // tiket dan sesi. Koneksi sekarang benar-benar bisa dipakai.
            settleOk();
          }

          this.onMessage(payload);
        };

        socket.onerror = () => {
          this.onState("error");
        };

        socket.onclose = (event) => {
          this.connected = false;
          this.socket = null;

          if (this.closedByUser) {
            this.onState("closed");
            settleFail(new Error("Koneksi WebSocket ditutup."));
            return;
          }

          if (this.serverRejected) {
            this.onState("rejected");
            settleFail(
              new Error(
                this.serverRejectionReason || "Server menolak koneksi live."
              )
            );
            return;
          }

          this.onState("disconnected");

          // Ditutup sebelum sempat terbuka → sambung gagal. Promise
          // harus tetap settle, kalau tidak pemanggilnya menggantung.
          if (!settled) {
            settleFail(
              new Error(
                "Koneksi WebSocket terputus sebelum terbuka" +
                  (event && event.code ? " (kode " + event.code + ")" : "")
              )
            );
          }
        };

        // Server tidak pernah menjawab (hang, worker mati, proxy
        // menelan frame). Tanpa batas ini promise menggantung selamanya
        // dan `startLiveRecording()` berhenti di tengah jalan.
        readyTimer = setTimeout(() => {
          settleFail(
            new Error(
              "Server tidak mengonfirmasi koneksi dalam " +
                Math.round(this.readyTimeoutMs / 1000) +
                " detik."
            )
          );
        }, this.readyTimeoutMs);
      });
    }

    // -------------------------------------------------------------- kirim
    /**
     * Kirim satu potongan.
     *
     * Mengembalikan ``true`` kalau frame benar-benar dikirim. Kalau
     * socket tidak siap, potongan **tidak** hilang: pemanggil sudah
     * menyimpannya di IndexedDB, jadi cukup mencoba lagi nanti.
     */
    sendChunk(seq, pcm) {
      if (!this.connected || !this.socket) return false;

      try {
        this.socket.send(encodeChunk(seq, pcm));
        return true;
      } catch {
        return false;
      }
    }

    /** Kirim perintah JSON (mis. "stop"). */
    sendCommand(payload) {
      if (!this.connected || !this.socket) return false;

      try {
        this.socket.send(JSON.stringify(payload));
        return true;
      } catch {
        return false;
      }
    }

    /** Tutup koneksi (dipanggil saat rekaman berhenti). */
    close() {
      this.closedByUser = true;

      if (this.socket) {
        try {
          this.socket.close();
        } catch {
          // Socket yang sudah tertutup tidak apa-apa.
        }
      }

      this.socket = null;
      this.connected = false;
    }
  }

  /** Baca token CSRF dari form tersembunyi di halaman. */
  function readCsrfToken() {
    const form = document.getElementById("lectureForm");
    const input = form && form.querySelector("input[name='csrfmiddlewaretoken']");
    return (input && input.value) || "";
  }

  global.LectureSocket = {
    LectureSocket,
    encodeChunk,
    CHUNK_MAGIC,
    HEADER_SIZE,
  };
})(window);
