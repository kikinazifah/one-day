/**
 * DOM shim minimal — cukup untuk menjalankan rag_assistant.js di Node
 * tanpa browser. Tujuannya bukan render, tapi menguji LOGIKA state.
 *
 * Dua hal yang **wajib** benar supaya test tidak berbohong:
 *
 *  1. `parent` dilacak. Tanpa itu `remove()` dan `replaceWith()` diam-diam
 *     tidak melakukan apa-apa, dan bug "jawaban tidak pernah tampil karena
 *     node-nya sudah lepas dari DOM" jadi mustahil diuji.
 *  2. `<select>` meniru semantik browser: menyetel `value` ke id yang tidak
 *     ada sebagai opsi mengosongkan selection.
 */

class El {
  constructor(tag) {
    this.tagName = (tag || "div").toUpperCase();
    this.children = [];
    this.parent = null;
    this.attributes = {};
    this.listeners = {};
    this.style = {};
    this._text = "";
    this._value = "";
    this.classList = {
      _set: new Set(),
      add: (c) => this.classList._set.add(c),
      remove: (c) => this.classList._set.delete(c),
      contains: (c) => this.classList._set.has(c),
    };
    this.className = "";
    this.hidden = false;
    this.disabled = false;
    this.files = [];
  }
  /**
   * `<select>` punya semantik khusus di browser: menyetel `value` ke id yang
   * tidak ada sebagai opsi membuat `selectedIndex` jadi -1 dan `value` jadi
   * "". Shim ini menirunya supaya test bisa membedakan "pilih yang memang
   * ada" dari "hapus tag".
   */
  set value(v) {
    this._value = String(v);
    if (this.tagName === "SELECT") {
      const options = this.children.filter((c) => c.tagName === "OPTION");
      if (this._value !== "" && !options.some((o) => o.value === this._value)) {
        this._value = "";
      }
    }
  }
  get value() {
    return this._value;
  }
  set textContent(v) {
    this._text = String(v);
    // Kosongkan dulu (lepas parent anak lama), baru isi.
    this.children.forEach((c) => (c.parent = null));
    this.children = [];
  }
  get textContent() {
    if (this._text) return this._text;
    return this.children.map((c) => c.textContent).join("");
  }
  append(...nodes) {
    nodes.forEach((n) => {
      n.parent = this;
      this.children.push(n);
    });
  }
  appendChild(n) {
    n.parent = this;
    this.children.push(n);
    return n;
  }
  replaceChildren(...nodes) {
    this.children.forEach((c) => (c.parent = null));
    this.children = [];
    nodes.forEach((n) => {
      n.parent = this;
      this.children.push(n);
    });
  }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  replaceWith(node) {
    // Tanpa parent, `replaceWith` tidak melakukan apa-apa — persis seperti
    // di browser. Ini penting: bug "node sudah lepas dari DOM" harus
    // bisa direproduksi.
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i === -1) return;
    this.parent.children[i] = node;
    node.parent = this.parent;
    this.parent = null;
  }
  removeChild(n) {
    this.children = this.children.filter((c) => c !== n);
    n.parent = null;
  }
  setAttribute(k, v) {
    this.attributes[k] = v;
  }
  getAttribute(k) {
    return this.attributes[k];
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  dispatch(type, event = {}) {
    const ev = { type, preventDefault() {}, ...event };
    (this.listeners[type] || []).forEach((fn) => fn.call(this, ev));
  }
  focus() {}
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  closest() {
    return null;
  }
  querySelector(sel) {
    return find(this, sel);
  }
}

function find(root, sel) {
  const m = sel.match(/^#([\w-]+)$/);
  if (m) return byId(root, m[1]);
  for (const c of root.children || []) {
    const r = find(c, sel);
    if (r) return r;
  }
  return null;
}
function byId(root, id) {
  if (root.id === id) return root;
  for (const c of root.children || []) {
    const r = byId(c, id);
    if (r) return r;
  }
  return null;
}

/**
 * Elemen yang harus jadi `<select>` — semantiknya berbeda dari elemen lain:
 * menyetel `value` ke id yang tidak ada sebagai opsi akan mengosongkan
 * selection di browser sungguhan. Kalau shim tidak menirunya, test salah
 * membaca UI.
 */
const SELECT_IDS = new Set(["ragCourse", "ragRenameCourse"]);

export function buildDom(ids) {
  const root = new El("body");
  const els = {};
  for (const id of ids) {
    const el = new El(SELECT_IDS.has(id) ? "select" : "div");
    el.id = id;
    root.append(el);
    els[id] = el;
  }
  return { root, els };
}

export { El };
