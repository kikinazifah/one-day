/**
 * Test logika UI rag_assistant.js — menjalankan kode sungguhan dengan
 * DOM shim + API palsu yang bisa dikontrol.
 */
import { run, flush } from "./harness.mjs";

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; failures.push(name + " " + extra); console.log("  FAIL  " + name + " " + extra); }
}

function makeApi(overrides = {}) {
  const calls = [];
  const state = {
    documents: [],
    courses: [],
    searchResult: [],
    calls,
  };
  const api = {
    state,
    get: async (url) => {
      calls.push(["GET", url]);
      if (url.includes("/api/courses/")) return { courses: state.courses };
      // Urutan penting: "search" harus dicek SEBELUM pola {id}.
      if (url.includes("/rag/documents/search/")) {
        return { total: state.searchResult.length, documents: state.searchResult };
      }
      if (url.includes("/api/rag/documents/")) {
        // Sisa setelah prefix menentukan daftar vs detail.
        const rest = url.split("/api/rag/documents/")[1];
        if (rest === "" || rest === "?") return { documents: state.documents };
        const id = rest.split("/")[0];
        const doc = state.documents.find((d) => d.id === id);
        return { document: doc || {} };
      }
      if (url.includes("/api/rag/chat/")) {
        if (url.includes("/message/")) return { answer: "jawaban", sources: [], confidence: 0.5, kind: "document" };
        return { messages: [] };
      }
      return {};
    },
    post: async (url, body) => {
      calls.push(["POST", url, body]);
      if (url.includes("/sessions/create/")) return { session: { id: "SESI-BARU" } };
      if (url.includes("/message/")) return { answer: "jawaban", sources: [], confidence: 0.5, kind: "document" };
      if (url.includes("/delete/")) return { ok: true };
      if (url.includes("/upload/")) return { document: { id: "DOC-1", fileName: "a.txt", status: "uploaded" } };
      return {};
    },
    patch: async (url, body) => {
      calls.push(["PATCH", url, body]);
      const id = url.split("/api/rag/documents/")[1].split("/")[0];
      return {
        document: {
          id,
          fileName: body.display_name,
          courseId: body.course_id || null,
          status: "indexed",
        },
      };
    },
    upload: async (url, form) => {
      calls.push(["UPLOAD", url, form._d]);
      return { document: { id: "DOC-1", fileName: "a.txt", status: "uploaded" } };
    },
  };
  return Object.assign(api, overrides);
}

/**
 * Baris dokumen punya anak: [icon, details, badge, edit(BUTTON), unduh(A),
 * hapus(BUTTON)]. Ambil tombol lewat tag, bukan posisi, supaya test tidak
 * rapuh saat urutan anak berubah.
 */
function buttonsOf(row) {
  return (row.children || []).filter((c) => c.tagName === "BUTTON");
}
function editButton(row) {
  return buttonsOf(row)[0];
}
function removeButton(row) {
  return buttonsOf(row)[buttonsOf(row).length - 1];
}
function docRows(els) {
  return els.ragFileList.children.filter((c) => (c.children || []).length > 2);
}
function nameOf(row) {
  return row.children[1].children[0].textContent;
}
function metaOf(row) {
  return row.children[1].children[1].textContent;
}

console.log("\n=== A. State allDocuments vs documents ===");

{
  const api = makeApi();
  api.state.documents = [
    { id: "D1", fileName: "satu.txt", status: "indexed", chunksCount: 3 },
    { id: "D2", fileName: "dua.txt", status: "uploaded" },
  ];
  const { els } = run({ api });
  await flush(120);
  check("daftar awal ter-render", els.ragFileList.children.length === 2, String(els.ragFileList.children.length));
  check("fileCount = jumlah dokumen", els.fileCount.textContent === "2", els.fileCount.textContent);
  check("ragVectorCount = jumlah indexed", els.ragVectorCount.textContent === "1", els.ragVectorCount.textContent);
}

