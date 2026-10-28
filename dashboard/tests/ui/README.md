# Tes logika UI

Test di sini menjalankan **skrip aslinya** di Node, bukan menyalin
logikanya. `dom_shim.mjs` membuat DOM minimal, `harness.mjs` memuat skrip
ke dalam `node:vm` dengan `window.AkademiaApi` palsu, lalu tiap file
`test_*.mjs` memeriksa state hasilnya.

| File | Yang diuji |
|---|---|
| `test_rag_assistant.js` | `rag_assistant.js` — state chat & pencarian RAG |
| `test_lecture_ws.mjs` | `lecture_ws.js` — koneksi WebSocket rekaman kuliah |
| `test_lecture_listener_session.mjs` | `lecture_listener.js` — pemulihan sesi setelah reload navigasi |
| `test_lecture_listener_upload.mjs` | `lecture_listener.js` — unggahan berkas tahan pindah halaman |

## Jalankan

```bash
cd dashboard/tests/ui
node test_rag_assistant.mjs
node test_lecture_ws.mjs
```

Keluarannya: jumlah check PASS/FAIL. Keluar dengan kode bukan nol kalau ada
gagal, jadi bisa dipakai di CI.

## Kenapa bukan test browser

Bug yang pernah ditemukan di sini (tag mata kuliah hilang diam-diam,
balasan pencarian basi menimpa hasil baru, dua sesi chat dibuat untuk satu
percakapan) **tidak terlihat** kalau hanya membaca kodenya — semuanya butuh
waktu dan urutan pemanggilan yang salah. Menjalankan skrip aslinya dengan
API palsu membuat urutan itu bisa direproduksi.

Shim sengaja dibuat **minimal**: tujuannya menguji logika state, bukan
render. Elemen yang butuh semantik khusus (mis. `<select>` yang
menolak `value` yang tidak ada sebagai opsi) ditiru seperlunya.

## Tambah test

1. Tambah id elemen baru ke `IDS` di `harness.mjs`.
2. Tambah sekelompok kasus di `test_rag_assistant.mjs` — pakai `makeApi()`
   untuk membuat API palsu, `flush(ms)` untuk menunggu promise selesai.
3. **Buktikan test-nya tidak vacuous**: revert sementara fix-nya, pastikan
   test GAGAL, lalu pasang lagi fix-nya. Test yang selalu hijau tanpa
   dibuktikan begitu tidak menangkap apa pun.

## Bukti non-vacuity

`_nonvacuity.mjs` menjalankan aturan butir 3 secara otomatis untuk
`lecture_ws.js`: ia menonaktifkan **satu komponen fix** satu per satu,
menjalankan `test_lecture_ws.mjs`, lalu memastikan minimal satu test
GAGAL. File sumber dipulihkan byte per byte di akhir (ada jaring
pengaman `finally`), jadi menjalankan skrip ini tidak mengubah apa pun.

```bash
cd dashboard/tests/ui
node _nonvacuity.mjs
```

Keluarannya satu baris penentu:

```
Setiap revert membuat minimal satu test GAGAL: YA
Fix asli dipulihkan utuh: YA
```

Kalau baris pertama `TIDAK`, salah satu test-nya **vacuous** dan tidak
menangkap apa pun.

## Model penolakan WebSocket

`test_lecture_ws.mjs` meniru urutan penolakan **backend sungguhan**,
yang sudah dibuktikan dengan probe ASGI + Chromium:

```
accept()  →  frame {"type":"error", ...}  →  close(1008)
```

Jadi "handshake berhasil" **bukan** berarti "koneksi bisa dipakai".
Koneksi baru dianggap siap setelah frame `status` pertama diterima —
itulah yang menulis `reminder`/transkrip di sisi server. Skenario
"ditutup sebelum sempat terbuka" (jaringan mati) adalah kasus berbeda,
dan punya testnya sendiri.
