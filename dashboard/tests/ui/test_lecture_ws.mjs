/**
 * Test logika transport WebSocket (`lecture_ws.js`) — menjalankan kode
 * sungguhan di Node dengan WebSocket palsu yang bisa dikontrol.
 *
 * **Bug yang dikunci di sini.**
 *
 * 1. `connect()` yang hanya di-*resolve* di `onopen`. Backend melakukan
 *    `await websocket.accept()` **lebih dulu**, baru memvalidasi tiket
 *    (lihat `lectures.py`). Jadi handshake yang sukses **tidak** berarti
 *    koneksi bisa dipakai: penolakan datang belakangan sebagai frame
 *    `{"type":"error"}` lalu `close(1008)`.
 *
 *    Dampaknya nyata: pemanggilnya `await connectLiveSocket()` — kalau
 *    promise-nya resolve di `onopen`, UI menyebut "live siap", memutar
 *    transport ke WS, padahal server sudah menolak. Setiap potongan audio
 *    lalu tertahan di IndexedDB tanpa pernah terkirim — rekaman hilang.
 *
 * 2. Promise yang menggantung selamanya saat socket ditutup **sebelum**
 *    `onopen` pernah dipanggil — server restart, port mati, handshake
 *    ditolak. Tanpa penjaga, `onclose` berjalan tapi promise-nya tidak
 *    pernah settle, jadi `scheduleReconnect()` tidak pernah dijalankan
 *    lagi. Gejalanya terlihat seperti "reconnect-nya pelan" padahal mati
 *    total.
 *
 * **Model penolakan di sini mengikuti backend sungguhan**, dibuktikan
 * dengan probe ASGI + Chromium:
 *
 *     accept()  →  frame {"type":"error", ...}  →  close(1008)
 *
 * Bukan "tutup sebelum terbuka" — itu skenario yang berbeda (jaringan
 * mati), dan sudah punya testnya sendiri.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SRC = path.join(ROOT, "dashboard/static/dashboard/lecture_ws.js");

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log("  PASS  " + name);
  } else {
    fail++;
    failures.push(name + " " + extra);
    console.log("  FAIL  " + name + " " + extra);
  }
}

/**
 * Muat modul `lecture_ws.js` ke dalam sandbox, dengan WebSocket palsu.
 *
 * `aksi` menentukan perilaku socket:
 *
 *   - `"siap"`  — handshake, **lalu** server mengirim frame `status`
 *                 (tiket valid, sesi ketemu, sesi RECORDING). Ini alur
 *                 sukses yang sebenarnya.
 *   - `"open"`  — handshake saja, server belum bicara apa-apa. Promise
 *                 **harus masih menggantung** sampai frame `status` datang.
 *   - `"tolak"` — accept() → frame `{"type":"error"}` → close(1008).
 *                 Urutan persis seperti backend sungguhan.
 *   - `"close"` — ditutup sebelum sempat terbuka (jaringan mati).
 *   - `"error"` — error lalu ditutup.
 */
