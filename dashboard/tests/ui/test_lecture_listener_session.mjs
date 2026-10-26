/**
 * Test logika PEMULIHAN SESI `lecture_listener.js` — skrip aslinya
 * dijalankan di Node dengan DOM shim dan `fetch` palsu.
 *
 * **Bug yang dikunci di sini.**
 *
 * Navigasi dashboard adalah `<a href>` biasa: tiap klik menu = reload
 * penuh. Halaman yang kembali selalu mulai dengan `currentSessionId=null`
 * dan panel transkrip kosong — tidak ada jalur untuk membuka sesi lama:
 *
 *   - `fetchTranscriptAndSummary()` hanya dipanggil setelah rekaman/upload;
 *   - baris riwayat tidak punya handler klik;
 *   - ekspor & ringkasan membaca `currentSessionId`, jadi ikut menolak
 *     dengan "Rekaman atau unggah berkas dulu" sampai user merekam lagi.
 *
 * Perbaikannya: klik judul baris riwayat = buka sesi, ditambah auto-restore
 * sesi terakhir (sessionStorage) / terbaru (`created_at`) saat halaman
 * dimuat. Test ini mengunci lima perilaku:
 *
 *   1. reload dengan pilihan tersimpan → sesi itu yang dibuka;
 *   2. tanpa pilihan → sesi `created_at` terbaru (backend tidak mengurutkan);
 *   3. klik judul baris → sesi itu tampil & tersimpan;
 *   4. sesi terpilih = `currentSessionId`, jadi ekspor/ringkasan jalan;
 *   5. dua pilihan cepat → respons terakhir menang (`restoreSeq`);
 *   plus: sesi yang dihapus bersih dari penyimpanan.
 *
 * Elemen DOM **diparse dari template asli**, bukan daftar hardcode —
 * kalau id dipanggil hilang dari template, test gagal (bukan diam-diam
 * menguji elemen yang tidak pernah dirender).
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

function check(cond, name) {
  if (cond) {
    pass++;
    console.log("  PASS  " + name);
  } else {
    fail++;
    console.log("  FAIL  " + name);
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

/** Cari baris riwayat berdasarkan judul. */
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

function titleOfRow(row) {
  return row?.children?.[0]?.children?.[0] || null;
}

function deleteButtonOfRow(row) {
  return row?.children?.[1] || null;
}

// ---------------------------------------------------------------------
// Fixture sesi
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

// ---------------------------------------------------------------------
// Harness: jalankan lecture_listener.js asli sekali per test case
// ---------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string|null} opts.lastSession  isi sessionStorage pilihan terakhir
 * @param {Array}  [opts.sessions]        daftar sesi dari /api/lecture/
 * @param {string[]} [opts.deferTranscript] id yang transcript-nya di-hold
 *        sampai test memanggil `resolveTranscript(id)` (uji balapan).
 * @param {object} [opts.transcriptStatus] status non-completed per id
 */
