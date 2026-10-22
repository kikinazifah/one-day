/**
 * Document Creator — ruang chat untuk membuat dan mengubah dokumen.
 *
 * Dulu halaman ini punya form: isi lima field, tekan tombol, dapat satu
 * dokumen. Form itu hanya bisa membuat. Semua kebutuhan berikutnya —
 * "tambahkan bagian Metodologi", "perbaiki tabelnya", "buat lebih ringkas"
 * — adalah perubahan, dan perubahan tidak punya tempat di form.
 *
 * Sekarang satu ruang percakapan doing dua hal, dan backend yang memilih
 * mana yang berjalan:
 *
 *   belum ada dokumen  → pesannya *brief*; dokumen dibuat dari situ
 *   dokumen sudah ada  → pesannya *instruksi*; dokumennya yang diubah
 *
 * Frontend tidak perlu tahu bedanya. Dia hanya mengirim pesannya, lalu
 * menampilkan event yang datang: teks yang ditulis AI, tool yang jalan,
 * dan dokumen yang berubah.
 *
 * Endpoint (lewat BFF Django, token service tidak pernah ke browser):
 *
 *   POST /api/document/chat/          → SSE: giliran chat
 *   POST /api/document/preview/       → render pratinjau HTML
 *   GET  /api/document/blocks/<id>/   → daftar blok (panel struktur)
 *   PATCH /api/document/blocks/<id>/  → edit blok, byte-preserving
 *   GET  /api/document/download/<id>  → unduh docx
 */
