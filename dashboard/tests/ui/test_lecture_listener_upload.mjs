/**
 * Test logika UNGGAH BERKAS `lecture_listener.js` yang tahan pindah
 * halaman — skrip aslinya dijalankan di Node dengan DOM shim, `fetch`
 * palsu, dan store IndexedDB tiruan.
 *
 * **Bug yang dikunci di sini.**
 *
 * Navigasi dashboard adalah `<a href>` biasa: tiap klik menu = reload
 * penuh. Blob hasil rekaman / file pilihan ada di **memori** saja, jadi
 * kalau unggahan sudah jalan lalu user pindah halaman, `postFile()` ikut
 * mati dan berkasnya hilang tanpa bekas — pengguna menganggap unggahan
 * "ter-refresh" dan harus memilih ulang dari awal.
 *
 * Perbaikannya: berkas disimpan ke IndexedDB **sebelum** dikirim, dihapus
 * hanya setelah unggahan sampai di server, dan halaman berikutnya
 * melanjutkan yang tertunda. Test ini mengunci lima perilaku:
 *
 *   1. berkas ditulis ke IndexedDB **sebelum** request unggahan dikirim;
 *   2. setelah unggahan tuntas, catatan tertunda dibersihkan;
 *   3. reload dengan catatan tertunda → unggahan dilanjutkan otomatis
 *      (dan panel berakhir menampilkan sesi yang baru diunggah);
 *   4. tanpa catatan tertunda halaman tidak mengirim apa pun; tanpa
 *      IndexedDB alur unggah tetap jalan (degradasi graceful);
 *   5. menghapus sesi ikut membuang catatan unggahannya.
 *
 * Store IndexedDB ditiru dengan `Map` yang **dikunci antar boot** — persis
 * seperti IndexedDB sungguhan yang hidup setelah navigasi.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { buildDom, El } from "./dom_shim.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SRC = path.join(ROOT, "dashboard/static/dashboard/lecture_listener.js");
const TEMPLATE = path.join(ROOT, "dashboard/templates/dashboard/lecture_listener.html");

// ---------------------------------------------------------------------
// Pelapor check
// ---------------------------------------------------------------------

let pass = 0;
let fail = 0;

function check(cond, name, extra = "") {
  if (cond) {
    pass++;
    console.log("  PASS  " + name);
  } else {
    fail++;
    console.log("  FAIL  " + name + (extra ? "  -> " + extra : ""));
  }
}

// ---------------------------------------------------------------------
// Util
// ---------------------------------------------------------------------

/** Tunggu rantai promise (fetch palsu = microtask) benar-benar selesai. */
async function settle(rounds = 40) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