function boot({ lastSession = null, sessions = SESSIONS, deferTranscript = [], transcriptStatus = {} } = {}) {
  const ids = templateIds();
  const { root, els } = buildDom(ids);

  // Salinan per-boot: DELETE menghapus dari daftar ini, supaya reload
  // riwayat meniru backend sungguhan (barisnya benar-benar hilang).
  const sessionList = sessions.map((s) => ({ ...s }));

  // sessionStorage sungguhan-bijaksana (lempar saat diblokir, seperti
  // browser mode privasi) — diisi manual per test case.
  const store = new Map();
  if (lastSession !== null) store.set("akademia.lectureLastSession", lastSession);
  const sessionStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  const fetchLog = [];
  const deferredTranscript = new Map(); // id → resolve
  const deferredIds = new Set(deferTranscript);

  async function fakeFetch(url) {
    fetchLog.push(url);

    // GET /api/lecture/
    if (url === "/api/lecture/") {
      return { ok: true, status: 200, json: async () => ({ ok: true, sessions: sessionList }) };
    }

    // DELETE /api/lecture/<id>/delete/
    const del = url.match(/^\/api\/lecture\/([^/]+)\/delete\/$/);
    if (del) {
      const i = sessionList.findIndex((s) => s.id === del[1]);
      if (i >= 0) sessionList.splice(i, 1);
      return { ok: true, status: 204, json: async () => ({}) };
    }

    // GET /api/lecture/<id>/transcript/
    const tr = url.match(/^\/api\/lecture\/([^/]+)\/transcript\/$/);
    if (tr) {
      const id = tr[1];
      const make = () => {
        const data = transcriptFor(id);
        if (transcriptStatus[id]) data.status = transcriptStatus[id];
        return { ok: true, status: 200, json: async () => data };
      };
      if (deferredIds.has(id)) {
        return new Promise((resolve) => deferredTranscript.set(id, resolve));
      }
      return make();
    }

    // GET /api/lecture/<id>/export/
    const ex = url.match(/^\/api\/lecture\/([^/]+)\/export\/$/);
    if (ex) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          transcript: "transkrip " + ex[1],
          summary: "ringkasan " + ex[1],
        }),
      };
    }

    // GET /api/lecture/<id>/summary/
    const sum = url.match(/^\/api\/lecture\/([^/]+)\/summary\/$/);
    if (sum) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, summary: "ringkasan " + sum[1] }),
      };
    }

    // Sisanya (start/stop/dst) — cukup untuk kontrak getJson/postJson.
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
    LectureOffline: undefined,
    LectureCapture: undefined,
  };

  const ctx = {
    document,
    window,
    sessionStorage,
    navigator: { onLine: true },
    fetch: fakeFetch,
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
    location,
    sessionStorage,
    /** Jalankan listener DOMContentLoaded (inisialisasi halaman). */
    async ready() {
      pendingDomReady.forEach((fn) => fn());
      await settle();
    },
    /** Selesaikan fetch transcript yang ditahan (uji balapan). */
    async resolveTranscript(id) {
      const resolve = deferredTranscript.get(id);
      if (!resolve) throw new Error("transcript " + id + " tidak ditahan");
      deferredTranscript.delete(id);
      resolve({ ok: true, status: 200, json: async () => transcriptFor(id) });
      await settle();
    },
    textarea: () => els.transcript,
    hint: () => els.historyHint,
    history: () => els.sessionHistory,
    summary: () => els.lectureSummary,
  };
}

// ---------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------

console.log("\n1. Pilihan terakhir di sessionStorage dibuka lagi setelah reload");

{
  const t = boot({ lastSession: "S2" });
  await t.ready();

  check(t.textarea().value === "transkrip S2", "panel menampilkan transkrip S2");
  check(t.hint().hidden === false, "catatan cara membuka sesi tampil");
  check(
    t.store.get("akademia.lectureLastSession") === "S2",
    "pilihan terakhir tetap S2",
  );

  const row = rowByTitle(t.history(), "Sesi Dua");
  check(
    row !== null && row.classList.contains("is-selected"),
    "baris S2 disorot is-selected",
  );
  check(
    row !== null && titleOfRow(row).getAttribute("role") === "button",
    "judul baris punya role=button",
  );
  check(
    t.fetchLog.some((u) => u === "/api/lecture/S2/transcript/"),
    "transcript S2 diambil",
  );
}

console.log("\n2. Tanpa pilihan tersimpan → sesi created_at terbaru dibuka");

{
  const t = boot({ lastSession: null });
  await t.ready();

  // Backend TIDAK mengurutkan (lihat list_lectures: tanpa order_by),
  // jadi "baris pertama" = S1 (paling lama). Yang benar: S3 (terbaru).
  check(t.textarea().value === "transkrip S3", "S3 (created_at terbaru) dibuka");
  check(
    t.store.get("akademia.lectureLastSession") === "S3",
    "S3 tersimpan sebagai pilihan baru",
  );
}

console.log("\n3. Pilihan terakhir sudah dihapus → jatuh ke sesi terbaru");

{
  const t = boot({ lastSession: "S9-HILANG" });
  await t.ready();

  check(t.textarea().value === "transkrip S3", "sesi fantom tidak dibuka; S3 yang tampil");
  check(
    t.store.get("akademia.lectureLastSession") === "S3",
    "penyimpanan diperbaiki menjadi S3",
  );
}

console.log("\n4. Klik judul baris membuka sesi itu");