document.addEventListener("DOMContentLoaded", () => {
  const chatForm = document.getElementById("chatForm");
  if (!chatForm) return;

  const messages = document.getElementById("chatMessages");
  const chatEmpty = document.getElementById("chatEmpty");
  const chatStarters = document.getElementById("chatStarters");
  const chatInput = document.getElementById("chatInput");
  const chatSend = document.getElementById("chatSend");
  const chatNote = document.getElementById("chatNote");
  const chatModeLabel = document.getElementById("chatModeLabel");
  const chatNewDocument = document.getElementById("chatNewDocument");

  const preview = document.getElementById("documentPreview");
  const documentCard = document.getElementById("documentCard");
  const documentTitle = document.getElementById("documentTitle");
  const documentType = document.getElementById("documentType");
  const documentActions = document.getElementById("documentActions");

  const blockPanel = document.getElementById("blockPanel");
  const blockList = document.getElementById("blockList");
  const blockEmpty = document.getElementById("blockEmpty");
  const blockRefresh = document.getElementById("blockRefresh");
  const qcList = document.getElementById("qcList");
  const qcEmpty = document.getElementById("qcEmpty");

  const csrfToken =
    chatForm.querySelector("input[name='csrfmiddlewaretoken']")?.value || "";

  // Dokumen yang sedang dibahas. ``id`` dipakai untuk giliran chat
  // berikutnya (dokumen ada → pesannya jadi instruksi).
  let current = null;
  let blocks = [];
  let busy = false;
  let previewHtml = "";
  let previewMeta = "";
  // Riwayat singkat untuk dikirim balik ke server, supaya konteks giliran
  // sebelumnya tidak hilang. Dibatasi: terlalu panjang justru membuat
  // permintaan melambat tanpa menambah konteks yang berguna.
  const history = [];

  // Generate dan agen bisa berjalan beberapa menit (LLM + render). Tanpa
  // batas, request yang macet menggantung selamanya dan tombolnya tidak
  // pernah aktif kembali.
  const TIMEOUT_DEFAULT_MS = 60000;
  const TIMEOUT_LONG_MS = 400000;

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
  // PESANAN AWAL
  // =====================================================

  // Contoh prompt. Mereka jadi tombol yang bisa diklik: mengisi chat
  // dengan kalimat yang benar-benar berguna lebih cepat daripada mengetik
  // dari nol.
  const STARTERS = [
    "Buat laporan praktikum normalisasi database dengan pembahasan 3NF",
    "Buat makalah tentang Literasi Digital di Universitas",
    "Buat proposal penelitian tentang dampak AI pada pembelajaran",
  ];

  function renderStarters() {
    if (!chatStarters) return;
    chatStarters.replaceChildren();
    STARTERS.forEach((text) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ai-starter";
      button.textContent = text;
      button.addEventListener("click", () => {
        if (busy) return;
        chatInput.value = text;
        chatInput.focus();
        chatForm.requestSubmit();
      });
      chatStarters.append(button);
    });
  }

  // =====================================================
  // GELUMBUNG CHAT
  // =====================================================

  // Para pesan assistant dan tool-nya dikelompokkan dalam satu blok, seperti
  // di GenOffice: teks jawaban dan aktivitas tool yang menghasilkan
  // jawaban itu adalah satu kesatuan, bukan dua pesan terpisah.
  function addUserMessage(text) {
    const message = document.createElement("div");
    message.className = "ai-msg ai-msg-user";
    message.textContent = text;
    messages.append(message);
    hideEmptyState();
    scrollToBottom();
  }

  // Keadaan kosong (judul + contoh prompt) hanya berlaku sampai
  // percakapan pertama. Setelah itu ia harus hilang — kalau tidak, contoh
  // promptnya tetap menggantung di atas pesan yang sudah berjalan.
  function hideEmptyState() {
    if (chatEmpty) chatEmpty.hidden = true;
  }

  function addAssistantTurn() {
    const message = document.createElement("div");
    message.className = "ai-msg ai-msg-assistant ai-msg-streaming";

    // Kelompok aktivitas tool: "Bekerja · N langkah", bisa dibuka.
    const work = document.createElement("div");
    work.className = "ai-work-group";
    work.hidden = true;

    // Body markdown jawabannya.
    const body = document.createElement("div");
    body.className = "ai-md";

    message.append(work, body);
    messages.append(message);
    hideEmptyState();
    scrollToBottom();

    return { message, work, body };
  }

  /**
   * Indikator "sedang berpikir".
   *
   * Bentuknya tiga titik yang berdenyut — sama seperti di GenOffice.
   * Elemennya terpisah dari body markdown, karena body itu milik
   * renderer: isinya diganti penuh setiap event ``text``.
   */
  function showTyping(target) {
    clearTyping(target);
    const typing = document.createElement("div");
    typing.className = "ai-typing";
    typing.setAttribute("aria-label", "Sedang berpikir");

    const label = document.createElement("span");
    label.textContent = "Berpikir...";

    const dots = document.createElement("span");
    dots.className = "ai-typing-dots";
    for (let index = 0; index < 3; index += 1) {
      const dot = document.createElement("span");
      dot.className = "ai-typing-dot";
      dots.append(dot);
    }

    typing.append(label, dots);
    target.append(typing);
  }

  function clearTyping(target) {
    target.querySelectorAll(".ai-typing").forEach((node) => node.remove());
  }

  /**
   * Kelompok aktivitas tool — versi GenOffice dari "Worked · N steps".
   *
   * @param {HTMLElement} container
   * @param {Array<object>} tools
   * @param {boolean} running
   */
  function renderWorkGroup(container, tools, running) {
    container.replaceChildren();
    if (!tools.length) {
      container.hidden = true;
      return;
    }
    container.hidden = false;

    const summary = document.createElement("button");
    summary.type = "button";
    summary.className = "ai-work-group-summary" + (running ? " running" : "");
    summary.setAttribute("aria-expanded", "false");

    if (running) {
      const spinner = document.createElement("span");
      spinner.className = "ai-tool-chip-spinner";
      spinner.setAttribute("aria-hidden", "true");
      summary.append(spinner);
    }

    const label = document.createElement("span");
    label.className = "ai-work-group-label";
    label.textContent = running
      ? "Bekerja..."
      : "Selesai · " + tools.length + " langkah";
    summary.append(label);

    const caret = document.createElement("span");
    caret.className = "ai-tool-chip-caret";
    caret.setAttribute("aria-hidden", "true");
    caret.textContent = "›";
    summary.append(caret);

    const body = document.createElement("div");
    body.className = "ai-work-group-body";
    const inner = document.createElement("div");
    inner.className = "ai-work-group-body-inner";
    body.append(inner);

    tools.forEach((tool) => {
      const row = document.createElement("div");
      row.className = "ai-step-row";

      const status = tool.running ? "running" : tool.isError ? "error" : "done";
      const icon = document.createElement("span");
      icon.className = "ai-step-icon " + status;
      icon.setAttribute("aria-hidden", "true");
      icon.textContent =
        status === "running" ? "⏳" : status === "error" ? "✕" : "✓";
      row.append(icon);

      const content = document.createElement("div");
      content.className = "ai-step-content";

      const title = document.createElement("span");
      title.className = "ai-step-title";
      title.textContent = tool.summary || tool.name;
      title.title = tool.name;
      content.append(title);

      // Output tool ditampilkan sebagai kartu mono, persis seperti di
      // GenOffice — ini yang bikin "kenapa dia melakukan itu" bisa
      // dijawab tanpa menebak.
      if (!tool.running && tool.output) {
        title.classList.add("clickable");
        const detail = document.createElement("div");
        detail.className = "ai-step-detail";
        const output = document.createElement("div");
        output.className = "ai-tool-output";
        const pre = document.createElement("div");
        pre.className = "ai-tool-output-pre";
        pre.textContent = tool.output;
        output.append(pre);
        detail.append(output);
        content.append(detail);
      }

      row.append(content);
      inner.append(row);
    });

    // Grup terbuka saat masih bekerja, tertutup setelah selesai — supaya
    // detailnya tidak memenuhi layar tapi tetap satu klik away.
    summary.addEventListener("click", () => {
      const open = body.classList.toggle("open");
      summary.setAttribute("aria-expanded", String(open));
      caret.classList.toggle("open", open);
    });

    container.append(summary, body);
    if (running) {
      body.classList.add("open");
      summary.setAttribute("aria-expanded", "true");
      caret.classList.add("open");
    }
  }

  function scrollToBottom() {
    if (!messages) return;
    messages.scrollTop = messages.scrollHeight;
  }

  // =====================================================
  // MENGIRIM PESAN
  // =====================================================

  async function sendMessage(text) {
    if (busy) return;

    const trimmed = (text || "").trim();
    if (!trimmed) return;

    busy = true;
    setBusy(true);

    addUserMessage(trimmed);

    // Riwayat yang dikirim ke server adalah **giliran-giliran sebelumnya**
    // saja. Server menambah pesan ini sendiri dari request; kalau
    // riwayatnya sudah memuat pesan ini, model akan melihat instruksinya
    // dua kali dan bisa mengira dia diminta mengulang.
    const previous = history.slice();
    history.push({ role: "user", content: trimmed });
    if (history.length > 20) history.shift();

    const turn = addAssistantTurn();
    const tools = [];
    let answer = "";

    try {
      await streamChat(trimmed, {
        onTurnStart: () => {
          // Belum ada teks dan belum ada tool: ini "sedang berpikir".
          showTyping(turn.body);
        },
        onText: (text) => {
          clearTyping(turn.body);
          window.AIMarkdown.update(turn.body, text);
          answer = text;
          scrollToBottom();
        },
        onToolStart: (tool) => {
          clearTyping(turn.body);
          tools.push(tool);
          renderWorkGroup(turn.work, tools, true);
          scrollToBottom();
        },
        onToolDone: (tool) => {
          clearTyping(turn.body);
          // ``tool_start`` dan ``tool_done`` datang sebagai objek yang
          // **berbeda** — keduanya di-parse dari event SSE masing-masing,
          // jadi ``entry === tool`` tidak pernah cocok. Akibatnya entri
          // lama tetap bertanda "running" dan kelompok langkah berhenti
          // di "Bekerja..." selamanya walau tool-nya sudah selesai.
          //
          // Yang stabil hanyalah nama tool, dan satu nama bisa dipakai
          // beberapa kali dalam satu giliran (mis. ``insert_blocks``
          // dipanggil dua kali). Karena itu yang diganti adalah entri
          // **terakhir yang masih running** dengan nama itu — sama
          // seperti cara server mencocokkannya.
          let index = -1;
          for (let i = tools.length - 1; i >= 0; i -= 1) {
            if (tools[i].name === tool.name && tools[i].running) {
              index = i;
              break;
            }
          }
          if (index >= 0) tools[index] = tool;
          else tools.push(tool);
          const anyRunning = tools.some((entry) => entry.running);
          renderWorkGroup(turn.work, tools, anyRunning);
          scrollToBottom();
        },
        onDocument: (document) => {
          applyDocument(document);
        },
        onDone: (event) => {
          clearTyping(turn.body);
          turn.message.classList.remove("ai-msg-streaming");

          // Dua jalur berbeda untuk isi balasan:
          //
          // - Giliran edit: teksnya sudah mengalir lewat event ``text``,
          //   jadi badannya sudah berisi jawabannya. ``done`` cuma
          //   menutup giliran.
          // - Giliran buat: tidak ada model turn yang mengalir — dokumen
          //   disusun sekali di belakang layar — jadi tidak ada event
          //   ``text`` sama sekali. Kalau isi ``done`` tidak dipakai,
          //   balasan AI-nya hilang dan yang tersisa cuma dokumen.
          //
          // Karena itu ``done`` dipakai hanya kalau badannya masih kosong.
          const finalText = event.text || event.message || "";
          if (!answer.trim() && finalText.trim()) {
            window.AIMarkdown.update(turn.body, finalText);
          }

          if (event.message) {
            history.push({ role: "assistant", content: event.message });
          }
        },
        onError: (message) => {
          turn.message.classList.remove("ai-msg-streaming");
          const error = document.createElement("div");
          error.className = "ai-msg-error";
          error.textContent = message;
          turn.message.append(error);
        },
      }, previous);
    } catch (error) {
      turn.message.classList.remove("ai-msg-streaming");
      const notice = document.createElement("div");
      notice.className = "ai-msg-error";
      notice.textContent = error.message || String(error);
      turn.message.append(notice);
    } finally {
      busy = false;
      setBusy(false);
      if (chatInput) {
        chatInput.value = "";
        chatInput.style.height = "auto";
      }
      scrollToBottom();
    }
  }

  /**
   * Baca SSE dari BFF Django.
   *
   * Server-Sent Events lewat ``EventSource`` tidak bisa mengirim body
   * POST, jadi stream-nya dibaca manual dari ``fetch``: body dikirim
   * sebagai POST, event-nya dibaca dari ``ReadableStream``.
   */
  async function streamChat(message, handlers, previous) {
    const payload = {
      message,
      documentId: current?.id || null,
      title: current?.title || null,
      language: "id",
      history: previous || [],
    };

    const response = await fetch("/api/document/chat/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRFToken": csrfToken,
        Accept: "text/event-stream",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok || !response.body) {
      let detail = "Permintaan gagal (" + response.status + ")";
      try {
        const data = await response.json();
        detail = data.error || data.detail || detail;
      } catch {
        /* respons tanpa body JSON */
      }
      throw new Error(detail);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Event SSE dipisahkan baris kosong.
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        handleSseChunk(chunk, handlers);
        boundary = buffer.indexOf("\n\n");
      }
    }
  }

  function handleSseChunk(chunk, handlers) {
    const lines = chunk.split("\n");
    let data = "";
    for (const line of lines) {
      if (line.startsWith("data:")) {
        data += line.slice(5).trim();
      }
    }
    if (!data || data === "[DONE]") return;

    let event;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }

    switch (event.type) {
      case "turn_start":
        handlers.onTurnStart?.(event);
        break;
      case "text":
        handlers.onText?.(event.text || "");
        break;
      case "tool_start":
        handlers.onToolStart?.({
          name: event.tool?.name || "",
          summary: event.tool?.summary || event.tool?.name || "",
          running: true,
        });
        break;
      case "tool_done":
        handlers.onToolDone?.({
          name: event.tool?.name || "",
          summary: event.tool?.summary || event.tool?.name || "",
          running: false,
          isError: Boolean(event.tool?.isError),
          output: event.tool?.output || "",
        });
        break;
      case "document":
        handlers.onDocument?.(event);
        break;
      case "done":
        handlers.onDone?.(event);
        break;
      case "error":
        handlers.onError?.(event.message || "Terjadi kesalahan.");
        break;
      default:
        break;
    }
  }

  function setBusy(state) {
    if (chatSend) chatSend.disabled = state;
    if (chatInput) chatInput.disabled = state;
    if (chatNewDocument) chatNewDocument.disabled = state;
  }

  // =====================================================
  // DOKUMEN
  // =====================================================

  function applyDocument(event) {
    const stored = event.document || {};

    current = {
      id: stored.id || current?.id || null,
      title: event.title || stored.title || current?.title || "Dokumen",
      type: event.docType || stored.type || "docx",
    };

    if (documentTitle) documentTitle.textContent = current.title;
    if (documentType) documentType.textContent = current.type.toUpperCase();
    if (documentCard) documentCard.hidden = false;
    if (preview) preview.hidden = true;

    if (chatModeLabel) {
      chatModeLabel.textContent = "Pesan berikutnya mengubah dokumen ini.";
    }
    if (chatNewDocument) chatNewDocument.hidden = false;

    // Simpan yang gagal tidak mematikan percakapan — dokumennya tetap ada
    // di memori, cuma tidak masuk perpustakaan. Tapi tanpa id, giliran
    // berikutnya tidak bisa mengeditnya, jadi itu harus disebut.
    if (stored.error) {
      showToast("Dokumen tidak bisa disimpan: " + stored.error);
    }

    renderBlocks(Array.isArray(event.blocks) ? event.blocks : []);
    renderIssues(Array.isArray(event.issues) ? event.issues : []);
    renderDocumentActions();
  }

  function renderDocumentActions() {
    if (!documentActions) return;
    documentActions.replaceChildren();

    if (!current || !current.id) return;

    const download = document.createElement("button");
    download.type = "button";
    download.className = "button-primary";
    download.innerHTML = "";
    const icon = document.createElement("span");
    icon.className = "material-symbols-outlined";
    icon.textContent = "download";
    download.append(icon, document.createTextNode(" Unduh"));
    download.addEventListener("click", () => {
      window.location.href =
        "/api/document/download/" + encodeURIComponent(current.id) + "?format=docx";
    });

    const previewButton = document.createElement("button");
    previewButton.type = "button";
    previewButton.className = "ghost-button";
    const previewIcon = document.createElement("span");
    previewIcon.className = "material-symbols-outlined";
    previewIcon.textContent = "visibility";
    previewButton.append(previewIcon, document.createTextNode(" Pratinjau"));
    previewButton.addEventListener("click", loadPreview);

    documentActions.append(download, previewButton);
  }

  // OfficeCLI memuat dokumen A4 (~794px) — lebih lebar dari panel dashboard.
  // Skrip miliknya sudah bisa menskalakan halaman, TAPI hanya di mode
  // normal: ia bisa salah baca `navigator.webdriver` sebagai mode screenshot,
  // dan mode itu memotong chrome dokumen.
  //
  // Karena iframe-nya ter-sandbox (tanpa allow-same-origin), parent tidak
  // bisa menyentuh DOM di dalamnya. Jadi penyesuaiannya di-inject ke dalam
  // srcdoc sebagai script yang berjalan di konteks iframe sendiri.
  const PREVIEW_FIX = `
<script>
(function () {
  try {
    Object.defineProperty(navigator, "webdriver", { get: function () { return false; } });
  } catch (e) {}

  function fit() {
    var pages = document.querySelectorAll(".page");
    if (!pages.length) return;
    var bodyStyle = getComputedStyle(document.body);
    var available =
      document.body.clientWidth -
      parseFloat(bodyStyle.paddingLeft) -
      parseFloat(bodyStyle.paddingRight);
    var pageWidth = pages[0].offsetWidth;
    if (!pageWidth || !available) return;

    var scale = Math.min(available / pageWidth, 1);
    if (scale >= 1) return;

    pages.forEach(function (page) {
      page.style.transform = "scale(" + scale + ")";
      page.style.transformOrigin = "left top";
    });
    document.querySelectorAll(".page-wrapper").forEach(function (wrapper) {
      wrapper.style.width = pageWidth * scale + "px";
    });
  }

  function scheduleFit() {
    setTimeout(fit, 150);
    setTimeout(fit, 600);
    window.addEventListener("resize", fit);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scheduleFit);
  } else {
    scheduleFit();
  }
})();
</script>`;

  function buildPreviewFrame() {
    const frameWrap = document.createElement("div");
    frameWrap.className = "preview-frame-wrap";

    const frame = document.createElement("iframe");
    frame.className = "preview-frame";
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("title", "Pratinjau dokumen");
    frame.srcdoc = injectPreviewFix(previewHtml);

    frameWrap.append(frame);

    if (previewMeta) {
      const meta = document.createElement("p");
      meta.className = "form-note";
      meta.textContent = previewMeta;
      frameWrap.append(meta);
    }
    return frameWrap;
  }

  // Sisipkan script perbaikan tepat sebelum </body> supaya berjalan setelah
  // style OfficeCLI dimuat tapi sebelum paginasi selesai.
  function injectPreviewFix(html) {
    if (!html) return html;
    if (html.includes("</body>")) {
      return html.replace("</body>", PREVIEW_FIX + "</body>");
    }
    return html + PREVIEW_FIX;
  }

  async function loadPreview() {
    if (!current?.id) return;

    const loading = document.createElement("p");
    loading.className = "form-note";
    loading.textContent = "Merender pratinjau...";

    if (preview) {
      preview.hidden = false;
      preview.replaceChildren(loading);
    }

    try {
      const data = await postJson(
        "/api/document/preview/",
        {
          documentId: current.id,
          type: current.type,
          preferFile: true,
        },
        TIMEOUT_LONG_MS
      );

      previewHtml = data.html || "";
      previewMeta =
        "Dirender sebagai " +
        String(data.format || "").toUpperCase() +
        " via " +
        (data.renderer || "renderer");

      if (preview) preview.replaceChildren(buildPreviewFrame());
    } catch (error) {
      if (preview) preview.replaceChildren();
      showToast(error.message);
    }
  }

  // =====================================================
  // PANEL BLOK
  // =====================================================

  // Tipe blok -> label yang bisa dibaca. Engine memakai nama tipe Inggris
  // (paragraph/heading/listItem/table); panel menunjukkan bahasa Indonesia.
  const BLOCK_LABELS = {
    heading: "Judul",
    paragraph: "Paragraf",
    listItem: "Daftar",
    table: "Tabel",
    image: "Gambar",
    passthrough: "Lainnya",
  };

  function blockLabel(block) {
    const base = BLOCK_LABELS[block.type] || block.type || "Blok";
    if (block.type === "heading" && block.level) return base + " " + block.level;
    if (block.type === "table" && block.label) return block.label;
    return base;
  }

  function blockText(block) {
    return (block.text || block.previewText || "").trim();
  }

  function renderBlocks(list) {
    blocks = Array.isArray(list) ? list : [];

    if (!blockList) return;

    blockList.replaceChildren();

    const hasBlocks = blocks.length > 0;
    if (blockEmpty) blockEmpty.hidden = hasBlocks;
    if (blockPanel) blockPanel.hidden = !(current && current.type === "docx");

    blocks.forEach((block, position) => {
      const item = document.createElement("li");
      item.className = "block-row";
      item.dataset.docxIndex = block.docxIndex ?? "";
      if (!block.editable) item.classList.add("protected");

      const top = document.createElement("div");
      top.className = "block-row-top";

      const index = document.createElement("span");
      index.className = "block-index";
      index.textContent = String(position + 1).padStart(2, "0");

      const type = document.createElement("span");
      type.className = "block-type";
      type.textContent = blockLabel(block);

      top.append(index, type);

      if (!block.editable) {
        const lock = document.createElement("span");
        lock.className = "block-lock";
        lock.textContent = "terproteksi";
        top.append(lock);
      }

      const text = document.createElement("p");
      text.className = "block-text";
      const content = blockText(block);
      text.textContent = content || "(kosong)";
      if (!content) text.classList.add("muted");

      item.append(top, text);

      // Aksi hanya untuk blok yang bisa ditulis ulang. Engine menolak
      // menulis ulang tabel/gambar/kontrol konten, jadi tombolnya tidak
      // ditampilkan — lebih baik daripada menawarkan sesuatu yang gagal.
      if (block.editable) {
        item.append(buildBlockActions(block, position));
      }

      blockList.append(item);
    });
  }

  function buildBlockActions(block, position) {
    const actions = document.createElement("div");
    actions.className = "block-actions";

    actions.append(iconButton("edit", "Edit teks", () => openBlockEditor(block)));

    if (block.type === "heading") {
      actions.append(levelSelect(block));
    }

    const up = iconButton("arrow_upward", "Naik", () => moveBlock(position, -1));
    up.disabled = position === 0;
    const down = iconButton("arrow_downward", "Turun", () => moveBlock(position, 1));
    down.disabled = position === blocks.length - 1;
    actions.append(up, down);

    const remove = iconButton("delete", "Hapus", () => deleteBlock(block));
    remove.classList.add("danger");
    actions.append(remove);

    return actions;
  }

  function iconButton(icon, label, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "block-icon";
    button.title = label;
    button.setAttribute("aria-label", label);

    const iconEl = document.createElement("span");
    iconEl.className = "material-symbols-outlined";
    iconEl.textContent = icon;

    button.append(iconEl);
    button.addEventListener("click", onClick);
    return button;
  }

  function levelSelect(block) {
    const select = document.createElement("select");
    select.className = "form-control block-level";
    select.title = "Level judul";

    for (let level = 1; level <= 6; level += 1) {
      const option = document.createElement("option");
      option.value = String(level);
      option.textContent = "H" + level;
      select.append(option);
    }
    select.value = String(block.level || 1);

    select.addEventListener("change", () => {
      applyOperations(
        [{ op: "setStyle", docxIndex: block.docxIndex, level: Number(select.value) }],
        "Level judul diubah."
      );
    });

    return select;
  }

  // --- modal edit teks -----------------------------------------------------

  let editorOverlay = null;

  function openBlockEditor(block) {
    closeBlockEditor();

    const overlay = document.createElement("div");
    overlay.className = "block-modal-overlay";

    const dialog = document.createElement("div");
    dialog.className = "block-modal";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");

    const title = document.createElement("h3");
    title.textContent = "Edit " + blockLabel(block).toLowerCase();

    const textarea = document.createElement("textarea");
    textarea.className = "form-control";
    textarea.rows = 6;
    textarea.value = blockText(block);

    const actions = document.createElement("div");
    actions.className = "block-modal-actions";

    const cancel = actionButton("close", "Batal", "ghost");
    cancel.addEventListener("click", closeBlockEditor);

    const apply = actionButton("check", "Simpan", "primary");
    apply.addEventListener("click", async () => {
      const text = textarea.value;
      closeBlockEditor();
      if (text.trim() === blockText(block)) return;
      await applyOperations(
        [{ op: "replaceText", docxIndex: block.docxIndex, text }],
        "Teks blok diubah."
      );
    });

    actions.append(cancel, apply);
    dialog.append(title, textarea, actions);
    overlay.append(dialog);

    // Klik di luar dialog menutup; klik di dalamnya tidak.
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeBlockEditor();
    });

    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeBlockEditor();
    });

    document.body.append(overlay);
    editorOverlay = overlay;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  function closeBlockEditor() {
    if (!editorOverlay) return;
    editorOverlay.remove();
    editorOverlay = null;
  }

  async function deleteBlock(block) {
    if (!window.confirm("Hapus blok ini dari dokumen?")) return;

    await applyOperations(
      [{ op: "delete", docxIndex: block.docxIndex }],
      "Blok dihapus."
    );
  }

  async function moveBlock(position, delta) {
    const target = position + delta;
    if (target < 0 || target >= blocks.length) return;

    const block = blocks[position];
    // ``toIndex`` adalah posisi akhir blok di daftar. Engine melepas blok
    // itu dulu, baru menyisipkan di indeks tersebut — jadi indeks tujuan
    // dihitung pada daftar final, bukan daftar yang masih memuat blok ini.
    const toIndex = target;

    await applyOperations(
      [{ op: "move", docxIndex: block.docxIndex, toIndex }],
      "Posisi blok diubah."
    );
  }

  async function applyOperations(operations, successMessage) {
    if (!current?.id || !operations.length) return;

    try {
      const data = await sendJson(
        "PATCH",
        "/api/document/blocks/" + encodeURIComponent(current.id) + "/",
        { operations },
        TIMEOUT_LONG_MS
      );

      // Balasan membawa blok terbaru; daftar lama tidak dipakai lagi.
      renderBlocks(Array.isArray(data.blocks) ? data.blocks : []);
      renderIssues(data.issues);

      // Engine melaporkan penolakan di ``log``, bukan sebagai error HTTP —
      // pengguna perlu tahu kalau editnya tidak terjadi.
      const refused = Array.isArray(data.log)
        ? data.log.filter((entry) => /skipped:|no editable block|does not contain/i.test(entry))
        : [];
      showToast(refused.length ? refused[0] : successMessage);
    } catch (error) {
      showToast(error.message);
    }
  }

  function renderIssues(issues) {
    const items = Array.isArray(issues) ? issues : [];

    if (qcList) {
      qcList.replaceChildren();
      qcList.hidden = items.length === 0;
      items.forEach((issue) => {
        const li = document.createElement("li");
        li.className = "qc-item " + (issue.severity || "warning");
        li.textContent = issue.message || String(issue);
        qcList.append(li);
      });
    }
    if (qcEmpty) qcEmpty.hidden = items.length > 0;
  }

  async function loadBlocks() {
    if (!current?.id || current.type !== "docx") {
      renderBlocks([]);
      return;
    }

    try {
      const data = await sendJson(
        "GET",
        "/api/document/blocks/" + encodeURIComponent(current.id) + "/",
        undefined,
        TIMEOUT_LONG_MS
      );
      renderBlocks(Array.isArray(data.blocks) ? data.blocks : []);
    } catch (error) {
      showToast(error.message);
    }
  }

  // =====================================================
  // HTTP
  // =====================================================

  function timeoutSignal(milliseconds) {
    // AbortSignal.timeout baru ada di browser modern; kalau tidak ada,
    // request berjalan tanpa batas seperti sebelumnya, bukan gagal.
    if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
      return AbortSignal.timeout(milliseconds);
    }
    return undefined;
  }

  async function sendJson(method, url, body, timeoutMs = TIMEOUT_DEFAULT_MS) {
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-CSRFToken": csrfToken,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: timeoutSignal(timeoutMs),
      });
    } catch (error) {
      if (error.name === "TimeoutError") {
        throw new Error("Permintaan terlalu lama — coba lagi.");
      }
      throw error;
    }

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

  function postJson(url, body, timeoutMs) {
    return sendJson("POST", url, body, timeoutMs);
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

  // =====================================================
  // AKSI
  // =====================================================

  chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    sendMessage(chatInput?.value);
  });

  // Enter mengirim, Shift+Enter memecah baris.
  chatInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      chatForm.requestSubmit();
    }
  });

  // Textarea tumbuh mengikuti isinya, sampai batas yang wajar.
  chatInput?.addEventListener("input", () => {
    chatInput.style.height = "auto";
    chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + "px";
  });

  // "Dokumen baru"(): mengosongkan ikatan, jadi pesan berikutnya jadi
  // brief lagi dan dokumen baru dibuat. Percakapan yang sudah ada tetap
  // di layar — hanya dokumen aktif yang dilepas.
  chatNewDocument?.addEventListener("click", () => {
    current = null;
    blocks = [];
    // Riwayat ikut dibuang: dokumen yang baru adalah percakapan yang baru.
    // Kalau riwayatnya tetap ada, model akan bringkasan "yang tadi" dari
    // dokumen yang sudah tidak terkait.
    history.length = 0;
    if (documentCard) documentCard.hidden = true;
    if (preview) {
      preview.hidden = false;
      preview.replaceChildren();
    }
    if (blockPanel) blockPanel.hidden = true;
    if (chatModeLabel) {
      chatModeLabel.textContent = "Tulis apa yang kamu mau — dokumen dibuat dari sana.";
    }
    if (chatNewDocument) chatNewDocument.hidden = true;
    renderIssues([]);
    showToast("Dokumen baru akan dibuat dari pesan berikutnya.");
  });

  blockRefresh?.addEventListener("click", loadBlocks);

  // =====================================================
  // DRAFT DARI HALAMAN LAIN
  // =====================================================

  // Lecture Listener (FR-05) menaruh transkrip + ringkasan di sessionStorage
  // lalu mengarahkan ke halaman ini. Isi kolom chat supaya pengguna tidak
  // perlu menyalin manual.
  const storedDraft = sessionStorage.getItem("akademia.documentDraft");

  if (storedDraft) {
    sessionStorage.removeItem("akademia.documentDraft");

    try {
      const incoming = JSON.parse(storedDraft);
      const summary = [incoming.title, incoming.description]
        .filter(Boolean)
        .join(". ");

      if (summary && chatInput) {
        chatInput.value = summary;
        chatInput.dispatchEvent(new Event("input"));
        chatInput.focus();
      }

      showToast("Draft transkrip dimuat. Tekan Enter untuk membuat dokumen.");
    } catch (error) {
      console.warn("Draft dari halaman lain gagal dimuat:", error);
    }
  }

  renderStarters();
});
