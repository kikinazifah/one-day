/**
 * Harness: jalankan rag_assistant.js sungguhan di Node dengan DOM shim,
 * lalu periksa logika state-nya.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { buildDom, El } from "./dom_shim.mjs";

/** Akar repo one-day — path relatif dari file ini. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const IDS = [
  "ragFiles", "ragFileList", "ragQuestionForm", "chatMessages", "ragCourse",
  "ragSearch", "ragSearchNote", "ragRenameDialog", "ragRenameForm",
  "ragRenameName", "ragRenameCourse", "ragRenameError", "ragRenameCancel",
  "ragRenameSave", "ragTaskChips", "fileCount", "ragVectorCount", "questionCount",
  "ragQuestion", "ragFormatHint",
];

export function run({ api, sessionId = "" } = {}) {
  const { root, els } = buildDom(IDS);

  // --- sessionStorage shim ---
  const store = new Map();
  if (sessionId) store.set("akademia.ragSessionId", sessionId);
  const sessionStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  // --- document shim ---
  const doc = {
    getElementById: (id) => els[id] || null,
    createElement: (tag) => new El(tag),
    querySelector: (sel) => root.querySelector(sel),
    addEventListener: (type, fn) => {
      if (type === "DOMContentLoaded") pending.push(fn);
    },
  };

  const pending = [];

  /**
   * Timer interval yang bisa dikendalikan test.
   *
   * `setInterval` sungguhan akan membuat test berjalan tidak deterministik
   * (polling indexing berjalan sendiri di tengah assertion). Jadi interval
   * dicatat, dan test memanggil `tick()` sendiri untuk menjalankan satu
   * putaran callback.
   */
  const intervals = new Map();
  let nextTimerId = 1;

  const ctx = {
    document: doc,
    window: { AkademiaApi: api },
    sessionStorage,
    console,
    setInterval: (fn, ms) => {
      const id = nextTimerId++;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval: (id) => {
      intervals.delete(id);
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
    FormData: class {
      constructor() { this._d = {}; }
      append(k, v) { this._d[k] = v; }
    },
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    JSON,
    encodeURIComponent,
  };
  ctx.globalThis = ctx;

  const src = fs.readFileSync(
    path.join(ROOT, "dashboard/static/dashboard/rag_assistant.js"),
    "utf8",
  );
  vm.createContext(ctx);
  vm.runInContext(src, ctx);

  // jalankan DOMContentLoaded
  pending.forEach((fn) => fn());

  return {
    els,
    store,
    ctx,
    /** Berapa interval yang masih hidup. */
    intervalCount: () => intervals.size,
    /** Jalankan satu putaran callback semua interval yang masih hidup. */
    tick: async () => {
      for (const timer of [...intervals.values()]) {
        await timer.fn();
      }
    },
  };
}

/**
 * `loadDocuments()` dipanggil tanpa await di dalam DOMContentLoaded —
 * jadi render pertama terjadi sinkron, lalu data async menyusul. Helper ini
 * menunggu sampai settle supaya test bisa memeriksa state akhir.
 */
export async function settle(ms = 60) {
  await new Promise((r) => setTimeout(r, ms));
}

export function flush(ms = 50) {
  return new Promise((r) => setTimeout(r, ms));
}
