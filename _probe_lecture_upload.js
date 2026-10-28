/**
 * Probe end-to-end: buktikan **unggahan audio selamat dari pindah halaman**
 * di Chromium sungguhan — kasus "pilih file → pindah halaman → unggahannya
 * hilang seperti di-refresh".
 *
 * Skenario:
 *   1. Login akun service (kredensial dibaca dari .env, TIDAK dicetak).
 *   2. Buat sesi lewat BFF.
 *   3. Buka /lecture-listener/, pilih berkas audio.
 *   4. Request unggahan PERTAMA ditahan 15 detik oleh route Playwright,
 *      lalu user pindah halaman di tengah jalan (request dibatalkan).
 *   5. Kembali ke /lecture-listener/ → unggahan harus dikirim ULANG
 *      otomatis oleh IndexedDB, tanpa user memilih file lagi.
 *   6. Backend membuktikan berkasnya benar-benar sampai (`audioUrl` ada).
 *   7. Tidak ada error JavaScript (kecuali pembatalan request yang memang
 *      disengaja).
 *
 * Jalankan:  NODE_PATH="C:/Users/Pongo/AppData/Roaming/npm/node_modules" node _probe_lecture_upload.js
 */
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const BASE = process.env.ACADEMIA_BASE_URL || "http://127.0.0.1:8010";

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

/** Baca kredensial dari .env tanpa pernah mencetaknya. */
function serviceCredentials() {
  let email = process.env.AKADEMIA_API_EMAIL || "";
  let password = process.env.AKADEMIA_API_PASSWORD || "";
  if (email && password) return { email, password };
  try {
    for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#") || !t.includes("=")) continue;
      const i = t.indexOf("=");
      const key = t.slice(0, i).trim();
      const val = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      if (key === "AKADEMIA_API_EMAIL" && !email) email = val;
      else if (key === "AKADEMIA_API_PASSWORD" && !password) password = val;
    }
  } catch {
    /* .env tidak ada */
  }
  return { email, password };
}

/**
 * WAV 16 kHz mono diam 1 detik — cukup untuk memicu seluruh alur unggah
 * (backend menerima & menyimpan berkasnya).
 */
function writeSilentWav(file) {
  const sampleRate = 16000;
  const seconds = 1;
  const dataLen = sampleRate * 2 * seconds; // 16-bit mono
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataLen, 40);
  fs.writeFileSync(file, buf);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { email, password } = serviceCredentials();
  if (!email || !password) {
    console.error("KREDENSIAL TIDAK ADA — probe dibatalkan.");
    process.exit(2);
  }

  const wavPath = path.join(__dirname, "_probe_silent.wav");
  writeSilentWav(wavPath);

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    const consoleErrors = [];
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const text = m.text();
      // Request yang kita batalkan sendiri saat pindah halaman memang
      // muncul sebagai ERR_ABORTED — itu bukan cacat aplikasi.
      if (/ERR_ABORTED|Failed to load resource/i.test(text)) return;
      consoleErrors.push(text);
    });
    page.on("pageerror", (e) => consoleErrors.push(e.message));

    // --- 1. login ---
    await page.goto(BASE + "/login/", { waitUntil: "networkidle" });
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15000 });
    check(true, "login akun service berhasil");

    // --- 2. buat sesi ---
    const title = "Probe Upload " + Date.now();
    const r = await context.request.post(BASE + "/api/lecture/start/", { data: { title } });
    const d = await r.json();
    const sessionId = d.session_id;
    check(Boolean(sessionId), "sesi uji dibuat", JSON.stringify(d).slice(0, 160));
    if (!sessionId) throw new Error("session_id tidak ada");

    // --- 3. buka halaman listener, tunggu pemulihan sesi selesai ---
    await page.goto(BASE + "/lecture-listener/", { waitUntil: "networkidle" });
    await page.waitForFunction(
      (expected) => {
        const sel = document.querySelector("#sessionHistory .history-row.is-selected");
        return sel !== null && sel.textContent.includes(expected);
      },
      title,
      { timeout: 20000 },
    );
    check(true, "sesi uji terbuka otomatis di panel (restore selesai)");

    // --- 4. tahan unggahan PERTAMA supaya bisa pindah halaman di tengahnya ---
    let audioPosts = 0;
    await page.route("**/api/lecture/*/audio/", async (route) => {
      audioPosts++;
      const n = audioPosts;
      if (n === 1) {
        // Tahan 15 detik: cukup lama untuk pindah halaman di tengah
        // unggahan. Request-nya akan dibatalkan oleh navigasi.
        await sleep(15000);
        try {
          await route.continue();
        } catch {
          /* halaman sudah pindah — memang kita yang membatalkan */
        }
        return;
      }
      await route.continue();
    });

    await page.setInputFiles("#audioFileInput", wavPath);

    // Tunggu sampai request unggahan pertama benar-benar berangkat.
    for (let i = 0; i < 100 && audioPosts < 1; i++) await sleep(100);
    check(audioPosts >= 1, "unggahan pertama berangkat (lalu ditahan)", "audioPosts=" + audioPosts);

    // --- 5. pindah halaman di TENGAH unggahan ---
    await page.goto(BASE + "/reminder-system/", { waitUntil: "domcontentloaded" });
    check(true, "pindah halaman saat unggahan masih berjalan");

    // --- 6. kembali: unggahan harus dilanjutkan otomatis ---
    await page.goto(BASE + "/lecture-listener/", { waitUntil: "domcontentloaded" });

    const deadline = Date.now() + 40000;
    while (audioPosts < 2 && Date.now() < deadline) await sleep(100);
    check(audioPosts >= 2, "unggahan dikirim ULANG otomatis tanpa dipilih lagi",
      "audioPosts=" + audioPosts);

    const stored = await page.evaluate(() =>
      sessionStorage.getItem("akademia.lectureLastSession"));
    check(stored === sessionId, "pilihan sesi tetap sesi uji", String(stored));

    // --- 7. backend menerima berkasnya ---
    let hasAudio = false;
    for (let i = 0; i < 60 && !hasAudio; i++) {
      const lr = await context.request.get(BASE + "/api/lecture/");
      const list = (await lr.json()).sessions || [];
      const s = list.find((x) => x.id === sessionId);
      hasAudio = Boolean(s && s.audioUrl);
      if (!hasAudio) await sleep(500);
    }
    check(hasAudio, "backend menyimpan berkas audio hasil unggahan lanjutan");

    const hint = await page.evaluate(() => {
      const el = document.getElementById("recordHint");
      return el ? el.textContent : "";
    });
    check(
      !/Melanjutkan unggahan/.test(hint) || /Berkas terunggah|Memproses/.test(hint),
      "panel tidak tersangkut di status 'melanjutkan'",
      hint.slice(0, 120),
    );

    // --- 8. bersih ---
    await context.request.delete(BASE + "/api/lecture/" + sessionId + "/delete/");
    try { fs.unlinkSync(wavPath); } catch { /* sudah hilang */ }

    check(consoleErrors.length === 0, "tidak ada error JavaScript",
      consoleErrors.slice(0, 3).join(" | "));
  } finally {
    await browser.close();
  }

  console.log(`\nPASS: ${pass}  FAIL: ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("PROBE CRASH:", e.message);
  process.exit(1);
});
