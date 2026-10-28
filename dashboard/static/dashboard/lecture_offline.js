/**
 * Buffer offline untuk potongan audio live (FR-05).
 *
 * Setiap potongan PCM yang direkam disimpan ke IndexedDB **sebelum**
 * dikirim. Kalau pengiriman gagal — atau perangkat sedang offline —
 * potongannya tetap tersimpan dan dikirim ulang nanti.
 *
 * Service Worker **tidak** dipakai. Repo ini tidak punya SW sama sekali
 * (kecuali notifikasi, yang punya kebutuhan sendiri), dan SW tidak
 * diperlukan untuk buffering antrean: IndexedDB di halaman sudah cukup,
 * dan menambah SW berarti menambah lifecycle cache/service-worker yang
 * harus ditangani (versi, aktivasi, bypass). Itu trade-off yang
 * disengaja.
 *
 * Kunci setiap potongan adalah "<sessionId>:<seq>" — jadi antrean untuk
 * beberapa sesi rekaman tidak saling bercampur, dan satu sesi bisa
 * di-resume setelah halaman dimuat ulang.
 */
(function (global) {
  "use strict";

  const DB_NAME = "akademia-lecture";
  const DB_VERSION = 1;
  const STORE_CHUNKS = "chunks";
  const STORE_META = "meta";

  /** Versi skema tersimpan di IndexedDB, supaya migrasi bisa dideteksi. */
  const SCHEMA_VERSION = 1;

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!global.indexedDB) {
        reject(new Error("IndexedDB tidak tersedia di browser ini."));
        return;
      }

      const request = global.indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;

        if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
          const store = db.createObjectStore(STORE_CHUNKS, { keyPath: "key" });
          store.createIndex("sessionId", "sessionId", { unique: false });
          store.createIndex("createdAt", "createdAt", { unique: false });
        }

        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: "key" });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  class OfflineChunkStore {
    constructor(db) {
      this.db = db;
      this.available = true;
      this.lastError = null;
    }

    /**
     * Buka store. Kalau IndexedDB tidak tersedia (mode privat ekstrem,
     * storage penuh, atau browser lawas), store jadi **pasif**: `available`
     * false dan semua operasi jadi no-op. Rekaman tetap jalan — hanya
     * kemampuan offline yang hilang.
     */
    static async open() {
      try {
        const db = await openDatabase();
        return new OfflineChunkStore(db);
      } catch (error) {
        const store = new OfflineChunkStore(null);
        store.available = false;
        store.lastError = error;
        return store;
      }
    }

    static key(sessionId, seq) {
      return sessionId + ":" + seq;
    }

    /**
     * Simpan satu potongan sebelum dikirim.
     *
     * Simpan-dulu-lalu-kirim itu penting: kalau tab ditutup di tengah
     * pengiriman, potongannya sudah aman di disk.
     */
    async put(sessionId, seq, bytes, rate) {
      if (!this.available) return false;

      try {
        const tx = this.db.transaction(STORE_CHUNKS, "readwrite");
        tx.objectStore(STORE_CHUNKS).put({
          key: OfflineChunkStore.key(sessionId, seq),
          sessionId,
          seq,
          rate,
          bytes,
          createdAt: Date.now(),
        });
        await txDone(tx);
        return true;
      } catch (error) {
        this.lastError = error;
        return false;
      }
    }

    /** Hapus satu potongan yang sudah berhasil terkirim. */
    async remove(sessionId, seq) {
      if (!this.available) return false;

      try {
        const tx = this.db.transaction(STORE_CHUNKS, "readwrite");
        tx.objectStore(STORE_CHUNKS).delete(OfflineChunkStore.key(sessionId, seq));
        await txDone(tx);
        return true;
      } catch (error) {
        this.lastError = error;
        return false;
      }
    }

    /** Semua potongan yang tertinggal untuk satu sesi, urut nomornya. */
    async list(sessionId) {
      if (!this.available) return [];

      try {
        const tx = this.db.transaction(STORE_CHUNKS, "readonly");
        const index = tx.objectStore(STORE_CHUNKS).index("sessionId");
        const request = index.getAll(sessionId);

        const rows = await new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
        });

        return rows.sort((a, b) => a.seq - b.seq);
      } catch (error) {
        this.lastError = error;
        return [];
      }
    }

    /** Semua sesi yang masih punya antrean tertinggal. */
    async sessions() {
      if (!this.available) return [];

      try {
        const tx = this.db.transaction(STORE_CHUNKS, "readonly");
        const request = tx.objectStore(STORE_CHUNKS).getAll();

        const rows = await new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error);
        });

        return [...new Set(rows.map((row) => row.sessionId))];
      } catch (error) {
        this.lastError = error;
        return [];
      }
    }

    /** Jumlah potongan tertinggal untuk satu sesi. */
    async count(sessionId) {
      const rows = await this.list(sessionId);
      return rows.length;
    }

    /**
     * Simpan satu nilai di store `meta` (kunci tunggal).
     *
     * Dipakai untuk unggahan berkas yang sedang berjalan: blob-nya
     * ditulis ke disk **sebelum** dikirim, jadi pindah halaman di tengah
     * unggahan membatalkan kirim — bukan menghapus berkasnya.
     */
    async putMeta(value) {
      if (!this.available) return false;

      try {
        const tx = this.db.transaction(STORE_META, "readwrite");
        tx.objectStore(STORE_META).put({ key: "pendingUpload", ...value });
        await txDone(tx);
        return true;
      } catch (error) {
        this.lastError = error;
        return false;
      }
    }

    /** Baca nilai dari store `meta`; `null` kalau tidak ada. */
    async getMeta() {
      if (!this.available) return null;

      try {
        const tx = this.db.transaction(STORE_META, "readonly");
        const request = tx.objectStore(STORE_META).get("pendingUpload");

        return await new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result || null);
          request.onerror = () => reject(request.error);
        });
      } catch (error) {
        this.lastError = error;
        return null;
      }
    }

    /** Hapus nilai dari store `meta` (mis. setelah unggahan tuntas). */
    async clearMeta() {
      if (!this.available) return;

      try {
        const tx = this.db.transaction(STORE_META, "readwrite");
        tx.objectStore(STORE_META).delete("pendingUpload");
        await txDone(tx);
      } catch (error) {
        this.lastError = error;
      }
    }

    /** Buang seluruh antrean satu sesi (mis. setelah sesi dihapus). */
    async clear(sessionId) {
      if (!this.available) return;

      try {
        const rows = await this.list(sessionId);
        const tx = this.db.transaction(STORE_CHUNKS, "readwrite");
        const store = tx.objectStore(STORE_CHUNKS);

        rows.forEach((row) => store.delete(row.key));

        await txDone(tx);
      } catch (error) {
        this.lastError = error;
      }
    }
  }

  global.LectureOffline = {
    OfflineChunkStore,
    DB_NAME,
    SCHEMA_VERSION,
  };
})(window);