/** id elemen dari template — sumber kebenaran satu-satunya. */
function templateIds() {
  const html = fs.readFileSync(TEMPLATE, "utf8");
  return [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
}

function rowByTitle(historyNode, title) {
  const walk = (node) => {
    for (const child of node.children || []) {
      const strong =
        child.children?.[0]?.children?.[0]?.tagName === "STRONG"
          ? child.children[0].children[0]
          : null;
      if (strong && strong.textContent === title) return child;
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  return walk(historyNode);
}

// ---------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------

const SESSIONS = [
  { id: "S1", title: "Sesi Satu", status: "completed", duration_seconds: 65,
    created_at: "2026-01-01T10:00:00" },
  { id: "S2", title: "Sesi Dua", status: "completed", duration_seconds: 120,
    created_at: "2026-01-02T10:00:00" },
  { id: "S3", title: "Sesi Tiga", status: "completed", duration_seconds: 30,
    created_at: "2026-01-03T10:00:00" },
];

function transcriptFor(id) {
  return {
    ok: true,
    session_id: id,
    status: "completed",
    transcript: "transkrip " + id,
    segments: [{ start: 0, end: 2, text: "segmen " + id }],
    summary: "ringkasan " + id,
  };
}

/**
 * Store IndexedDB tiruan. Satu instance dipakai untuk banyak `boot()`
 * — itulah cara meniru "pindah halaman": memori JS hilang, disk tidak.
 */
function makeIdb() {
  const meta = new Map();
  return {
    meta,
    hasPending: () => meta.has("pendingUpload"),
    pending: () => meta.get("pendingUpload") || null,
    async open() {
      return {
        available: true,
        lastError: null,
        putMeta: async (value) => {
          meta.set("pendingUpload", value);
          return true;
        },
        getMeta: async () => (meta.has("pendingUpload") ? meta.get("pendingUpload") : null),
        clearMeta: async () => {
          meta.delete("pendingUpload");
        },
        sessions: async () => [],
      };
    },
  };
}

// ---------------------------------------------------------------------
// Harness: jalankan lecture_listener.js asli sekali per test case
// ---------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string|null} opts.lastSession  isi sessionStorage pilihan terakhir
 * @param {Array}  [opts.sessions]        daftar sesi dari /api/lecture/
 * @param {object|null} opts.idb          store IndexedDB (null = tanpa IndexedDB)
 * @param {boolean} opts.holdAudio        tahan request POST .../audio/ sampai
 *        test memanggil `releaseAudio()` — dipakai untuk melihat state
 *        di tengah unggahan.
 */
function boot({ lastSession = null, sessions = SESSIONS, idb = null, holdAudio = false } = {}) {
  const ids = templateIds();
  const { root, els } = buildDom(ids);

  const sessionList = sessions.map((s) => ({ ...s }));

  const store = new Map();
  if (lastSession !== null) store.set("akademia.lectureLastSession", lastSession);
  const sessionStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  const fetchLog = [];
  const audioCalls = []; // { url, body, metaWhenSent }
  const audioReleases = [];
  const metaWhenSent = []; // true kalau catatan sudah ada saat request dikirim

  async function fakeFetch(url, options = {}) {
    const method = (options.method || "GET").toUpperCase();
    fetchLog.push(method + " " + url);

    // GET /api/lecture/
    if (method === "GET" && url === "/api/lecture/") {
      return { ok: true, status: 200, json: async () => ({ ok: true, sessions: sessionList }) };
    }

    // POST /api/lecture/start/
    if (method === "POST" && url === "/api/lecture/start/") {
      const body = JSON.parse(options.body || "{}");
      const id = "S9";
      if (!sessionList.some((s) => s.id === id)) {
        sessionList.push({
          id,
          title: body.title || "Sesi Baru",
          status: "completed",
          duration_seconds: 0,
          created_at: "2026-01-04T10:00:00",
        });
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, session_id: id }) };
    }

    // DELETE /api/lecture/<id>/delete/
    const del = url.match(/^\/api\/lecture\/([^/]+)\/delete\/$/);
    if (method === "DELETE" && del) {
      const i = sessionList.findIndex((s) => s.id === del[1]);
      if (i >= 0) sessionList.splice(i, 1);
      return { ok: true, status: 204, json: async () => ({}) };
    }

    // POST /api/lecture/<id>/audio/
    const audio = url.match(/^\/api\/lecture\/([^/]+)\/audio\/$/);
    if (method === "POST" && audio) {
      const sentWithMeta = idb ? idb.hasPending() : false;
      metaWhenSent.push(sentWithMeta);
      audioCalls.push({ url, body: options.body, sessionId: audio[1] });
      const respond = () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, session_id: audio[1], status: "transcribing" }),
      });
      if (holdAudio) {
        return new Promise((resolve) => audioReleases.push(() => resolve(respond())));
      }
      return respond();
    }

    // GET /api/lecture/<id>/status/
    const st = url.match(/^\/api\/lecture\/([^/]+)\/status\/$/);
    if (method === "GET" && st) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, session_id: st[1], status: "completed" }),
      };
    }

    // GET /api/lecture/<id>/transcript/
    const tr = url.match(/^\/api\/lecture\/([^/]+)\/transcript\/$/);
    if (method === "GET" && tr) {
      const data = transcriptFor(tr[1]);
      return { ok: true, status: 200, json: async () => data };
    }

    // GET /api/lecture/<id>/summary/
    const sum = url.match(/^\/api\/lecture\/([^/]+)\/summary\/$/);
    if (method === "GET" && sum) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, summary: "ringkasan " + sum[1] }),
      };
    }

    // Sisanya (stop/dst) — cukup untuk kontrak getJson/postJson.
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }

  const pendingDomReady = [];
  const intervals = new Map();
  let nextTimerId = 1;

  const document = {
    getElementById: (id) => els[id] || null,
    createElement: (tag) => new El(tag),
    querySelector: (sel) => root.querySelector(sel),
    addEventListener: (type, fn) => {
      if (type === "DOMContentLoaded") pendingDomReady.push(fn);
    },
  };

  const location = { href: "" };
  const window = {
    addEventListener() {},
    confirm: () => true,
    location,
    // IndexedDB ada hanya kalau test menghadirkannya — kalau tidak,
    // jalur "store tidak tersedia" yang diuji.
    LectureOffline: idb
      ? { OfflineChunkStore: { open: () => idb.open() } }
      : undefined,
    LectureCapture: undefined,
  };

  const ctx = {
    document,
    window,
    sessionStorage,
    navigator: { onLine: true },
    fetch: fakeFetch,
    FormData,
    console,
    setTimeout: (fn) => {
      const id = nextTimerId++;
      intervals.set(id, fn); // tidak pernah dijalankan otomatis
      return id;
    },
    clearTimeout: (id) => intervals.delete(id),
    setInterval: (fn) => {
      const id = nextTimerId++;
      intervals.set(id, fn);
      return id;
    },
    clearInterval: (id) => intervals.delete(id),
  };

  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(SRC, "utf8"), ctx, { filename: "lecture_listener.js" });

  return {
    els,
    store,
    fetchLog,
    audioCalls,
    metaWhenSent,
    location,
    sessionStorage,
    /** Lepaskan request unggahan yang ditahan. */
    async releaseAudio() {
      const releases = audioReleases.splice(0);
      releases.forEach((fn) => fn());
      await settle();
    },
    /** Pilih berkas lalu nyalakan handler `change` (pemilih file). */
    async chooseFile(file) {
      els.audioFileInput.files = [file];
      els.audioFileInput.dispatch("change");
      await settle();
    },
    async ready() {
      pendingDomReady.forEach((fn) => fn());
      await settle();
    },
    textarea: () => els.transcript,
    hint: () => els.recordHint,
    status: () => els.recordingStatus,
    toast: () => els.toast,
    history: () => els.sessionHistory,
  };
}

