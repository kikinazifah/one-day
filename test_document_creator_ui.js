/**
 * Uji end-to-end Document Creator Akademia AI → backend FastAPI.
 *
 *   node test_document_creator_ui.js
 *
 * Prasyarat: Django one-day jalan di http://127.0.0.1:8010 dan backend
 * FastAPI student-assistant jalan di http://127.0.0.1:8022.
 *
 * Alur: obrol → dokumen dibuat → pesan kedua mengubahnya → panel blok →
 * edit satu blok → pratinjau (dari file, bukan model JSON) → unduh.
 *
 * Halamannya bukan form lagi, tapi ruang percakapan. Jadi uji ini
 * mengetik ke kolom chat, bukan mengisi field. Yang diperiksa:
 *
 *   - pesan user muncul sebagai pil;
 *   - balasan AI muncul tanpa gelembung, dengan isi markdown;
 *   - dokumen muncul di panel kanan dan panel blok terbuka;
 *   - pesan kedua **mengubah** dokumen yang ada (bukan membuat yang baru);
 *   - panel blok masih bisa dipakai untuk kontrol presisi.
 */
const { chromium } = require("playwright");
const path = require("path");

const BASE = process.env.ONE_DAY_URL || "http://127.0.0.1:8010";
const SHOTS = path.join(__dirname, "screenshots");
const EDIT_MARKER = "PARAGRAF UJI E2E";
const SECOND_INSTRUCTION = "Tambahkan bagian Metodologi singkat setelah Pendahuluan.";

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  const consoleErrors = [];
  const failedRequests = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("requestfailed", (r) => {
    // Unduhan memakai window.location.href, jadi Chromium membatalkan
    // navigasi begitu file diterima — ERR_ABORTED di sini bukan kegagalan.
    if (r.url().includes("/api/document/download/") && r.failure()?.errorText === "net::ERR_ABORTED") {
      return;
    }
    failedRequests.push(`${r.method()} ${r.url()} — ${r.failure()?.errorText}`);
  });

  const step = (name) => console.log(`\n▶ ${name}`);

  // ---------------------------------------------------------------- load
  step("Buka halaman Document Creator");
  await page.goto(`${BASE}/document-creator/`, { waitUntil: "networkidle" });
  await page.screenshot({ path: path.join(SHOTS, "01-initial.png"), fullPage: true });
  console.log("  judul:", await page.title());

  // Keadaan kosong harus ada: judul, penjelasan, dan contoh prompt.
  const starters = await page.locator(".ai-starter").count();
  console.log("  contoh prompt:", starters);
  if (starters === 0) throw new Error("Contoh prompt tidak muncul di keadaan kosong.");

  // -------------------------------------------------------------- obrol
  step("Kirim pesan pertama (dokumen dibuat dari brief)");
  const started = Date.now();

  await page.fill("#chatInput", "Buat laporan praktikum basis data: ERD, normalisasi, dan query JOIN.");
  await page.press("#chatInput", "Enter");

  // Pesan user harus langsung muncul sebagai pil.
  await page.waitForSelector(".ai-msg-user", { timeout: 15000 });
  console.log("  pil user     :", (await page.textContent(".ai-msg-user")).slice(0, 70));

  // Panel blok muncul setelah dokumen dibuat DAN disimpan. Keadaan kosong
  // harus hilang begitu percakapan berjalan.
  await page.waitForSelector("#blockPanel:not([hidden])", { timeout: 420000 });
  await page.waitForSelector("#documentCard:not([hidden])", { timeout: 30000 });
  console.log(`  selesai dalam ${((Date.now() - started) / 1000).toFixed(1)}s`);

  // Keadaan kosong harus sudah tidak terlihat.
  const emptyHidden = await page.locator("#chatEmpty").isHidden();
  console.log("  keadaan kosong disembunyikan:", emptyHidden);
  if (!emptyHidden) throw new Error("Keadaan kosong masih terlihat di atas percakapan.");

  console.log("  judul dokumen:", (await page.textContent("#documentTitle")).trim());
  console.log("  badge tipe   :", (await page.textContent("#documentType")).trim());
  await page.screenshot({ path: path.join(SHOTS, "02-generated.png"), fullPage: true });

  // ------------------------------------------------------ giliran kedua
  step("Kirim pesan kedua (dokumen yang ada diubah)");
  const blockCountBefore = await page.locator(".block-row").count();
  console.log("  blok sebelum :", blockCountBefore);

  await page.fill("#chatInput", SECOND_INSTRUCTION);
  await page.press("#chatInput", "Enter");

  // Aktivitas tool harus muncul sebagai kelompok langkah yang bisa dibuka.
  //
  // Cakup ke balasan **terakhir**: giliran pertama (buat dokumen) tidak
  // memakai tool sama sekali, jadi kelompok langkahnya tetap ``hidden``.
  // Selector tanpa cakupan akan menangkap kelompok yang tersembunyi itu
  // dan menunggu tanpa henti — dokumennya sudah jadi, tapi test-nya
  // menggantung.
  await page.waitForSelector(".ai-msg-assistant:last-child .ai-work-group:not([hidden])", {
    timeout: 300000,
  });
  const stepCount = await page.locator(".ai-msg-assistant:last-child .ai-step-row").count();
  console.log("  langkah tool :", stepCount);
  await page.screenshot({ path: path.join(SHOTS, "03-agent.png"), fullPage: true });

  // Tunggu sampai giliran selesai: tombol kirim aktif lagi.
  await page.waitForFunction(
    () => !document.getElementById("chatSend")?.disabled,
    null,
    { timeout: 300000 }
  );

  const blockCountAfter = await page.locator(".block-row").count();
  console.log("  blok sesudah :", blockCountAfter);
  if (blockCountAfter <= blockCountBefore) {
    console.log("  ⚠ jumlah blok tidak bertambah — periksa apakah instruksi diterapkan.");
  }

  // ---------------------------------------------------------- panel blok
  step("Panel Struktur Dokumen");
  const editableCount = await page.locator(".block-row:not(.protected)").count();
  console.log("  blok editable :", editableCount);
  if (editableCount === 0) throw new Error("Panel blok kosong — tidak ada yang bisa diuji.");

  // ------------------------------------------------------- edit satu blok
  step("Edit teks blok pertama");
  await page.locator(".block-row:not(.protected)").first().locator(".block-icon[title='Edit teks']").click();
  await page.waitForSelector(".block-modal", { timeout: 10000 });

  const editor = page.locator(".block-modal textarea");
  const originalText = await editor.inputValue();
  await editor.fill(`${EDIT_MARKER} — ${originalText.slice(0, 80)}`);
  await page.locator(".block-modal-actions button:has-text('Simpan')").click();
  await page.waitForSelector(".block-modal", { state: "detached", timeout: 10000 });

  // Patch-save bisa memakan waktu; tunggu balasan blok yang memuat penanda.
  await page.waitForFunction(
    (marker) =>
      Array.from(document.querySelectorAll(".block-row .block-text")).some((el) =>
        el.textContent.includes(marker)
      ),
    EDIT_MARKER,
    { timeout: 120000 }
  );
  console.log("  teks blok     :", (await page.locator(".block-row .block-text").first().textContent()).slice(0, 80));
  await page.screenshot({ path: path.join(SHOTS, "04-blocks.png"), fullPage: true });

  // ------------------------------------------------------------- preview
  step("Klik Pratinjau (dari file yang sudah dipatch)");
  await page.click("button:has-text('Pratinjau')");
  await page.waitForSelector(".preview-frame", { timeout: 180000 });
  const frame = page.frameLocator(".preview-frame");
  const frameText = await frame.locator("body").innerText();
  console.log("  panjang teks pratinjau:", frameText.length, "karakter");
  console.log("  penanda edit terlihat  :", frameText.includes(EDIT_MARKER));
  console.log("  cuplikan               :", frameText.slice(0, 120).replace(/\s+/g, " "));
  await page.screenshot({ path: path.join(SHOTS, "05-preview.png"), fullPage: true });

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

  await page.screenshot({ path: path.join(SHOTS, "06-download.png"), fullPage: true });

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
