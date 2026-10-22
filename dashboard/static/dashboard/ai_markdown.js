/**
 * Markdown untuk gelembung chat — port dari GenOffice (Electron).
 *
 * Asalnya `packages/ui/src/Markdown.tsx` (149 baris): markdown minimal
 * tanpa dependensi, untuk paragraf, ul/ol, heading, **tebal**, *miring*,
 * dan `kode sebaris`.
 *
 * Dua sifat yang harus dipertahankan:
 *
 * 1. **Aman dari XSS.** Versi React membangun elemen, bukan string HTML,
 *    jadi tidak pernah memakai `dangerouslySetInnerHTML`. Di sini sama:
 *    semua teks masuk lewat `textContent`, jadi teks dari model tidak
 *    pernah jadi markup. Tidak ada `innerHTML` di file ini sama sekali.
 * 2. **Toleran terhadap input setengah jadi.** Teks yang masih mengalir
 *    belum tentu markdown lengkap — blok yang belum tertutup harus tetap
 *    tampil sebagai teks biasa, bukan hilang.
 *
 * Tautan tetap literal kecuali scheme-nya cocok dengan `nav` — sama
 * seperti aslinya: teks yang ditulis AI tidak boleh bisa menyisipkan
 * tautan yang mencuri klik.
 */
(function (global) {
  "use strict";

  // Href boleh memuat satu tingkat kurung berseimbang (nama sheet seperti
  // `Data (2)`), jadi href tidak bisa berhenti di ')'.
  const HREF = "(?:[^\\s()]|\\([^\\s()]*\\))+";

  const INLINE_RE = new RegExp(
    "(\`[^\`\\n]+\`|\\*\\*[^*\\n]+?\\*\\*|\\*[^*\\n]+?\\*|\\[[^\\]\\n]+\\]\\(" +
      HREF +
      "\\))",
    "g"
  );
  const LINK_RE = new RegExp("^\\[([^\\]]+)\\]\\((" + HREF + ")\\)$");

  /**
   * Pecah teks jadi blok: paragraf, daftar, heading.
   *
   * @param {string} text
   * @returns {Array<{kind: string, lines?: string[], items?: string[], text?: string}>}
   */
  function parseBlocks(text) {
    const blocks = [];
    let current = null;

    const flush = function () {
      if (current) {
        blocks.push(current);
        current = null;
      }
    };

    const lines = String(text == null ? "" : text).split("\n");

    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "");

      if (!line.trim()) {
        flush();
        continue;
      }

      const heading = /^#{1,6}\s+(.*)$/.exec(line);
      if (heading) {
        flush();
        blocks.push({ kind: "h", text: heading[1] || "" });
        continue;
      }

      const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
      if (bullet) {
        if (!current || current.kind !== "ul") {
          flush();
          current = { kind: "ul", items: [] };
        }
        current.items.push(bullet[1] || "");
        continue;
      }

      const numbered = /^\s*\d+[.、)]\s+(.*)$/.exec(line);
      if (numbered) {
        if (!current || current.kind !== "ol") {
          flush();
          current = { kind: "ol", items: [] };
        }
        current.items.push(numbered[1] || "");
        continue;
      }

      if (!current || current.kind !== "p") {
        flush();
        current = { kind: "p", lines: [] };
      }
      current.lines.push(line);
    }

    flush();
    return blocks;
  }

  /**
   * Render inline markdown ke dalam sebuah elemen.
   *
   * @param {string} text
   * @param {HTMLElement} into — elemen tempat hasilnya ditambahkan
   * @param {{scheme: string, onNavigate: Function}|null} nav
   */
  function renderInline(text, into, nav) {
    const source = String(text == null ? "" : text);
    let last = 0;

    INLINE_RE.lastIndex = 0;
    let match;
    while ((match = INLINE_RE.exec(source)) !== null) {
      const index = match.index || 0;
      if (index > last) {
        into.appendChild(document.createTextNode(source.slice(last, index)));
      }

      const token = match[0] || "";

      if (token.charAt(0) === "`") {
        const code = document.createElement("code");
        code.textContent = token.slice(1, -1);
        into.appendChild(code);
      } else if (token.slice(0, 2) === "**") {
        const strong = document.createElement("strong");
        strong.textContent = token.slice(2, -2);
        into.appendChild(strong);
      } else if (token.charAt(0) === "[") {
        const link = LINK_RE.exec(token);
        const href = (link && link[2]) || "";
        if (link && nav && href.indexOf(nav.scheme) === 0) {
          const anchor = document.createElement("a");
          anchor.className = "ai-md-nav";
          anchor.href = href;
          anchor.textContent = link[1];
          anchor.addEventListener("click", function (event) {
            event.preventDefault();
            nav.onNavigate(href);
          });
          into.appendChild(anchor);
        } else {
          // Tautan non-nav tetap literal — sama seperti aslinya.
          into.appendChild(document.createTextNode(token));
        }
      } else {
        const em = document.createElement("em");
        em.textContent = token.slice(1, -1);
        into.appendChild(em);
      }

      last = index + token.length;
    }

    if (last < source.length) {
      into.appendChild(document.createTextNode(source.slice(last)));
    }
  }

  /**
   * Render markdown ke dalam elemen.
   *
   * Elemen yang dikembalikan adalah `<div class="ai-md">` — kelasnya
   * dipakai CSS untuk mengatur jarak antar blok.
   *
   * @param {string} text
   * @param {{scheme: string, onNavigate: Function}|null} nav
   * @returns {HTMLElement}
   */
  function render(text, nav) {
    const root = document.createElement("div");
    root.className = "ai-md";

    parseBlocks(text).forEach(function (block) {
      if (block.kind === "h") {
        const paragraph = document.createElement("p");
        paragraph.className = "ai-md-h";
        renderInline(block.text, paragraph, nav);
        root.appendChild(paragraph);
        return;
      }

      if (block.kind === "ul" || block.kind === "ol") {
        const list = document.createElement(block.kind);
        block.items.forEach(function (item) {
          const li = document.createElement("li");
          renderInline(item, li, nav);
          list.appendChild(li);
        });
        root.appendChild(list);
        return;
      }

      const paragraph = document.createElement("p");
      block.lines.forEach(function (line, index) {
        if (index > 0) {
          paragraph.appendChild(document.createElement("br"));
        }
        renderInline(line, paragraph, nav);
      });
      root.appendChild(paragraph);
    });

    return root;
  }

  /**
   * Ganti isi elemen dengan markdown baru.
   *
   * Dipakai untuk streaming: teks AI datang terus-menerus, dan tiap
   * potongan baru menggantikan isi sebelumnya (teksnya kumulatif).
   *
   * @param {HTMLElement} target
   * @param {string} text
   * @param {{scheme: string, onNavigate: Function}|null} nav
   */
  function update(target, text, nav) {
    if (!target) return;
    const next = render(text, nav);
    target.replaceChildren(...next.childNodes);
  }

  global.AIMarkdown = {
    render: render,
    update: update,
    parseBlocks: parseBlocks,
  };
})(window);