// ---------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------

console.log("\n1. Berkas ditulis ke IndexedDB sebelum dikirim, dibersihkan sesudahnya");

{
  const idb = makeIdb();
  const t = boot({ lastSession: "S2", idb, holdAudio: true });
  await t.ready();

  check(
    t.textarea().value === "transkrip S2",
    "awal: panel menampilkan sesi S2 (hasil pemulihan pilihan terakhir)",
  );
  check(t.audioCalls.length === 0, "belum ada request unggahan saat halaman dibuka");

  const file = new File(["isi-rekaman"], "kuliah.mp3", { type: "audio/mpeg" });
  await t.chooseFile(file);

  // Unggahan masih ditahan di sini — inilah jendela "tengah unggahan".
  check(t.audioCalls.length === 1, "request unggahan sudah dikirim");
  check(
    t.metaWhenSent[0] === true,
    "catatan sudah tersimpan di IndexedDB SAAT request dikirim (bukan sesudahnya)",
  );
  const pending = idb.pending();
  check(Boolean(pending && pending.blob), "catatan memuat blob berkasnya");
  check(pending && pending.filename === "kuliah.mp3", "catatan memuat nama berkasnya");
  check(pending && pending.sessionId === "S2", "catatan terkunci ke sesi tujuan");
  check(
    t.hint().textContent.includes("Mengunggah kuliah.mp3"),
    "panel menampilkan progres unggahan",
  );

  await t.releaseAudio();
  await settle();

  check(!idb.hasPending(), "catatan dibersihkan setelah unggahan sampai di server");
  check(
    t.status().textContent === "Transkrip Selesai",
    "polling status selesai setelah unggahan",
    t.status().textContent,
  );
  check(t.textarea().value === "transkrip S2", "transkrip S2 tampil setelah unggahan");
  const sent = t.audioCalls[0] && t.audioCalls[0].body;
  check(
    sent && typeof sent.get === "function" && sent.get("file")?.name === "kuliah.mp3",
    "berkas yang terkirim memang berkas yang dipilih",
    sent ? "(body bukan FormData)" : "(tidak ada request)",
  );
}

console.log("\n2. Reload di tengah unggahan → unggahan dilanjutkan otomatis");