function loadModule({ aksi = "siap", kodeTutup = 1006 } = {}) {
  const dibuat = [];

  class WebSocketPalsu {
    constructor(url) {
      this.url = url;
      this.binaryType = "";
      this.sent = [];
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      dibuat.push(this);

      setTimeout(() => {
        if (aksi === "siap") {
          if (this.onopen) this.onopen({});
          this.kirim({
            type: "status",
            status: "recording",
            session_id: "sesi-1",
            seconds_received: 0,
            bytes_received: 0,
            last_seq: -1,
          });
        } else if (aksi === "open") {
          // Handshake berhasil, tapi server belum mengonfirmasi apa pun.
          if (this.onopen) this.onopen({});
        } else if (aksi === "tolak") {
          // Urutan backend sungguhan: accept → frame error → close(1008).
          if (this.onopen) this.onopen({});
          this.kirim({
            type: "error",
            error: "Tiket tidak valid atau kedaluwarsa.",
          });
          if (this.onclose) {
            this.onclose({ code: 1008, reason: "", wasClean: false });
          }
        } else if (aksi === "close") {
          // Ditutup **sebelum** sempat terbuka.
          if (this.onclose) this.onclose({ code: kodeTutup, reason: "", wasClean: false });
        } else if (aksi === "error") {
          if (this.onerror) this.onerror({});
          if (this.onclose) this.onclose({ code: kodeTutup, reason: "", wasClean: false });
        }
      }, 5);
    }

    /** Kirim frame teks JSON ke klien (meniru server). */
    kirim(payload) {
      if (this.onmessage) {
        this.onmessage({ data: JSON.stringify(payload) });
      }
    }

    send(data) {
      this.sent.push(data);
    }

    close() {
      this.closed = true;
      if (this.onclose) this.onclose({ code: 1000, reason: "", wasClean: true });
    }
  }

  const sandbox = {
    WebSocket: WebSocketPalsu,
    fetch: async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        ticket: "tiket-uji",
        ws_base: "http://127.0.0.1:8022",
      }),
    }),
    document: {
      getElementById: () => ({ querySelector: () => ({ value: "csrf-token" }) }),
    },
    console,
    setTimeout,
    clearTimeout,
    Uint8Array,
    DataView,
    TextEncoder,
    TextDecoder,
    Error,
    Promise,
  };
  sandbox.window = sandbox;
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, "utf8"), sandbox);

  return { LectureSocket: sandbox.LectureSocket, dibuat };
}

/** Tunggu satu putaran event loop supaya promise sempat settle. */
function tick(ms = 60) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bungkus `connect()` jadi nilai yang bisa diamati: "pending"/"resolve"/"reject". */
function amati(promise) {
  const hasil = { state: "pending", error: null };
  promise.then(
    () => { hasil.state = "resolve"; },
    (error) => {
      hasil.state = "reject";
      hasil.error = error;
    }
  );
  return hasil;
}

// --------------------------------------------------------------------------
//  1. Handshake saja BELUM berarti siap — promise harus menggantung
// --------------------------------------------------------------------------
async function testPromiseGantungSebelumFrameStatus() {
  const { LectureSocket } = loadModule({ aksi: "open" });
  const states = [];
  const s = new LectureSocket.LectureSocket({
    sessionId: "sesi-1",
    onMessage: () => {},
    onState: (st) => states.push(st),
  });

  const hasil = amati(s.connect());
  await tick();

  check(
    "connect() BELUM settle setelah handshake saja",
    hasil.state === "pending",
    `dapat ${hasil.state}`
  );
  check(
    "state connected BELUM dikirim sebelum frame status",
    !states.includes("connected"),
    JSON.stringify(states)
  );
  check(
    "state handshake dikirim (handshake != siap)",
    states.includes("handshake"),
    JSON.stringify(states)
  );
  check("socket belum ditandai terhubung", s.connected === false);

  // Frame status pertama = server sudah memvalidasi tiket.
  s.socket.onmessage({
    data: JSON.stringify({ type: "status", status: "recording", last_seq: -1 }),
  });
  await tick();

  check(
    "connect() resolve setelah frame status pertama",
    hasil.state === "resolve",
    `dapat ${hasil.state}`
  );
  check("state connected dikirim", states.includes("connected"), JSON.stringify(states));
  check("socket ditandai terhubung", s.connected === true);
}

// --------------------------------------------------------------------------
//  2. Alur sukses normal: accept → status → resolve
// --------------------------------------------------------------------------
async function testConnectResolveSaatStatusMasuk() {
  const { LectureSocket } = loadModule({ aksi: "siap" });
  const states = [];
  const s = new LectureSocket.LectureSocket({
    sessionId: "sesi-1",
    onMessage: () => {},
    onState: (st) => states.push(st),
  });

  const hasil = amati(s.connect());
  await tick();

  check("connect() resolve saat server kirim status", hasil.state === "resolve", `dapat ${hasil.state}`);
  check("state connected dikirim", states.includes("connected"), JSON.stringify(states));
  check("socket ditandai terhubung", s.connected === true);
  check("serverRejected tetap false", s.serverRejected === false);
}

