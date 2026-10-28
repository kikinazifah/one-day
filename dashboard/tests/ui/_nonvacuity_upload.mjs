#!/usr/bin/env node
/**
 * Bukti non-vacuity untuk `test_lecture_listener_upload.mjs`.
 *
 * Aturan README: "revert sementara fix-nya, pastikan test GAGAL, lalu
 * pasang lagi fix-nya."
 *
 * Fix di `lecture_listener.js` (unggahan tahan pindah halaman) punya
 * empat komponen yang bisa diuji terpisah:
 *
 *   A. `queueUpload()` menyimpan berkas ke IndexedDB **sebelum** request
 *      unggahan dikirim — tanpa ini berkas hilang saat reload.
 *   B. Halaman baru memanggil `resumePendingUpload()` setelah IndexedDB
 *      terbuka — tanpa ini unggahan tertunda menggantung selamanya.
 *   C. Catatan dibersihkan setelah unggahan sampai di server — tanpa ini
 *      reload berikutnya mengunggah dua kali.
 *   D. Menghapus sesi membuang catatan unggahannya — tanpa ini catatan
 *      yatim mencoba unggah ke sesi yang sudah 404.
 *
 * Script ini memulihkan file sumber byte-per-byte di akhir, jadi
 * menjalankannya tidak mengubah apa pun.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "../../static/dashboard/lecture_listener.js");

// File sumber memakai CRLF (Windows). Pencocokan blok dilakukan pada
// versi LF; file asli disimpan apa adanya dan dipulihkan byte per byte.
const ASLI = fs.readFileSync(SRC, "utf8");
const NORMAL = ASLI.replace(/\r\n/g, "\n");

function ganti(dari, ke) {
  if (!NORMAL.includes(dari)) {
    throw new Error("Blok yang akan di-revert tidak ditemukan:\n" + dari.slice(0, 160));
  }
  return NORMAL.replace(dari, ke);
}

// --- A: tidak menyimpan berkas sebelum dikirim ----------------------------
const REVERT_A = [
  [
    `  async function queueUpload(pending) {
    if (await stashPendingUpload(pending)) {
      rememberLastSession(pending.sessionId);
    }

    await processPendingUpload(pending);
  }`,
    `  async function queueUpload(pending) {
    await processPendingUpload(pending);
  }`,
  ],
];

// --- B: halaman baru tidak melanjutkan unggahan tertunda ------------------
const REVERT_B = [
  [
    `    await restored;
    await resumePendingUpload();`,
    `    await restored;`,
  ],
];

// --- C: catatan tidak dibersihkan setelah unggahan sampai -----------------
const REVERT_C = [
  [
    `      // Unggahan sudah sampai di server — kalau pindah halaman lagi di
      // tengah transkripsi, cukup polling ulang, tidak perlu upload ulang.
      await clearPendingUpload();

`,
    ``,
  ],
];

// --- D: menghapus sesi tidak membuang catatan unggahannya -----------------
const REVERT_D = [
  [
    `          // Sesi yang dihapus jangan meninggalkan unggahan tertunda —
          // reload berikutnya akan mencoba mengunggah ke sesi yang sudah
          // tidak ada (404) berulang-ulang.
          if (offlineStore?.available) {
            const pending = await offlineStore.getMeta();
            if (pending && pending.sessionId === session.id) {
              await offlineStore.clearMeta();
            }
          }

`,
    ``,
  ],
];

const KASUS = [
  { nama: "A — queueUpload tidak menyimpan berkas sebelum dikirim", patch: REVERT_A },
  { nama: "B — halaman baru tidak melanjutkan unggahan tertunda", patch: REVERT_B },
  { nama: "C — catatan tidak dibersihkan setelah unggahan sampai", patch: REVERT_C },
  { nama: "D — hapus sesi tidak membuang catatan unggahannya", patch: REVERT_D },
];

let cacah = 0;
const hasilPerKasus = [];

try {
  for (const kasus of KASUS) {
    let isi = ASLI;
    for (const [dari, ke] of kasus.patch) isi = ganti(dari, ke);

    fs.writeFileSync(SRC, isi, "utf8");

    let stdout = "";
    let kode = 0;
    try {
      stdout = execFileSync(
        process.execPath,
        [path.join(HERE, "test_lecture_listener_upload.mjs")],
        { encoding: "utf8", timeout: 60000 },
      );
    } catch (error) {
      stdout = (error.stdout || "") + (error.stderr || "");
      kode = error.status ?? 1;
    }

    fs.writeFileSync(SRC, ASLI, "utf8");

    const gagal = [...stdout.matchAll(/^\s*FAIL\s+(.+)$/gm)].map((m) => m[1].trim());
    const ringkas = (stdout.match(/PASS:\s*(\d+)\s+FAIL:\s*(\d+)/) || []).slice(1);
    const ok = gagal.length > 0 && kode !== 0;

    hasilPerKasus.push({ ...kasus, ok, gagal, ringkas });
    cacah++;

    console.log("=" + "=".repeat(72));
    console.log("REVERT " + kasus.nama);
    console.log("=" + "=".repeat(72));
    console.log(
      ringkas.length
        ? `  ringkasan: PASS ${ringkas[0]} / FAIL ${ringkas[1]}   (exit code ${kode})`
        : `  exit code ${kode}`,
    );
    if (gagal.length) {
      console.log("  test yang GAGAL (fix ini memang dikunci oleh test):");
      for (const g of gagal) console.log("    - " + g);
    } else {
      console.log("  !!! TIDAK ADA TEST YANG GAGAL — test ini VACUOUS !!!");
    }
    console.log("");
  }
} finally {
  // Jaring pengaman: file sumber WAJIB pulih, apa pun yang terjadi.
  fs.writeFileSync(SRC, ASLI, "utf8");
}

const pulih = fs.readFileSync(SRC, "utf8") === ASLI;

console.log("=".repeat(72));
const semuanyaEfektif = hasilPerKasus.every((h) => h.ok);
console.log(`Revert dilakukan: ${cacah} kasus`);
console.log(
  `Setiap revert membuat minimal satu test GAGAL: ${semuanyaEfektif ? "YA" : "TIDAK"}`,
);
console.log(`Fix asli dipulihkan utuh: ${pulih ? "YA" : "TIDAK"}`);

process.exit(semuanyaEfektif && pulih ? 0 : 1);
