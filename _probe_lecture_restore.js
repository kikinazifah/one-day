/**
 * Probe end-to-end: buktikan pemulihan sesi Lecture Listener di Chromium
 * sungguhan — kasus "ganti halaman → listener kosong lagi".
 *
 * Skenario:
 *   1. Login akun service (kredensial dibaca dari .env, TIDAK dicetak).
 *   2. Buat sesi A + sesi B lewat BFF.
 *   3. Buka /lecture-listener/ → auto-restore harus membuka sesi terbaru,
 *      #historyHint tampil, baris .is-selected ada.
 *   4. Pindah halaman (reload penuh, sama dengan klik menu) → tetap pulih
 *      dari sessionStorage.
 *   5. Klik judul sesi A → panel beralih, sorotan pindah.
 *   6. Tidak ada error JavaScript.
 *
 * Jalankan:  node _probe_lecture_restore.js
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

async function main() {
  const { email, password } = serviceCredentials();
  if (!email || !password) {
    console.error("KREDENSIAL TIDAK ADA — probe dibatalkan.");
    process.exit(2);
  }

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    const consoleErrors = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(e.message));

    // --- 1. login ---
    await page.goto(BASE + "/login/", { waitUntil: "networkidle" });
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15000 });
    check(true, "login akun service berhasil");

    // --- 2. buat dua sesi ---
    const stamp = Date.now();
    const titleA = "Probe Restore A " + stamp;
    const titleB = "Probe Restore B " + stamp;
    const rA = await context.request.post(BASE + "/api/lecture/start/", { data: { title: titleA } });
    const dA = await rA.json();
    const rB = await context.request.post(BASE + "/api/lecture/start/", { data: { title: titleB } });
    const dB = await rB.json();
    check(Boolean(dA.session_id && dB.session_id), "dua sesi uji dibuat",
      JSON.stringify({ A: dA.session_id || dA, B: dB.session_id || dB }).slice(0, 160));

    // --- 3. buka halaman listener (context baru = sessionStorage kosong) ---
    const p2 = await context.newPage();
    const errs2 = [];
    p2.on("console", (m) => {
      if (m.type() === "error") errs2.push(m.text());
    });
    p2.on("pageerror", (e) => errs2.push(e.message));
    await p2.goto(BASE + "/lecture-listener/", { waitUntil: "networkidle" });
    await p2.waitForSelector("#sessionHistory .history-row", { timeout: 15000 });

    const hasHintNode = await p2.evaluate(() => document.getElementById("historyHint") !== null);
    check(hasHintNode, "#historyHint ada di DOM (template terbaru termuat)");

    await p2.waitForFunction(() => {
      const sel = document.querySelector("#sessionHistory .history-row.is-selected");
      return sel !== null;
    }, { timeout: 15000 });
    const selectedB = await p2.evaluate((expected) => {
      const sel = document.querySelector("#sessionHistory .history-row.is-selected");
      return sel ? sel.textContent.includes(expected) : false;
    }, titleB);
    check(selectedB, "auto-restore membuka sesi terbaru (B) tanpa pilihan tersimpan");

    const hintVisible = await p2.evaluate(() => {
      const el = document.getElementById("historyHint");
      return el ? !el.hidden : false;
    });
    check(hintVisible, "#historyHint terlihat setelah restore");

    const stored = await p2.evaluate(() =>
      sessionStorage.getItem("akademia.lectureLastSession"));
    check(Boolean(stored), "pilihan terakhir tersimpan di sessionStorage");

    // --- 4. reload penuh (analogi: klik menu pergi-balik) ---
    await p2.goto(BASE + "/reminder-system/", { waitUntil: "networkidle" });
    await p2.goto(BASE + "/lecture-listener/", { waitUntil: "networkidle" });
    await p2.waitForFunction(() =>
      document.querySelector("#sessionHistory .history-row.is-selected") !== null,
      { timeout: 15000 });
    const stillB = await p2.evaluate((expected) => {
      const sel = document.querySelector("#sessionHistory .history-row.is-selected");
      return sel ? sel.textContent.includes(expected) : false;
    }, titleB);
    check(stillB, "setelah pindah halaman, sesi B masih terbuka (repro-kan bug: dulu kosong)");

    // --- 5. klik judul sesi A ---
    await p2.locator("#sessionHistory .history-row", { hasText: titleA })
      .locator("strong[role='button']").click();
    await p2.waitForFunction((expected) => {
      const sel = document.querySelector("#sessionHistory .history-row.is-selected");
      return sel !== null && sel.textContent.includes(expected);
    }, titleA, { timeout: 15000 });
    const movedA = await p2.evaluate((expected) => {
      const sel = document.querySelector("#sessionHistory .history-row.is-selected");
      return sel ? sel.textContent.includes(expected) : false;
    }, titleA);
    check(movedA, "klik judul baris memindahkan pilihan ke sesi A");

    const stored2 = await p2.evaluate(() =>
      sessionStorage.getItem("akademia.lectureLastSession"));
    const idA = dA.session_id;
    check(stored2 === idA, "sessionStorage ikut pindah ke A", String(stored2));

    // --- 6. bersih: hapus sesi uji ---
    for (const [id] of [[dA.session_id], [dB.session_id]]) {
      if (!id) continue;
      await context.request.delete(BASE + "/api/lecture/" + id + "/delete/");
    }

    const allErrors = [...consoleErrors, ...errs2];
    check(allErrors.length === 0, "tidak ada error JavaScript",
      allErrors.slice(0, 3).join(" | "));
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