{
  const t = boot({ lastSession: "S2" });
  await t.ready();

  const row = rowByTitle(t.history(), "Sesi Satu");
  check(row !== null, "baris Sesi Satu ada");
  titleOfRow(row).dispatch("click");
  await settle();

  check(t.textarea().value === "transkrip S1", "panel beralih ke S1");
  check(
    t.store.get("akademia.lectureLastSession") === "S1",
    "S1 jadi pilihan terakhir",
  );
  // renderHistory MEMBUAT ULANG baris (replaceChildren), jadi baris lama
  // sudah lepas dari DOM — selalu query ulang sebelum memeriksa sorotan.
  const freshS1 = rowByTitle(t.history(), "Sesi Satu");
  check(
    freshS1 !== null &&
      freshS1.classList.contains("is-selected") &&
      !rowByTitle(t.history(), "Sesi Dua").classList.contains("is-selected"),
    "sorotan pindah ke baris S1",
  );
}

console.log("\n5. Ses terpilih = currentSessionId → ringkasan & ekspor memakainya");

{
  const t = boot({ lastSession: "S1" });
  await t.ready();
  t.fetchLog.length = 0;

  // Ringkasan.
  t.els.summarizeButton.dispatch("click");
  await settle();
  check(
    t.fetchLog.some((u) => u === "/api/lecture/S1/summary/"),
    "ringkasan diambil untuk S1 (currentSessionId pulih)",
  );

  // Ekspor ke Document Creator.
  t.fetchLog.length = 0;
  t.els.exportButton.dispatch("click");
  await settle();
  check(
    t.fetchLog.some((u) => u === "/api/lecture/S1/export/"),
    "ekspor diambil untuk S1",
  );
  const draft = t.store.get("akademia.documentDraft");
  check(!!draft && draft.includes("transkrip S1"), "draft dokumen berisi transkrip S1");
  check(t.location.href === "/document-creator/", "berpindah ke Document Creator");

  // Ringkasan juga masuk ke panel (renderSummary).
  check(
    t.summary().children.some((c) => c.textContent.includes("ringkasan S1")),
    "panel ringkasan terisi dari S1",
  );
}

console.log("\n6. Dua pilihan cepat → respons TERAKHIR yang menang (restoreSeq)");

{
  const t = boot({ lastSession: "S3", deferTranscript: ["S1", "S2"] });
  await t.ready();

  // Klik S1 (transcript ditahan), lalu S2 (juga ditahan).
  titleOfRow(rowByTitle(t.history(), "Sesi Satu")).dispatch("click");
  await settle();
  titleOfRow(rowByTitle(t.history(), "Sesi Dua")).dispatch("click");
  await settle();

  // Selesaikan S2 dulu, baru S1 — respons lama datang BELAKANGAN.
  await t.resolveTranscript("S2");
  await t.resolveTranscript("S1");

  check(t.textarea().value === "transkrip S2", "isi panel = pilihan terakhir (S2)");
  check(
    t.store.get("akademia.lectureLastSession") === "S2",
    "penyimpanan = pilihan terakhir (S2)",
  );
}

console.log("\n7. Menghapus sesi yang sedang dibuka membersihkan pilihan");

{
  const t = boot({ lastSession: "S2" });
  await t.ready();

  const row = rowByTitle(t.history(), "Sesi Dua");
  deleteButtonOfRow(row).dispatch("click"); // confirm dipalsukan → true
  await settle();

  check(
    t.store.get("akademia.lectureLastSession") === undefined,
    "pilihan terakhir ikut terhapus",
  );
  check(
    rowByTitle(t.history(), "Sesi Dua") === null,
    "riwayat dirender ulang tanpa S2",
  );
}

console.log("\n8. Sesi belum selesai → toast menjelaskan statusnya");

{
  const t = boot({
    lastSession: null,
    transcriptStatus: { S3: "transcribing" },
  });
  await t.ready();

  check(
    t.els.toast.textContent.includes("masih transcribing"),
    "toast menyebut status transcribing",
  );
}

console.log("\n9. Riwayat kosong → tanpa crash, panel tetap kosong");

{
  const t = boot({ lastSession: null, sessions: [] });
  await t.ready();

  check(t.textarea().value === "", "transkrip tetap kosong");
  check(
    t.history().textContent.includes("Belum ada sesi rekaman"),
    "state kosong dilaporkan jujur",
  );
}

// ---------------------------------------------------------------------

console.log(`\nPASS: ${pass}  FAIL: ${fail}`);
process.exit(fail > 0 ? 1 : 0);