console.log("\n=== B. Search: mode switch ===");
{
  const api = makeApi();
  api.state.documents = [{ id: "D1", fileName: "satu.txt", status: "indexed" }];
  api.state.searchResult = [{ id: "D9", fileName: "hasil.txt", status: "indexed", matchType: "content", matchCount: 3 }];
  const { els } = run({ api });
  await flush(150);

  els.ragSearch.value = "normalisasi";
  els.ragSearch.dispatch("input");
  await flush(300);

  check("mode search aktif: hanya hasil search yang tampil",
    els.ragFileList.children.length === 1, String(els.ragFileList.children.length));
  check("searchNote tampil", els.ragSearchNote.hidden === false);
  check("fileCount = jumlah hasil", els.fileCount.textContent === "1", els.fileCount.textContent);
  check("ragVectorCount tetap hitung semua dokumen",
    els.ragVectorCount.textContent === "1", els.ragVectorCount.textContent);
  const label = metaOf(els.ragFileList.children[0]);
  check("label matchType ditampilkan", label.includes("Cocok pada isi"), label);
  check("matchCount ditampilkan", label.includes("(3)"), label);

  // kosongkan lagi
  els.ragSearch.value = "";
  els.ragSearch.dispatch("input");
  await flush(300);
  check("kembali ke daftar semua saat kotak dikosongkan",
    els.ragFileList.children.length === 1 && els.ragSearchNote.hidden === true,
    String(els.ragFileList.children.length));
}

console.log("\n=== C. Delete: dua daftar harus ikut dibersihkan ===");
{
  const api = makeApi();
  api.state.documents = [
    { id: "D1", fileName: "satu.txt", status: "indexed" },
    { id: "D2", fileName: "dua.txt", status: "indexed" },
  ];
  const { els } = run({ api });
  await flush(150);

  // klik tombol hapus pada baris pertama
  const row = els.ragFileList.children[0];
  removeButton(row).dispatch("click");
  await flush(50);

  check("sisa 1 baris setelah delete", els.ragFileList.children.length === 1,
    String(els.ragFileList.children.length));
  check("fileCount ikut turun", els.fileCount.textContent === "1", els.fileCount.textContent);
}

console.log("\n=== D. Rename: dialog + update state ===");
{
  const api = makeApi();
  api.state.documents = [{ id: "D1", fileName: "satu.txt", status: "indexed", courseId: null }];
  const { els } = run({ api });
  await flush(150);

  // buka dialog lewat tombol edit
  const row = els.ragFileList.children[0];
  editButton(row).dispatch("click");
  check("dialog terbuka", els.ragRenameDialog.open === true);
  check("nama terisi di input", els.ragRenameName.value === "satu.txt", els.ragRenameName.value);

  els.ragRenameName.value = "Nama Baru";
  els.ragRenameCourse.value = "";
  els.ragRenameForm.dispatch("submit", { preventDefault() {} });
  await flush(80);

  const shown = nameOf(els.ragFileList.children[0]);
  check("nama baru tampil di daftar", shown === "Nama Baru", shown);
  check("dialog tertutup setelah simpan", els.ragRenameDialog.open === false);
}

console.log("\n=== E. Rename: error tidak menutup dialog ===");
{
  const api = makeApi();
  api.patch = async () => { throw new Error("Gagal menyimpan"); };
  api.state.documents = [{ id: "D1", fileName: "satu.txt", status: "indexed" }];
  const { els } = run({ api });
  await flush(150);

  const row = els.ragFileList.children[0];
  editButton(row).dispatch("click");
  els.ragRenameName.value = "X";
  els.ragRenameForm.dispatch("submit", { preventDefault() {} });
  await flush(80);

  check("dialog tetap terbuka saat gagal", els.ragRenameDialog.open === true);
  check("error ditampilkan", els.ragRenameError.hidden === false && els.ragRenameError.textContent.includes("Gagal"),
    els.ragRenameError.textContent);
  check("tombol simpan di-enable lagi", els.ragRenameSave.disabled === false);
}

console.log("\n=== F. Rename: nama kosong ditolak ===");
{
  const api = makeApi();
  api.state.documents = [{ id: "D1", fileName: "satu.txt", status: "indexed" }];
  const { els } = run({ api });
  await flush(150);
  const row = els.ragFileList.children[0];
  editButton(row).dispatch("click");
  els.ragRenameName.value = "   ";
  els.ragRenameForm.dispatch("submit", { preventDefault() {} });
  await flush(80);

  check("error nama kosong tampil", els.ragRenameError.hidden === false, els.ragRenameError.textContent);
  check("dialog tetap terbuka", els.ragRenameDialog.open === true);
}

console.log("\n=== G. Upload: placeholder diganti dokumen asli ===");
{
  const api = makeApi();
  const { els } = run({ api });
  await flush(150);

  const f = { name: "catatan.txt" };
  els.ragFiles.files = [f];
  els.ragFiles.dispatch("change");
  await flush(80);

  check("satu baris setelah upload", els.ragFileList.children.length === 1,
    String(els.ragFileList.children.length));
  const shown = nameOf(els.ragFileList.children[0]);
  check("nama dokumen asli tampil", shown === "a.txt", shown);
}

