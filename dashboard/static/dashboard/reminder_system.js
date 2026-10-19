document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("reminderForm");
  const list = document.getElementById("reminderList");

  if (!form || !list) return;

  let total = 3;
  let done = 0;

  function updateStats() {
    const totalNode = document.getElementById("totalCount");
    const doneNode = document.getElementById("doneCount");
    const urgentNode = document.getElementById("urgentCount");

    if (totalNode) totalNode.textContent = total;
    if (doneNode) doneNode.textContent = done;

    if (urgentNode) {
      urgentNode.textContent = list.querySelectorAll(
        ".reminder-item:not(.completed) .badge.red",
      ).length;
    }
  }

  function attachDone(button) {
    button.addEventListener("click", () => {
      const item = button.closest(".reminder-item");

      if (!item || item.classList.contains("completed")) return;

      item.classList.add("completed");
      button.textContent = "Selesai";
      button.disabled = true;

      done++;
      updateStats();
    });
  }

  document.querySelectorAll("[data-demo-done]").forEach(attachDone);

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    const title = document.getElementById("taskTitle")?.value.trim();

    if (!title) return;

    const subject =
      document.getElementById("taskSubject")?.value.trim() ||
      "Mata kuliah belum ditentukan";

    const deadline = document.getElementById("taskDeadline")?.value;
    const priority = document.getElementById("taskPriority")?.value;

    const item = document.createElement("article");
    item.className = "reminder-item";

    const top = document.createElement("div");
    top.className = "reminder-item-top";

    const badge = document.createElement("span");
    badge.className =
      "badge " +
      (priority === "Tinggi"
        ? "red"
        : priority === "Sedang"
          ? "blue"
          : "green");

    badge.textContent = priority || "Rendah";

    const date = document.createElement("span");
    date.className = "reminder-date";

    date.textContent = deadline
      ? new Date(deadline).toLocaleString("id-ID")
      : "Tanggal belum ditentukan";

    const heading = document.createElement("h3");
    heading.textContent = title;

    const desc = document.createElement("p");
    desc.textContent = subject;

    const button = document.createElement("button");
    button.className = "small-outline";
    button.type = "button";
    button.textContent = "Tandai Selesai";

    top.append(badge, date);
    item.append(top, heading, desc, button);

    list.prepend(item);
    attachDone(button);

    total++;
    updateStats();
    form.reset();
  });

  updateStats();
});
