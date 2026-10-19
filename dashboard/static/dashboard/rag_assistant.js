document.addEventListener("DOMContentLoaded", () => {
  const fileInput = document.getElementById("ragFiles");
  const fileList = document.getElementById("ragFileList");

  let selectedFiles = [];

  function renderFiles() {
    if (!fileList) return;

    fileList.replaceChildren();

    if (!selectedFiles.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state compact-empty";

      const icon = document.createElement("span");
      icon.className = "material-symbols-outlined";
      icon.textContent = "folder_off";

      const text = document.createElement("p");
      text.textContent = "Belum ada dokumen yang dipilih.";

      empty.append(icon, text);
      fileList.append(empty);
    } else {
      selectedFiles.forEach((file, index) => {
        const row = document.createElement("div");
        row.className = "file-row";

        const icon = document.createElement("span");
        icon.className = "material-symbols-outlined";
        icon.textContent = "description";

        const details = document.createElement("div");
        details.className = "file-details";

        const name = document.createElement("strong");
        name.textContent = file.name;

        const size = document.createElement("small");
        size.textContent =
          (file.size / 1024).toFixed(1) + " KB • belum diproses";

        details.append(name, size);

        const remove = document.createElement("button");
        remove.className = "icon-button";
        remove.type = "button";
        remove.setAttribute("aria-label", "Hapus " + file.name);
        remove.textContent = "×";

        remove.addEventListener("click", () => {
          selectedFiles.splice(index, 1);
          renderFiles();
        });

        row.append(icon, details, remove);
        fileList.append(row);
      });
    }

    const count = document.getElementById("fileCount");
    if (count) count.textContent = selectedFiles.length;
  }

  if (fileInput) {
    fileInput.addEventListener("change", () => {
      const incoming = Array.from(fileInput.files || []);
      const allowed = incoming.filter((file) =>
        /\.(pdf|txt)$/i.test(file.name),
      );

      selectedFiles = selectedFiles.concat(allowed);
      renderFiles();

      fileInput.value = "";
    });

    renderFiles();
  }

  const questionForm = document.getElementById("ragQuestionForm");

  if (questionForm) {
    questionForm.addEventListener("submit", (event) => {
      event.preventDefault();

      const input = document.getElementById("ragQuestion");
      const question = input?.value.trim();

      if (!question) return;

      const messages = document.getElementById("chatMessages");

      if (!messages) return;

      const userMessage = document.createElement("div");
      userMessage.className = "user-message";
      userMessage.textContent = question;

      const reply = document.createElement("div");
      reply.className = "assistant-message";

      const avatar = document.createElement("span");
      avatar.className = "chat-avatar material-symbols-outlined";
      avatar.textContent = "smart_toy";

      const body = document.createElement("div");

      const title = document.createElement("strong");
      title.textContent = "Akademia AI";

      const text = document.createElement("p");
      text.textContent = selectedFiles.length
        ? "Dokumen sudah terpilih, tetapi pemrosesan dan jawaban AI belum dihubungkan ke backend."
        : "Pilih dokumen terlebih dahulu. Backend RAG belum terhubung sehingga aku belum bisa mencari jawaban dari berkas.";

      body.append(title, text);
      reply.append(avatar, body);

      messages.append(userMessage, reply);
      messages.scrollTop = messages.scrollHeight;

      const questionCount = document.getElementById("questionCount");

      if (questionCount) {
        questionCount.textContent = Number(questionCount.textContent) + 1;
      }

      input.value = "";
    });
  }
});
