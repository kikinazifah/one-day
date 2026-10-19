document.addEventListener("DOMContentLoaded", () => {
  const timeNode = document.getElementById("recordingTime");
  const recordButton = document.getElementById("recordButton");
  const statusNode = document.getElementById("recordingStatus");

  let recording = false;
  let elapsed = 0;
  let intervalId = null;

  function renderTime() {
    if (!timeNode) return;

    const h = String(Math.floor(elapsed / 3600)).padStart(2, "0");
    const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, "0");
    const s = String(elapsed % 60).padStart(2, "0");

    timeNode.textContent = `${h}:${m}:${s}`;
  }

  if (recordButton && timeNode && statusNode) {
    recordButton.addEventListener("click", () => {
      if (!recording) {
        recording = true;
        statusNode.textContent = "Simulasi Berjalan";
        recordButton.textContent = "Hentikan Rekaman";

        intervalId = setInterval(() => {
          elapsed++;
          renderTime();
        }, 1000);
      } else {
        recording = false;
        clearInterval(intervalId);
        intervalId = null;

        statusNode.textContent = "Sesi Selesai";
        recordButton.textContent = "Mulai Rekaman";

        const title =
          document.getElementById("lectureTitle")?.value.trim() ||
          "Sesi Perkuliahan";

        const history = document.getElementById("sessionHistory");

        if (history) {
          const row = document.createElement("div");
          row.className = "history-row";

          const name = document.createElement("strong");
          name.textContent = title;

          const duration = document.createElement("span");
          duration.textContent = timeNode.textContent;

          row.append(name, duration);
          history.replaceChildren(row);
        }

        elapsed = 0;
        renderTime();
      }
    });
  }

  const summarizeButton = document.getElementById("summarizeButton");

  if (summarizeButton) {
    summarizeButton.addEventListener("click", () => {
      const transcript = document.getElementById("transcript")?.value.trim();
      const box = document.getElementById("lectureSummary");

      if (!box) return;

      box.replaceChildren();

      const heading = document.createElement("h3");
      heading.textContent = "Ringkasan Materi";

      const result = document.createElement("p");

      if (!transcript) {
        result.textContent = "Masukkan transkrip terlebih dahulu.";
        box.append(heading, result);
        return;
      }

      const sentences = transcript.split(/(?<=[.!?])\s+/).filter(Boolean);
      result.textContent = sentences.slice(0, 3).join(" ");

      const note = document.createElement("p");
      note.className = "form-note";
      note.textContent =
        "Ringkasan demo berdasarkan tiga kalimat pertama, bukan hasil AI.";

      box.append(heading, result, note);
    });
  }
});