console.log("\n=== H. Upload gagal: placeholder dibuang ===");
{
  const api = makeApi();
  api.upload = async () => { throw new Error("Server tidak merespons"); };
  const { els } = run({ api });
  await flush(150);
  els.ragFiles.files = [{ name: "gagal.txt" }];
  els.ragFiles.dispatch("change");
  await flush(80);

  check("placeholder dibuang setelah gagal", docRows(els).length === 0,
    String(docRows(els).length));
  check("pesan error tampil", els.chatMessages.children.some((c) => c.textContent.includes("Server tidak merespons")));
}

console.log("\n=== I. Format tidak didukung ditolak ===");
{
  const api = makeApi();
  const baseGet = api.get;
  // Daftar format datang dari server — tanpa itu UI tidak tahu format mana
  // yang didukung, dan semua berkas diteruskan ke server.
  api.get = async (url) => {
    if (url.includes("/api/rag/formats/")) {
      api.state.calls.push(["GET", url]);
      return { formats: [".pdf", ".docx", ".txt", ".md", ".csv", ".html"] };
    }
    return baseGet(url);
  };
  const { els } = run({ api });
  await flush(200);
  els.ragFiles.files = [{ name: "gambar.png" }];
  els.ragFiles.dispatch("change");
  await flush(80);

  check("tidak ada dokumen ditambahkan", docRows(els).length === 0);
  check("pesan format ditolak", els.chatMessages.children.some((c) => c.textContent.includes("Format berkas tidak didukung")));
}

console.log("\n=== J. Task chip mengisi dan mengirim ===");
{
  const api = makeApi();
  const { els } = run({ api });
  await flush(150);

  // buat chip palsu
  const chip = new (Object.getPrototypeOf(els.ragTaskChips).constructor)("button");
  chip.className = "rag-chip";
  chip.textContent = "Tugas apa saja yang belum selesai?";
  chip.closest = (sel) => (sel === ".rag-chip" ? chip : null);
  els.ragTaskChips.dispatch("click", { target: chip });
  await flush(80);

  const posted = api.state.calls.find((c) => c[0] === "POST" && String(c[1]).includes("/message/"));
  check("pertanyaan chip terkirim", !!posted, JSON.stringify(api.state.calls.map((c) => c[1])));
  check("teks chip dipakai", posted && posted[2].question === "Tugas apa saja yang belum selesai?",
    posted ? posted[2].question : "-");
}

console.log("\n=== K. ensureSession memakai sesi yang ada ===");
{
  const api = makeApi();
  const { els, store } = run({ api, sessionId: "SESI-LAMA" });
  await flush(150);

  els.ragQuestion.value = "pertanyaan uji";
  els.ragQuestionForm.dispatch("submit", { preventDefault() {} });
  await flush(120);

  const posted = api.state.calls.find((c) => c[0] === "POST" && String(c[1]).includes("/message/"));
  check("pesan dikirim ke sesi yang tersimpan",
    posted && String(posted[1]).includes("SESI-LAMA"), posted ? posted[1] : "-");
  check("tidak membuat sesi baru",
    !api.state.calls.some((c) => String(c[1]).includes("/sessions/create/")),
    JSON.stringify(api.state.calls.map((c) => c[1])));
}

console.log("\n=== L. ensureSession: sesi mati -> dibuat baru ===");
{
  const api = makeApi();
  api.get = async (url) => {
    if (url.includes("/api/rag/chat/") && !url.includes("/message/")) throw new Error("404");
    return {};
  };
  const { els, store } = run({ api, sessionId: "SESI-MATI" });
  await flush(150);

  els.ragQuestion.value = "pertanyaan uji";
  els.ragQuestionForm.dispatch("submit", { preventDefault() {} });
  await flush(150);

  const posted = api.state.calls.find((c) => c[0] === "POST" && String(c[1]).includes("/message/"));
  check("sesi baru dibuat", api.state.calls.some((c) => String(c[1]).includes("/sessions/create/")));
  check("pesan dikirim ke sesi baru", posted && String(posted[1]).includes("SESI-BARU"), posted ? posted[1] : "-");
  check("sessionStorage diperbarui", store.get("akademia.ragSessionId") === "SESI-BARU",
    store.get("akademia.ragSessionId"));
}

