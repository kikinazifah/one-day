# Tes logika UI — `rag_assistant.js`

Test ini menjalankan **`rag_assistant.js` sungguhan** di Node, bukan
menyalin logikanya. `dom_shim.mjs` membuat DOM minimal, `harness.mjs`
memuat skrip ke dalam `node:vm` dengan `window.AkademiaApi` palsu, lalu
`test_rag_assistant.mjs` memeriksa state hasilnya.

## Jalankan

```bash
cd dashboard/tests/ui
node test_rag_assistant.mjs
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
