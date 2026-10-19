/**
 * Uji end-to-end Document Creator Akademia AI → backend FastAPI.
 *
 *   node test_document_creator_ui.js
 *
 * Prasyarat: Django one-day jalan di http://127.0.0.1:8010 dan backend
 * FastAPI student-assistant jalan di http://127.0.0.1:8002.
 */
const { chromium } = require("playwright");
const path = require("path");

const BASE = process.env.ONE_DAY_URL || "http://127.0.0.1:8010";
const SHOTS = path.join(__dirname, "screenshots");

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  const consoleErrors = [];
  const failedRequests = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("requestfailed", (r) =>
    failedRequests.push(`${r.method()} ${r.url()} — ${r.failure()?.errorText}`)
  );

  const step = (name) => console.log(`\n▶ ${name}`);

  // ---------------------------------------------------------------- load
  step("Buka halaman Document Creator");
  await page.goto(`${BASE}/document-creator/`, { waitUntil: "networkidle" });
  await page.screenshot({ path: path.join(SHOTS, "01-initial.png"), fullPage: true });
  console.log("  judul:", await page.title());

  // ------------------------------------------------------------- isi form
  step("Isi form");
  await page.selectOption("#docType", "Laporan akademik");
  await page.fill("#docTitle", "Laporan Praktikum Basis Data");
  await page.fill("#docSubject", "Basis Data");
  await page.fill(
    "#docDescription",
    "Buat laporan praktikum yang merangkum ERD, normalisasi, dan implementasi query JOIN pada sistem basis data relasional."
  );
  await page.selectOption("#docLanguage", "Bahasa Indonesia");
  await page.selectOption("#docLength", "Singkat");

  // ------------------------------------------------------------ generate
  step("Klik Buat Dokumen (menunggu LLM + render)");
  const started = Date.now();
  await page.click("button[type='submit']");
  await page.waitForSelector("#documentPreview.preview-result", { timeout: 240000 });
  console.log(`  selesai dalam ${((Date.now() - started) / 1000).toFixed(1)}s`);

  const title = await page.textContent("#documentPreview h2");
  const toast = await page.textContent("#toast");
  console.log("  judul dokumen :", title);
  console.log("  toast         :", (toast || "").trim());
  await page.screenshot({ path: path.join(SHOTS, "02-generated.png"), fullPage: true });

  // ------------------------------------------------------------- preview
  step("Klik Pratinjau");
  await page.click("button:has-text('Pratinjau')");
  await page.waitForSelector(".preview-frame", { timeout: 180000 });
  const frame = page.frameLocator(".preview-frame");
  const frameText = await frame.locator("body").innerText();
  console.log("  panjang teks pratinjau:", frameText.length, "karakter");
  console.log("  cuplikan           :", frameText.slice(0, 120).replace(/\s+/g, " "));
  await page.screenshot({ path: path.join(SHOTS, "03-preview.png"), fullPage: true });

  // ---------------------------------------------------------------- save
  step("Klik Simpan");
  await page.click("button:has-text('Simpan')");
  await page.waitForSelector("button:has-text('Tersimpan')", { timeout: 120000 });
  console.log("  status tombol Simpan:", (await page.textContent("button:has-text('Tersimpan')")).trim());

  // ------------------------------------------------------------ download
  step("Cek tombol Unduh aktif");
  const dl = page.locator("button:has-text('Unduh')");
  console.log("  enabled:", await dl.isEnabled());

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 120000 }),
    dl.click(),
  ]);
  console.log("  nama file:", download.suggestedFilename());
  const savedPath = path.join(SHOTS, download.suggestedFilename());
  await download.saveAs(savedPath);
  console.log("  tersimpan di:", savedPath);

  await page.screenshot({ path: path.join(SHOTS, "04-saved.png"), fullPage: true });

  // ------------------------------------------------------------- laporan
  console.log("\n=== RINGKASAN ===");
  console.log("console errors :", consoleErrors.length ? consoleErrors : "tidak ada");
  console.log("failed requests:", failedRequests.length ? failedRequests : "tidak ada");

  await browser.close();

  if (consoleErrors.length || failedRequests.length) process.exitCode = 1;
})().catch((err) => {
  console.error("\n✗ GAGAL:", err.message);
  process.exit(1);
});