console.log("\n=== M. Load history: pesan lama tanpa kind ===");
{
  const api = makeApi();
  api.get = async (url) => {
    if (url.includes("/api/rag/chat/") && !url.includes("/message/")) {
      return { messages: [
        { role: "user", content: "pertanyaan lama" },
        { role: "assistant", content: "jawaban lama", sources: [], kind: "document" },
      ] };
    }
    return {};
  };
  const { els } = run({ api, sessionId: "SESI-HISTORI" });
  await flush(120);

  const rendered = els.chatMessages.children.map((c) => c.textContent);
  check("pesan user dirender", rendered.some((t) => t.includes("pertanyaan lama")), JSON.stringify(rendered));
  check("pesan assistant dirender", rendered.some((t) => t.includes("jawaban lama")), JSON.stringify(rendered));
  check("questionCount = jumlah pertanyaan user", els.questionCount.textContent === "1",
    els.questionCount.textContent);
}

console.log("\n=== N. Rename tidak melepas tag saat daftar mata kuliah gagal dimuat ===");
{
  const api = makeApi();
  api.get = async (url) => {
    if (url.includes("/api/courses/")) throw new Error("Jaringan gagal");
    if (url.includes("/api/rag/documents/")) {
      const rest = url.split("/api/rag/documents/")[1];
      if (rest === "") {
        return { documents: [{ id: "D1", fileName: "satu.txt", status: "indexed", courseId: "c1" }] };
      }
      return { document: {} };
    }
    return {};
  };
  api.patch = async (url, body) => {
    api.state.calls.push(["PATCH", url, body]);
    return { document: { id: "D1", fileName: body.display_name } };
  };
  const { els } = run({ api });
  await flush(150);

  const row = docRows(els)[0];
  editButton(row).dispatch("click");
  await flush(30);

  els.ragRenameName.value = "Nama Baru";
  els.ragRenameForm.dispatch("submit", { preventDefault() {} });
  await flush(80);

  const patched = api.state.calls.find((c) => c[0] === "PATCH");
  check("course_id tidak ikut dikirim saat daftar mk gagal dimuat",
    patched && !("course_id" in patched[2]),
    JSON.stringify(patched ? patched[2] : null));
  check("pengguna diberi tahu tag tidak diubah",
    els.ragRenameError.hidden === false && els.ragRenameError.textContent.includes("tag"),
    els.ragRenameError.textContent);
}

console.log("\n=== O. Rename tetap bisa melepas tag saat daftar mk dimuat ===");
{
  const api = makeApi();
  api.state.courses = [{ id: "c1", code: "IF201", name: "Basis Data" }];
  api.state.documents = [{ id: "D1", fileName: "satu.txt", status: "indexed", courseId: "c1" }];
  const { els } = run({ api });
  await flush(150);

  const row = docRows(els)[0];
  editButton(row).dispatch("click");
  await flush(30);
  check("dropdown terisi dari daftar mata kuliah",
    els.ragRenameCourse.children.length === 2, String(els.ragRenameCourse.children.length));
  check("tag dokumen terpilih di dropdown",
    els.ragRenameCourse.value === "c1", els.ragRenameCourse.value);

  // pengguna sengaja melepas tag
  els.ragRenameCourse.value = "";
  els.ragRenameName.value = "Nama Baru";
  els.ragRenameForm.dispatch("submit", { preventDefault() {} });
  await flush(80);

  const patched = api.state.calls.find((c) => c[0] === "PATCH");
  check("course_id kosong terkirim saat pengguna melepas tag",
    patched && patched[2].course_id === "",
    JSON.stringify(patched ? patched[2] : null));
}

