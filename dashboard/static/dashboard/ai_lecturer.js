document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("lecturerForm");
  const input = document.getElementById("lecturerInput");
  const chat = document.getElementById("lecturerChat");
  const clearButton = document.getElementById("clearLecturerChat");

  if (!form || !input || !chat) return;

  function addMessage(text, sender) {
    const message = document.createElement("div");
    message.className =
      sender === "user"
        ? "lecturer-message user"
        : "lecturer-message assistant";

    const content = document.createElement("p");
    content.textContent = text;

    message.append(content);
    chat.append(message);
    chat.scrollTop = chat.scrollHeight;
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    const question = input.value.trim();
    if (!question) return;

    addMessage(question, "user");

    addMessage(
      "Ini masih respons demo. Integrasi AI Dosen belum dihubungkan ke backend.",
      "assistant",
    );

    input.value = "";
    input.focus();
  });

  document.querySelectorAll("[data-prompt]").forEach((button) => {
    button.addEventListener("click", () => {
      input.value = button.dataset.prompt || "";
      input.focus();
    });
  });

  if (clearButton) {
    clearButton.addEventListener("click", () => {
      chat.replaceChildren();
    });
  }
});