// --------------------------------------------------------------------------
//  3. Penolakan server: accept → frame error → close(1008) → REJECT
// --------------------------------------------------------------------------
async function testConnectRejectSaatTiketDitolak() {
  const { LectureSocket } = loadModule({ aksi: "tolak" });
  const states = [];
  const s = new LectureSocket.LectureSocket({
    sessionId: "sesi-1",
    onMessage: () => {},
    onState: (st) => states.push(st),
  });

  const hasil = amati(s.connect());
  await tick();

  check(
    "connect() reject saat server menolak",
    hasil.state === "reject",
    `dapat ${hasil.state}`
  );
  check(
    "alasan penolakan ikut ke pesan error",
    hasil.error && /kedaluwarsa/i.test(String(hasil.error.message)),
    hasil.error ? String(hasil.error.message) : "tanpa error"
  );
  check("state rejected dikirim", states.includes("rejected"), JSON.stringify(states));
  check(
    "state connected TIDAK dikirim saat ditolak",
    !states.includes("connected"),
    JSON.stringify(states)
  );
  check("socket tidak ditandai terhubung", s.connected === false);
  check("serverRejected ditandai true", s.serverRejected === true);
  check(
    "alasan penolakan tersimpan di serverRejectionReason",
    /kedaluwarsa/i.test(s.serverRejectionReason),
    s.serverRejectionReason
  );
  check(
    "tidak memicu state disconnected saat ditolak",
    !states.includes("disconnected"),
    JSON.stringify(states)
  );
}

// --------------------------------------------------------------------------
//  4. Penolakan yang tiba SETELAH connect() sudah resolve (rekaman jalan)
// --------------------------------------------------------------------------
async function testPenolakanSetelahSudahSiap() {
  const { LectureSocket } = loadModule({ aksi: "siap" });
  const states = [];
  const s = new LectureSocket.LectureSocket({
    sessionId: "sesi-1",
    onMessage: () => {},
    onState: (st) => states.push(st),
  });

  await s.connect();
  check("terhubung dulu", s.connected === true);

  s.socket.onmessage({
    data: JSON.stringify({ type: "error", error: "Sesi sudah berhenti." }),
  });
  await tick();

  check("serverRejected ditandai true", s.serverRejected === true);
  check(
    "alasan penolakan mid-sesi tersimpan",
    /berhenti/i.test(s.serverRejectionReason),
    s.serverRejectionReason
  );
  check(
    "tidak memicu state disconnected saat ditolak",
    !states.includes("disconnected"),
    JSON.stringify(states)
  );
}

// --------------------------------------------------------------------------
//  5. Jaringan mati: ditutup sebelum sempat terbuka
// --------------------------------------------------------------------------
async function testConnectRejectSaatTutupSebelumOpen() {
  const { LectureSocket } = loadModule({ aksi: "close" });
  const states = [];
  const s = new LectureSocket.LectureSocket({
    sessionId: "sesi-1",
    onMessage: () => {},
    onState: (st) => states.push(st),
  });

  const hasil = amati(s.connect());
  await tick();

  check(
    "connect() reject saat socket ditutup sebelum terbuka",
    hasil.state === "reject",
    `dapat ${hasil.state} — promise menggantung = bug`
  );
  check("state disconnected tetap dikirim", states.includes("disconnected"), JSON.stringify(states));
  check("socket tidak ditandai terhubung", s.connected === false);
}

async function testConnectRejectSaatError() {
  const { LectureSocket } = loadModule({ aksi: "error" });
  const states = [];
  const s = new LectureSocket.LectureSocket({
    sessionId: "sesi-1",
    onMessage: () => {},
    onState: (st) => states.push(st),
  });

  const hasil = amati(s.connect());
  await tick();

  check("connect() reject saat socket error", hasil.state === "reject", `dapat ${hasil.state}`);
  check("state error dikirim", states.includes("error"), JSON.stringify(states));
}