console.log("\n=== R. loadHistory tidak menghapus sesi yang baru dibuat ===");
{
  let creates = 0;
  let chatGets = 0;
  const api = makeApi();
  api.get = async (url) => {
    if (url.includes("/api/courses/")) return { courses: [] };
    if (url.includes("/api/rag/documents/")) {
      const rest = url.split("/api/rag/documents/")[1];
      return rest === "" ? { documents: [] } : { document: {} };
    }
    if (url.includes("/api/rag/chat/")) {
      // GET #1 = loadHistory (lambat, selesai belakangan)
      // GET #2 = ensureSession (cepat, selesai lebih dulu)
      chatGets += 1;
      await new Promise((r) => setTimeout(r, chatGets === 1 ? 600 : 50));
      throw new Error("404 sesi hilang");
    }
    return {};
  };
  api.post = async (url, body) => {
    api.state.calls.push(["POST", url, body]);
    if (url.includes("/sessions/create/")) {
      creates += 1;
      return { session: { id: "SESI-" + creates } };
    }
    if (url.includes("/message/")) {
      return { answer: "JAWABAN-" + creates, sources: [], confidence: 0.5, kind: "document" };
    }
    return {};
  };
  const { els, store } = run({ api, sessionId: "SESI-MATI" });
  await flush(20);

  els.ragQuestion.value = "p1";
  els.ragQuestionForm.dispatch("submit", { preventDefault() {} });
  await flush(900);

  check("hanya satu sesi dibuat", creates === 1, String(creates));
  check("sesi yang baru dibuat tidak dihapus loadHistory",
    store.get("akademia.ragSessionId") === "SESI-1",
    String(store.get("akademia.ragSessionId")));
}

console.log("\n=== S. loadHistory tidak menimpa pesan live ===");
{
  const api = makeApi();
  api.get = async (url) => {
    if (url.includes("/api/courses/")) return { courses: [] };
    if (url.includes("/api/rag/documents/")) {
      const rest = url.split("/api/rag/documents/")[1];
      return rest === "" ? { documents: [] } : { document: {} };
    }
    if (url.includes("/api/rag/chat/")) {
      await new Promise((r) => setTimeout(r, 200));   // riwayat lambat
      return {
        messages: [
          { role: "user", content: "pertanyaan lama" },
          { role: "assistant", content: "jawaban lama", sources: [], kind: "document" },
        ],
      };
    }
    return {};
  };
  api.post = async (url, body) => {
    api.state.calls.push(["POST", url, body]);
    if (url.includes("/sessions/create/")) return { session: { id: "SESI-1" } };
    if (url.includes("/message/")) {
      await new Promise((r) => setTimeout(r, 120));  // jawaban lambat
      return { answer: "JAWABAN-AKTUAL", sources: [], confidence: 0.5, kind: "document" };
    }
    return {};
  };
  const { els } = run({ api, sessionId: "SESI-1" });
  await flush(20);

  els.ragQuestion.value = "pertanyaan baru";
  els.ragQuestionForm.dispatch("submit", { preventDefault() {} });
  await flush(600);

  const rendered = els.chatMessages.children.map((c) => c.textContent);
  check("jawaban yang baru tetap tampil",
    rendered.some((t) => t.includes("JAWABAN-AKTUAL")), JSON.stringify(rendered));
  check("pertanyaan baru tidak ditimpa riwayat lama",
    !rendered.some((t) => t.includes("pertanyaan lama")), JSON.stringify(rendered));
  check("counter tidak mundur", els.questionCount.textContent === "1",
    els.questionCount.textContent);
}

console.log("\n=== T. Polling bertahan dari error sementara ===");
{
  let calls = 0;
  const api = makeApi();
  api.get = async (url) => {
    if (url.includes("/api/courses/")) return { courses: [] };
    if (url.includes("/api/rag/documents/")) {
      const rest = url.split("/api/rag/documents/")[1];
      if (rest === "") {
        return { documents: [{ id: "D1", fileName: "satu.txt", status: "uploaded" }] };
      }
      calls += 1;
      if (calls === 1) throw new Error("502 Bad Gateway");   // transient
      return { document: { id: "D1", fileName: "satu.txt", status: "indexed" } };
    }
    return {};
  };
  const { els, intervalCount, tick } = run({ api });
  await flush(120);
  check("polling aktif setelah load", intervalCount() === 1, String(intervalCount()));

  await tick();
  await flush(50);
  check("polling tidak mati saat error sementara", intervalCount() === 1,
    String(intervalCount()));

  await tick();
  await flush(50);
  check("dokumen jadi terindeks setelah error sempat muncul",
    docRows(els)[0].children[2].textContent === "Terindeks",
    docRows(els)[0].children[2].textContent);
}

