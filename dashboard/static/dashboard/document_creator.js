document.addEventListener("DOMContentLoaded", () => {
  const documentForm = document.getElementById("documentForm");

  if (!documentForm) return;

  documentForm.addEventListener("submit", (e) => {
    e.preventDefault();

    const title = document.getElementById("docTitle").value.trim();
    const type = document.getElementById("docType").value;
    const subject = document.getElementById("docSubject").value.trim();
    const description = document.getElementById("docDescription").value.trim();

    const preview = document.getElementById("documentPreview");

    if (!preview) return;

    preview.className = "preview-result";
    preview.replaceChildren();

    const heading = document.createElement("h2");
    heading.textContent = title;

    const typeLine = document.createElement("p");
    typeLine.textContent = type + (subject ? " • " + subject : "");

    const detail = document.createElement("p");
    detail.textContent = description;

    const note = document.createElement("p");
    note.className = "form-note";
    note.textContent =
      "Ini pratinjau permintaan. Integrasi AI dan ekspor dokumen belum diaktifkan.";

    preview.append(heading, typeLine, detail, note);
  });
});