{
  const idb = makeIdb();
  const blob = new File(["rekaman-tengah-jalan"], "kuliah.webm", { type: "audio/webm" });
  idb.meta.set("pendingUpload", {
    sessionId: "S2",
    filename: "kuliah.webm",
    blob,
    title: "",
  });

  // lastSession sengaja S1: membuktikan unggahan tertunda MENANG atas
  // pilihan terakhir yang sempat dipulihkan.
  const t = boot({ lastSession: "S1", idb, holdAudio: true });
  await t.ready();

  check(t.audioCalls.length === 1, "unggahan tertunda dikirim ulang oleh halaman baru");
  const resumed = t.audioCalls[0];
  check(
    Boolean(resumed) && resumed.sessionId === "S2",
    "target unggahan tetap sesi aslinya",
    resumed ? resumed.sessionId : "(tidak ada request)",
  );
  check(idb.hasPending(), "catatan masih ada selama unggahan berjalan");
  check(
    t.status().textContent === "Melanjutkan Unggahan",
    "status menyatakan ini LANJUTAN, bukan unggahan baru",
    t.status().textContent,
  );
  check(
    t.hint().textContent.includes("Melanjutkan unggahan"),
    "catatan panel menjelaskan unggahan yang tertunda",
  );

  await t.releaseAudio();
  await settle();

  check(!idb.hasPending(), "catatan dibersihkan setelah unggahan lanjutan tuntas");
  check(
    t.textarea().value === "transkrip S2",
    "panel berakhir menampilkan sesi yang baru diunggah",
    t.textarea().value,
  );
  check(
    t.store.get("akademia.lectureLastSession") === "S2",
    "pilihan terakhir ikut pindah ke sesi yang diunggah",
  );
  check(
    t.fetchLog.includes("POST /api/lecture/S2/audio/"),
    "request audio sesi S2 benar-benar tercatat",
  );
}

console.log("\n3. Tanpa catatan tertunda, halaman tidak mengirim apa pun");

{
  const idb = makeIdb();
  const t = boot({ lastSession: "S2", idb });
  await t.ready();

  check(t.audioCalls.length === 0, "tidak ada request unggahan yang tidak diminta");
  check(
    !t.fetchLog.some((u) => u.includes("/stop/")),
    "tidak ada request /stop/ yang tidak diminta",
  );
}

console.log("\n4. Tanpa IndexedDB, alur unggah tetap jalan (degradasi graceful)");

{
  const t = boot({ lastSession: "S2", idb: null });
  await t.ready();

  const file = new File(["tanpa-idb"], "tanpa-idb.mp3", { type: "audio/mpeg" });
  await t.chooseFile(file);
  await settle();

  check(t.audioCalls.length === 1, "unggahan tetap dikirim walau store tidak tersedia");
  check(t.textarea().value === "transkrip S2", "transkrip tetap tampil");
  check(
    !t.toast().textContent.toLowerCase().includes("gagal") &&
      !t.hint().textContent.includes("Terjadi kesalahan"),
    "tidak ada error yang dilempar ke pengguna",
    t.toast().textContent,
  );
}

console.log("\n5. Menghapus sesi ikut membuang catatan unggahannya");

{
  const idb = makeIdb();
  const blob = new File(["menunggu-lama"], "tengah.webm", { type: "audio/webm" });
  idb.meta.set("pendingUpload", {
    sessionId: "S2",
    filename: "tengah.webm",
    blob,
    title: "",
  });

  // Unggahan ditahan selamanya: kalau penghapusan tidak membersihkan
  // catatan, catatan itu akan hidup terus dan gagal 404 di reload
  // berikutnya.
  const t = boot({ lastSession: "S2", idb, holdAudio: true });
  await t.ready();

  check(idb.hasPending(), "catatan masih ada sebelum sesi dihapus");

  const row = rowByTitle(t.history(), "Sesi Dua");
  check(row !== null, "baris Sesi Dua ada di riwayat");
  const remove = row && row.children[1];
  if (remove) remove.dispatch("click");
  await settle();

  check(!idb.hasPending(), "catatan unggahan ikut terbuang saat sesi dihapus");
  check(
    t.fetchLog.includes("DELETE /api/lecture/S2/delete/"),
    "sesi S2 benar-benar dihapus",
  );
}

console.log(`\nPASS: ${pass}  FAIL: ${fail}`);
process.exit(fail > 0 ? 1 : 0);