console.log("\n=== U. Badge di hasil pencarian ikut disegarkan ===");
{
  const api = makeApi();
  api.get = async (url) => {
    if (url.includes("/api/courses/")) return { courses: [] };
    if (url.includes("/rag/documents/search/")) {
      return { total: 1, documents: [{ id: "D1", fileName: "satu.txt", status: "uploaded" }] };
    }
    if (url.includes("/api/rag/documents/")) {
      const rest = url.split("/api/rag/documents/")[1];
      if (rest === "") {
        return { documents: [{ id: "D1", fileName: "satu.txt", status: "uploaded" }] };
      }
      return { document: { id: "D1", fileName: "satu.txt", status: "indexed" } };
    }
    return {};
  };
  const { els, tick } = run({ api });
  await flush(120);
  els.ragSearch.value = "satu";
  els.ragSearch.dispatch("input");
  await flush(350);
  check("badge awal masih menunggu indeks",
    docRows(els)[0].children[2].textContent === "Menunggu indeks",
    docRows(els)[0].children[2].textContent);

  await tick();
  await flush(50);
  check("badge di hasil pencarian disegarkan setelah indexing selesai",
    docRows(els)[0].children[2].textContent === "Terindeks",
    docRows(els)[0].children[2].textContent);
}

console.log("\n=== V. Balasan rename basi tidak menutup dialog lain ===");
{
  const api = makeApi();
  api.state.documents = [
    { id: "D1", fileName: "satu.txt", status: "indexed" },
    { id: "D2", fileName: "dua.txt", status: "indexed" },
  ];
  api.patch = async (url, body) => {
    api.state.calls.push(["PATCH", url, body]);
    await new Promise((r) => setTimeout(r, 150));   // PATCH lambat
    const id = url.split("/api/rag/documents/")[1].split("/")[0];
    return { document: { id, fileName: body.display_name, status: "indexed" } };
  };
  const { els } = run({ api });
  await flush(150);

  editButton(docRows(els)[0]).dispatch("click");
  els.ragRenameName.value = "Nama Satu Baru";
  els.ragRenameForm.dispatch("submit", { preventDefault() {} });
  await flush(20);

  // pengguna pindah ke dokumen kedua sebelum balasan pertama datang
  editButton(docRows(els)[1]).dispatch("click");
  check("dialog dokumen kedua terbuka",
    els.ragRenameDialog.open === true && els.ragRenameName.value === "dua.txt",
    els.ragRenameName.value);

  await flush(300);
  check("dialog dokumen kedua tetap terbuka setelah balasan pertama datang",
    els.ragRenameDialog.open === true);
  check("nama dokumen pertama tetap terupdate di daftar",
    nameOf(docRows(els)[0]) === "Nama Satu Baru", nameOf(docRows(els)[0]));
  check("nama dokumen kedua tidak ikut berubah",
    nameOf(docRows(els)[1]) === "dua.txt", nameOf(docRows(els)[1]));
}

console.log("\n=== W. Pencarian yang gagal tidak menyisakan hasil basi ===");
{
  let fail = false;
  const api = makeApi();
  api.get = async (url) => {
    if (url.includes("/api/courses/")) return { courses: [] };
    if (url.includes("/rag/documents/search/")) {
      if (fail) throw new Error("502 Bad Gateway");
      return { total: 1, documents: [{ id: "D1", fileName: "lama.txt", status: "indexed" }] };
    }
    if (url.includes("/api/rag/documents/")) {
      const rest = url.split("/api/rag/documents/")[1];
      return rest === "" ? { documents: [] } : { document: {} };
    }
    return {};
  };
  const { els } = run({ api });
  await flush(120);

  els.ragSearch.value = "lama";
  els.ragSearch.dispatch("input");
  await flush(350);
  check("hasil pertama tampil", docRows(els).length === 1, String(docRows(els).length));

  fail = true;
  els.ragSearch.value = "lain";
  els.ragSearch.dispatch("input");
  await flush(350);
  check("hasil lama dibuang saat pencarian gagal", docRows(els).length === 0,
    String(docRows(els).length));
  check("catatan menjelaskan kegagalan",
    els.ragSearchNote.textContent.includes("gagal"), els.ragSearchNote.textContent);
}

console.log("\n=== X. Rename: tag yang tidak ada di dropdown tidak ikut dilepas ===");
{
  const api = makeApi();
  api.state.courses = [{ id: "c1", code: "IF201", name: "Basis Data" }];
  api.state.documents = [{ id: "D1", fileName: "satu.txt", status: "indexed", courseId: "c-hilang" }];
  const { els } = run({ api });
  await flush(150);

  editButton(docRows(els)[0]).dispatch("click");
  await flush(30);
  check("dropdown tidak punya tag yang hilang", els.ragRenameCourse.value === "",
    els.ragRenameCourse.value);

  els.ragRenameName.value = "Nama Baru";
  els.ragRenameForm.dispatch("submit", { preventDefault() {} });
  await flush(80);

  const patched = api.state.calls.find((c) => c[0] === "PATCH");
  check("course_id tidak dikirim saat tag tak ada di dropdown",
    patched && !("course_id" in patched[2]),
    JSON.stringify(patched ? patched[2] : null));
}

