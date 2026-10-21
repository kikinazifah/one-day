#!/usr/bin/env node
/**
 * Bukti non-vacuity untuk `test_lecture_ws.mjs`.
 *
 * Aturan README: "revert sementara fix-nya, pastikan test GAGAL, lalu
 * pasang lagi fix-nya."
 *
 * Fix di `lecture_ws.js` punya tiga komponen yang bisa diuji terpisah:
 *
 *   A. `connect()` resolve pada frame `status`, BUKAN pada `onopen`.
 *   B. `onclose` menutup promise (settleFail) — supaya tidak menggantung.
 *   C. Guard waktu 15 detik (readyTimeout) — server yang diam tidak
 *      boleh menggantung promise selamanya.
 *
 * Script ini applied balik seperti semula di akhir, jadi file sumber
 * tidak berubah.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "../../static/dashboard/lecture_ws.js");

// File sumber memakai CRLF (Windows). Pencocokan blok dilakukan pada
// versi LF; file asli disimpan apa adanya dan dipulihkan byte per byte.
const ASLI = fs.readFileSync(SRC, "utf8");
const NORMAL = ASLI.replace(/\r\n/g, "\n");

function ganti(dari, ke) {
  if (!NORMAL.includes(dari)) {
    throw new Error("Blok yang akan di-revert tidak ditemukan:\n" + dari.slice(0, 120));
  }
  return NORMAL.replace(dari, ke);
}

// --- A: resolve pada `onopen` (hanya handshake) ---------------------------
const REVERT_A = [
  [
    `        socket.onopen = () => {
          // Handshake berhasil — **belum** berarti koneksi siap dipakai.
          // Server masih bisa menolak sebentar lagi lewat frame
          // \`\`error\`\`. Jangan resolve di sini; tunggu frame \`\`status\`\`.
          this.onState("handshake");
        };`,
    `        socket.onopen = () => {
          this.connected = true;
          this.onState("connected");
          resolve();
        };`,
  ],
  [
    `          if (payload.type === "status" && !settled) {
            // Frame \`status\` **pertama** = server sudah memvalidasi
            // tiket dan sesi. Koneksi sekarang benar-benar bisa dipakai.
            settleOk();
          }

`,
    ``,
  ],
];

// --- B: onclose tidak menutup promise -------------------------------------
const REVERT_B = [
  [
    `          this.onState("disconnected");

          // Ditutup sebelum sempat terbuka → sambung gagal. Promise
          // harus tetap settle, kalau tidak pemanggilnya menggantung.
          if (!settled) {
            settleFail(
              new Error(
                "Koneksi WebSocket terputus sebelum terbuka" +
                  (event && event.code ? " (kode " + event.code + ")" : "")
              )
            );
          }`,
    `          this.onState("disconnected");`,
  ],
];

// --- C: tidak ada guard waktu ---------------------------------------------
const REVERT_C = [
  [
    `        readyTimer = setTimeout(() => {
          settleFail(
            new Error(
              "Server tidak mengonfirmasi koneksi dalam " +
                Math.round(this.readyTimeoutMs / 1000) +
                " detik."
            )
          );
        }, this.readyTimeoutMs);`,
    ``,
  ],
];

const KASUS = [
  { nama: "A — resolve di onopen (handshake saja dianggap siap)", patch: REVERT_A },
  { nama: "B — onclose tidak menutup promise", patch: REVERT_B },
  { nama: "C — tidak ada guard waktu", patch: REVERT_C },
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
      stdout = execFileSync(process.execPath, [path.join(HERE, "test_lecture_ws.mjs")], {
        encoding: "utf8",
        timeout: 60000,
      });
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
    console.log("=".repeat(72));
    console.log(
      ringkas.length
        ? `  ringkasan: PASS ${ringkas[0]} / FAIL ${ringkas[1]}   (exit code ${kode})`
        : `  exit code ${kode}`
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

// Pastikan file asli kembali utuh.
const pulih = fs.readFileSync(SRC, "utf8") === ASLI;

console.log("=".repeat(72));
const semuanyaEfektif = hasilPerKasus.every((h) => h.ok);
console.log(`Revert dilakukan: ${cacah} kasus`);
console.log(`Setiap revert membuat minimal satu test GAGAL: ${semuanyaEfektif ? "YA" : "TIDAK"}`);
console.log(`Fix asli dipulihkan utuh: ${pulih ? "YA" : "TIDAK"}`);

process.exit(semuanyaEfektif && pulih ? 0 : 1);
