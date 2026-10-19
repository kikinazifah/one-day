/**
 * Document Creator — terhubung ke backend FastAPI (student-assistant)
 * lewat endpoint JSON Django (dashboard/views_api.py):
 *
 *   POST /api/document/generate/      → buat draft dokumen (LLM + render)
 *   POST /api/document/preview/       → render pratinjau HTML
 *   POST /api/document/save/          → simpan draft ke perpustakaan
 *   GET  /api/document/download/<id>  → unduh docx/pptx/xlsx/pdf
 *
 * Draft hasil generate belum tersimpan; tombol Unduh baru aktif setelah
 * dokumen disimpan (backend hanya bisa mengekspor dokumen yang punya id).
 */
document.addEventListener("DOMContentLoaded", () => {
  const documentForm = document.getElementById("documentForm");

  if (!documentForm) return;

  const preview = document.getElementById("documentPreview");
  const submitButton = documentForm.querySelector("button[type='submit']");
  const submitLabel = document.getElementById("docSubmitLabel");
  const csrfToken =
    documentForm.querySelector("input[name='csrfmiddlewaretoken']")?.value || "";

  // Draft hasil generate (belum tersimpan), versi tersimpannya, dan HTML
  // pratinjau terakhir. Pratinjau disimpan terpisah supaya tidak hilang
  // saat dokumen disimpan ke perpustakaan.
  let draft = null;
  let saved = null;
  let previewHtml = "";
  let previewMeta = "";
  let busy = false;

  // =====================================================
  // TOAST
  // =====================================================

  const toast = document.getElementById("toast");
  let toastTimeout;

  function showToast(message) {
    if (!toast) {
      console.info(message);
      return;
    }

    toast.textContent = message;
    toast.classList.add("visible");

    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove("visible"), 4000);
  }

  // =====================================================
  // HTTP
  // =====================================================

  async function postJson(url, body) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRFToken": csrfToken,
      },
      body: JSON.stringify(body),
    });

    let data = {};
    try {
      data = await response.json();
    } catch {
      // respons tanpa body JSON — pakai pesan default di bawah
    }

    if (!response.ok || data.ok === false) {
      throw new Error(data.error || "Permintaan gagal (" + response.status + ")");
    }
    return data;
  }

  // =====================================================
  // RENDER HASIL
  // =====================================================

  function setBusy(state, label) {
    busy = state;
    if (!submitButton) return;

    submitButton.disabled = state;

    const icon = submitButton.querySelector(".material-symbols-outlined");
    if (icon) {
      icon.textContent = state ? "progress_activity" : "auto_awesome";
      icon.classList.toggle("spin", state);
    }
    if (submitLabel) submitLabel.textContent = state ? label : "Buat Dokumen";
  }

  function actionButton(icon, label, variant) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = variant === "primary" ? "button-primary" : "ghost-button";

    const iconEl = document.createElement("span");
    iconEl.className = "material-symbols-outlined";
    iconEl.textContent = icon;

    button.append(iconEl, document.createTextNode(" " + label));
    return button;
  }

  function renderResult() {
    if (!preview || !draft) return;

    preview.className = "preview-result";
    preview.replaceChildren();

    // Judul + jenis dokumen
    const heading = document.createElement("h2");
    heading.textContent = draft.title || "Dokumen";

    const typeLine = document.createElement("p");
    const typeName = document.getElementById("docType")?.value || "";
    const subject = document.getElementById("docSubject")?.value.trim() || "";
    typeLine.textContent = typeName + (subject ? " • " + subject : "");

    const badge = document.createElement("span");
    badge.className = "badge blue";
    badge.textContent = (draft.type || "docx").toUpperCase();

    // Baris aksi: format + unduh + simpan + pratinjau
    const actions = document.createElement("div");
    actions.className = "preview-actions";

    const formatSelect = document.createElement("select");
    formatSelect.className = "form-control compact-control";
    ["docx", "pptx", "xlsx", "pdf"].forEach((format) => {
      const option = document.createElement("option");
      option.value = format;
      option.textContent = format.toUpperCase();
      formatSelect.append(option);
    });
    formatSelect.value = draft.type || "docx";

    const downloadButton = actionButton("download", "Unduh", "primary");
    downloadButton.disabled = !saved;
    downloadButton.title = saved ? "" : "Simpan dokumen dulu sebelum mengunduh";
    downloadButton.addEventListener("click", () => {
      if (!saved) {
        showToast("Simpan dokumen ke perpustakaan dulu sebelum mengunduh.");
        return;
      }
      window.location.href =
        "/api/document/download/" +
        encodeURIComponent(saved.id) +
        "?format=" +
        encodeURIComponent(formatSelect.value);
    });

    const saveButton = actionButton(
      saved ? "check_circle" : "bookmark_add",
      saved ? "Tersimpan" : "Simpan",
      "ghost"
    );
    saveButton.disabled = Boolean(saved);
    saveButton.addEventListener("click", saveDocument);

    const previewButton = actionButton("visibility", "Pratinjau", "ghost");
    previewButton.addEventListener("click", previewDocument);

    actions.append(formatSelect, downloadButton, saveButton, previewButton);

    // Catatan status + area pratinjau
    const note = document.createElement("p");
    note.className = "form-note";
    note.textContent = saved
      ? "Dokumen tersimpan di perpustakaan. Unduhan memakai judul dokumen."
      : "Dokumen belum disimpan. Simpan dulu agar bisa diunduh.";

    preview.append(heading, typeLine, badge, actions, note);

    if (previewHtml) {
      preview.append(buildPreviewFrame());
    }
  }

  // OfficeCLI menyuntikkan script-nya sendiri (KaTeX), jadi HTML dijalankan
  // di iframe ter-sandbox tanpa akses ke origin aplikasi.
  function buildPreviewFrame() {
    const frameWrap = document.createElement("div");
    frameWrap.className = "preview-frame-wrap";

    const frame = document.createElement("iframe");
    frame.className = "preview-frame";
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("title", "Pratinjau dokumen");
    frame.srcdoc = previewHtml;

    frameWrap.append(frame);

    if (previewMeta) {
      const meta = document.createElement("p");
      meta.className = "form-note";
      meta.textContent = previewMeta;
      frameWrap.append(meta);
    }
    return frameWrap;
  }

  // =====================================================
  // AKSI
  // =====================================================

  async function generateDocument() {
    if (busy) return;

    const title = document.getElementById("docTitle").value.trim();
    const type = document.getElementById("docType").value;
    const subject = document.getElementById("docSubject").value.trim();
    const description = document.getElementById("docDescription").value.trim();
    const language = document.getElementById("docLanguage").value;
    const length = document.getElementById("docLength").value;

    setBusy(true, "Membuat dokumen...");
    try {
      const data = await postJson("/api/document/generate/", {
        title,
        type,
        subject,
        description,
        language,
        length,
      });

      draft = data.document;
      saved = null;
      previewHtml = "";
      previewMeta = "";
      renderResult();
      showToast("Dokumen berhasil dibuat. Pratinjau atau simpan ke perpustakaan.");
    } catch (error) {
      showToast(error.message);
    } finally {
      setBusy(false, "");
    }
  }

  async function previewDocument() {
    if (!draft) return;

    const loading = document.createElement("p");
    loading.className = "form-note";
    loading.textContent = "Merender pratinjau...";

    const frameWrap = document.createElement("div");
    frameWrap.className = "preview-frame-wrap";
    frameWrap.append(loading);

    // Ganti area pratinjau lama dengan status "merender".
    const old = preview?.querySelector(".preview-frame-wrap");
    if (old) old.replaceWith(frameWrap);
    else preview?.append(frameWrap);

    try {
      const data = await postJson("/api/document/preview/", {
        documentId: draft.id,
        filePath: draft.filePath,
        type: draft.type,
        content: draft.content,
      });

      previewHtml = data.html || "";
      previewMeta =
        "Dirender sebagai " +
        String(data.format || "").toUpperCase() +
        " via " +
        (data.renderer || "renderer");

      frameWrap.replaceWith(buildPreviewFrame());
    } catch (error) {
      frameWrap.remove();
      showToast(error.message);
    }
  }

  async function saveDocument() {
    if (!draft || saved) return;

    try {
      const data = await postJson("/api/document/save/", {
        documentId: draft.id,
        title: draft.title,
        type: draft.type,
        content: draft.content,
        filePath: draft.filePath,
      });

      saved = data.document;
      renderResult();
      showToast("Dokumen tersimpan di perpustakaan.");
    } catch (error) {
      showToast(error.message);
    }
  }

  documentForm.addEventListener("submit", (event) => {
    event.preventDefault();
    generateDocument();
  });
});