console.log("\n=== Y. Dokumen yang diunggah saat load tidak hilang ===");
{
  const api = makeApi();
  let release;
  const gate = new Promise((r) => (release = r));
  api.get = async (url) => {
    if (url.includes("/api/courses/")) return { courses: [] };
    if (url.includes("/api/rag/documents/")) {
      const rest = url.split("/api/rag/documents/")[1];
      if (rest === "") {
        await gate;                       // daftar awal lambat
        return { documents: [] };
      }
      return { document: {} };
    }
    return {};
  };
  api.upload = async () => ({ document: { id: "DOC-1", fileName: "baru.txt", status: "uploaded" } });
  const { els } = run({ api });

  // unggah selagi daftar awal masih berjalan
  els.ragFiles.files = [{ name: "baru.txt" }];
  els.ragFiles.dispatch("change");
  await flush(80);
  release();
  await flush(150);

  check("dokumen hasil upload tetap ada setelah daftar awal dimuat",
    docRows(els).some((r) => nameOf(r) === "baru.txt"),
    docRows(els).map((r) => nameOf(r)).join(", "));
}

console.log("\n=== P. Pencarian: balasan basi diabaikan ===");
{
  const api = makeApi();
  api.get = async (url) => {
    if (url.includes("/api/courses/")) return { courses: [] };
    if (url.includes("/rag/documents/search/")) {
      const q = decodeURIComponent(url.split("q=")[1]);
      // "a" lambat (700ms), "ab" cepat (10ms) -> "a" selesai belakangan.
      await new Promise((r) => setTimeout(r, q === "a" ? 700 : 10));
      return { total: 1, documents: [{ id: "R-" + q, fileName: q + ".txt", status: "indexed" }] };
    }
    if (url.includes("/api/rag/documents/")) {
      const rest = url.split("/api/rag/documents/")[1];
      if (rest === "") return { documents: [] };
      return { document: {} };
    }
    return {};
  };
  const { els } = run({ api });
  await flush(120);

  els.ragSearch.value = "a";
  els.ragSearch.dispatch("input");
  await flush(300);            // debounce -> request "a" jalan
  els.ragSearch.value = "ab";
  els.ragSearch.dispatch("input");
  await flush(1200);           // "ab" selesai dulu, lalu "a" selesai belakangan

  const rows = docRows(els);
  check("hasil lama tidak menimpa hasil baru",
    rows.length === 1 && nameOf(rows[0]) === "ab.txt",
    rows.map((r) => nameOf(r)).join(", "));
  check("catatan hasil menyebut kueri terbaru",
    els.ragSearchNote.textContent.includes("ab"), els.ragSearchNote.textContent);
}

console.log("\n=== Q. Dua pertanyaan bersamaan -> satu sesi saja ===");
{
  let creates = 0;
  const api = makeApi();
  api.get = async (url) => {
    if (url.includes("/api/courses/")) return { courses: [] };
    if (url.includes("/api/rag/documents/")) {
      const rest = url.split("/api/rag/documents/")[1];
      return rest === "" ? { documents: [] } : { document: {} };
    }
    if (url.includes("/api/rag/chat/")) {
      await new Promise((r) => setTimeout(r, 40));
      throw new Error("404 sesi hilang");
    }
    return {};
  };
  api.post = async (url, body) => {
    api.state.calls.push(["POST", url, body]);
    if (url.includes("/sessions/create/")) {
      creates += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { session: { id: "SESI-" + creates } };
    }
    if (url.includes("/message/")) {
      return { answer: "ok", sources: [], confidence: 0.5, kind: "document" };
    }
    return {};
  };
  const { els, store } = run({ api, sessionId: "SESI-MATI" });
  await flush(150);

  els.ragQuestion.value = "p1";
  els.ragQuestionForm.dispatch("submit", { preventDefault() {} });
  els.ragQuestion.value = "p2";
  els.ragQuestionForm.dispatch("submit", { preventDefault() {} });
  await flush(400);

  check("hanya satu sesi dibuat", creates === 1, String(creates));
  const posted = api.state.calls.filter(
    (c) => c[0] === "POST" && String(c[1]).includes("/message/"),
  );
  check(
    "kedua pertanyaan dikirim ke sesi yang sama",
    posted.length === 2 && posted.every((p) => String(p[1]).includes("SESI-1")),
    JSON.stringify(posted.map((p) => p[1])),
  );
  check(
    "sessionStorage menyimpan satu sesi",
    store.get("akademia.ragSessionId") === "SESI-1",
    store.get("akademia.ragSessionId"),
  );
}