// --------------------------------------------------------------------------
//  6. Server diam: handshake tanpa status → guard waktu maksimal
// --------------------------------------------------------------------------
async function testConnectTimeoutKalauServerDiam() {
  const { LectureSocket } = loadModule({ aksi: "open" });
  const s = new LectureSocket.LectureSocket({
    sessionId: "sesi-1",
    readyTimeoutMs: 60,
    onMessage: () => {},
    onState: () => {},
  });

  const hasil = amati(s.connect());
  await tick(200);

  check(
    "connect() reject setelah guard waktu kalau server diam",
    hasil.state === "reject",
    `dapat ${hasil.state} — promise menggantung = bug`
  );
  check(
    "pesan menyebut batas waktu",
    hasil.error && /tidak mengonfirmasi/i.test(String(hasil.error.message)),
    hasil.error ? String(hasil.error.message) : "tanpa error"
  );
}

// --------------------------------------------------------------------------
//  7. await connect() tidak boleh menggantung — ini yang merusak reconnect
// --------------------------------------------------------------------------
async function testAwaitTidakMenggantung() {
  const { LectureSocket } = loadModule({ aksi: "close" });
  const s = new LectureSocket.LectureSocket({
    sessionId: "sesi-1",
    onMessage: () => {},
    onState: () => {},
  });

  // Pola pemakaian di lecture_listener.js:
  //   const ok = await connectLiveSocket();
  // Kalau `await` ini menggantung, scheduleReconnect() tak pernah jalan.
  let lanjut = false;
  const p = s.connect().then(
    () => { lanjut = true; },
    () => { lanjut = true; }
  );
  await Promise.race([p, tick(500)]);
  await tick(50);

  check("await connect() tidak menggantung saat socket gagal", lanjut === true);
}

// --------------------------------------------------------------------------
//  8. Frame status kedua tidak menimpa penyelesaian yang sudah terjadi
// --------------------------------------------------------------------------
async function testStatusKeduaTidakMenghitungUlang() {
  const { LectureSocket } = loadModule({ aksi: "siap" });
  const states = [];
  const s = new LectureSocket.LectureSocket({
    sessionId: "sesi-1",
    onMessage: () => {},
    onState: (st) => states.push(st),
  });

  const hasil = amati(s.connect());
  await tick();

  // Frame `status` kedua (dari backend, ketika satu jendela transkripsi
  // tidak menghasilkan teks) tidak membawa `last_seq`.
  s.socket.onmessage({
    data: JSON.stringify({ type: "status", status: "recording", seconds_received: 12 }),
  });
  await tick();

  check(
    "state connected hanya dikirim sekali",
    states.filter((st) => st === "connected").length === 1,
    JSON.stringify(states)
  );
  check("connect() tetap resolve", hasil.state === "resolve", `dapat ${hasil.state}`);
}

// --------------------------------------------------------------------------
//  9. sendChunk / sendCommand
// --------------------------------------------------------------------------
async function testClose_sendSetelahTutup() {
  const { LectureSocket } = loadModule({ aksi: "siap" });
  const s = new LectureSocket.LectureSocket({
    sessionId: "sesi-1",
    onMessage: () => {},
    onState: () => {},
  });

  await s.connect();
  check("sendChunk berhasil saat terhubung", s.sendChunk(0, new Uint8Array(4)) === true);

  s.close();
  check("sendChunk gagal setelah ditutup", s.sendChunk(1, new Uint8Array(4)) === false);
  check("sendCommand gagal setelah ditutup", s.sendCommand({ type: "stop" }) === false);
}

// --------------------------------------------------------------------------
async function main() {
  console.log("Test lecture_ws.js (transport WebSocket Lecture Listener)\n");

  await testPromiseGantungSebelumFrameStatus();
  await testConnectResolveSaatStatusMasuk();
  await testConnectRejectSaatTiketDitolak();
  await testPenolakanSetelahSudahSiap();
  await testConnectRejectSaatTutupSebelumOpen();
  await testConnectRejectSaatError();
  await testConnectTimeoutKalauServerDiam();
  await testAwaitTidakMenggantung();
  await testStatusKeduaTidakMenghitungUlang();
  await testClose_sendSetelahTutup();

  console.log("");
  console.log("====================================================");
  console.log(`  PASS: ${pass}    FAIL: ${fail}`);
  console.log("====================================================");

  if (fail) {
    console.log("\nGagal:");
    for (const f of failures) console.log("  - " + f);
  }
  process.exit(fail ? 1 : 0);
}

main();