console.log("\n=== Z. Format berkas mengikuti daftar dari server ===");
{
  const api = makeApi();
  // Backend menerima jauh lebih banyak format daripada UI yang dulu
  // hardcode (9 format) — .tsv/.yaml/.py di antara lain.
  api.get = async (url) => {
    if (url.includes("/api/rag/formats/")) {
      return {
        formats: [".pdf", ".docx", ".txt", ".md", ".csv", ".tsv", ".yaml", ".html", ""],
        // Backend juga mengirim string `accept` siap pakai.
        accept: ".pdf,.docx,.txt,.md,.csv,.tsv,.yaml,.html",
      };
    }
    if (url.includes("/api/courses/")) return { courses: [] };
    if (url.includes("/api/rag/documents/")) {
      const rest = url.split("/api/rag/documents/")[1];
      return rest === "" ? { documents: [] } : { document: {} };
    }
    return {};
  };
  api.upload = async (url, form) => {
    api.state.calls.push(["UPLOAD", url, form._d]);
    return { document: { id: "D1", fileName: form._d.file.name, status: "uploaded" } };
  };
  const { els } = run({ api });
  await flush(200);

  check("atribut accept di input berkas terisi",
    String(els.ragFiles.attributes.accept || "").includes(".tsv"),
    String(els.ragFiles.attributes.accept));
  check("atribut accept memakai format titik (bukan 'tsv' polos)",
    String(els.ragFiles.attributes.accept || "").split(",").every((p) => p.startsWith(".")),
    String(els.ragFiles.attributes.accept));
  check("atribut accept tidak memuat ekstensi kosong",
    !String(els.ragFiles.attributes.accept || "").split(",").includes(""),
    String(els.ragFiles.attributes.accept));
  check("petunjuk format di drop-zone mengikuti daftar server",
    String(els.ragFormatHint.textContent || "").includes("TSV")
      && !String(els.ragFormatHint.textContent || "").includes(", ,"),
    String(els.ragFormatHint.textContent));

  // format yang DULU ditolak UI tapi backend bisa
  els.ragFiles.files = [{ name: "data.tsv" }];
  els.ragFiles.dispatch("change");
  await flush(100);
  check("format .tsv diterima (dulu ditolak UI)",
    docRows(els).some((r) => nameOf(r) === "data.tsv"),
    docRows(els).map((r) => nameOf(r)).join(", "));

  // format yang benar-benar tidak didukung
  els.ragFiles.files = [{ name: "gambar.png" }];
  els.ragFiles.dispatch("change");
  await flush(100);
  check("format .png tetap ditolak",
    !docRows(els).some((r) => nameOf(r) === "gambar.png"),
    docRows(els).map((r) => nameOf(r)).join(", "));
}

console.log("\n=== AA. Format tetap bisa diunggah saat daftar format gagal dimuat ===");
{
  const api = makeApi();
  api.get = async (url) => {
    if (url.includes("/api/rag/formats/")) throw new Error("502 Bad Gateway");
    if (url.includes("/api/courses/")) return { courses: [] };
    if (url.includes("/api/rag/documents/")) {
      const rest = url.split("/api/rag/documents/")[1];
      return rest === "" ? { documents: [] } : { document: {} };
    }
    return {};
  };
  api.upload = async (url, form) => {
    api.state.calls.push(["UPLOAD", url, form._d]);
    return { document: { id: "D1", fileName: form._d.file.name, status: "uploaded" } };
  };
  const { els } = run({ api });
  await flush(200);

  els.ragFiles.files = [{ name: "catatan.md" }];
  els.ragFiles.dispatch("change");
  await flush(100);
  check("berkas tetap terkirim saat daftar format gagal dimuat",
    docRows(els).some((r) => nameOf(r) === "catatan.md"),
    docRows(els).map((r) => nameOf(r)).join(", "));
}

console.log("\n" + "=".repeat(50));
console.log(`  PASS: ${pass}    FAIL: ${fail}`);
if (failures.length) {
  console.log("\nGagal:");
  failures.forEach((f) => console.log("  - " + f));
}
process.exit(fail ? 1 : 0);
