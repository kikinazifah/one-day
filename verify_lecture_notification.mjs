/**
 * Uji browser pengingat kuliah — membuktikan rantai penuh:
 *
 *   sisip entri jadwal ~14 menit lagi (via python sqlite3)
 *     → beat sweep (≤5 menit) → worker → baris notifications
 *       → klik lonceng → item "Pengingat kuliah" tampil di panel.
 *
 * Tanpa login: dashboard dev ini membaca akun default yang sama
 * dengan entri yang disisipkan — satu-satunya cara menguji baris yang
 * baru dibuat tanpa kredensial.
 *
 * Jalankan: node verify_lecture_notification.mjs
 * Butuh stack hidup (start_stack.ps1) — port diperiksa dulu.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";

// ESM tidak membaca NODE_PATH — resolve playwright lewat require global.
const { chromium } = createRequire(import.meta.url)("playwright");

const BASE = process.env.BASE_URL || "http://127.0.0.1:8010";
const TITLE = "SMOKE Browser Pengingat";
const DB = "C:/Users/Pongo/UINIC/student-assistant/backend/dev.db";
const USER = "5d8fec15-c686-489c-85c9-0dd9a18a2084"; // akun panel (sama seperti BFF)
const POLL_MS = 15000;
const TIMEOUT_MS = 7 * 60 * 1000; // beat tiap 5 menit + margin

let checks = 0;
let failed = 0;
function check(name, ok, detail = "") {
  checks++;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? " — " + detail : ""}`);
}

/** Operasi DB lewat python (sqlite3 bawaan) — tanpa dependensi node. */
function py(sql) {
  return execFileSync("python", ["-c", sql], { encoding: "utf8" }).trim();
}

function insertEntry() {
  const out = py(`
from datetime import datetime, timedelta
import sqlite3, uuid, os
now = datetime.now()
start = (now + timedelta(minutes=14)).replace(second=0, microsecond=0)
con = sqlite3.connect(r"${DB}")
eid = str(uuid.uuid4())
con.execute(
    "INSERT INTO schedule_entries (id, user_id, title, description, start_time,"
    " end_time, location, day_of_week, is_recurring, is_from_campus_source,"
    " created_at, updated_at, lecture_reminder_sent_at)"
    " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    (eid, "${USER}", "${TITLE}", "SMOKE BROWSER", start.isoformat(" "),
     (start + timedelta(hours=2)).isoformat(" "), "R. Browser", None, 0, 0,
     now.isoformat(" "), now.isoformat(" "), None))
con.commit(); con.close()
print(eid, start.strftime("%H:%M"))
`);
  const [id, jam] = out.split(" ");
  console.log(`entri disisipkan: ${id} mulai ${jam}`);
  return id;
}

function deleteEntry(id) {
  py(`
import sqlite3
con = sqlite3.connect(r"${DB}")
con.execute("DELETE FROM schedule_entries WHERE id=?", ("${id}",))
con.execute("DELETE FROM notifications WHERE title='Pengingat kuliah' AND message LIKE '%${TITLE}%'")
con.commit(); con.close()
print("ok")
`);
}

async function main() {
  // 0. stack hidup?
  try {
    await (await fetch(BASE + "/", { signal: AbortSignal.timeout(3000) })).text();
    check("stack hidup (port 8010)", true);
  } catch {
    console.error("Dashboard tidak merespon — jalankan start_stack.ps1 dulu.");
    process.exit(2);
  }

  // 1. bersihkan sisa uji sebelumnya
  py(`import sqlite3; con = sqlite3.connect(r"${DB}"); con.execute("DELETE FROM schedule_entries WHERE description='SMOKE BROWSER'"); con.execute("DELETE FROM notifications WHERE title='Pengingat kuliah' AND message LIKE '%${TITLE}%'"); con.commit(); print("ok")`);

  const entryId = insertEntry();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(BASE + "/", { waitUntil: "networkidle" });

    // 2. lonceng ada (auto-mount notifications.js)
    const bell = page.locator("#notificationBell");
    check("lonceng ada di topbar", (await bell.count()) === 1);

    // 3. tunggu beat menghasilkan notifikasi (poll DB, bukan UI)
    const deadline = Date.now() + TIMEOUT_MS;
    let row = null;
    while (Date.now() < deadline) {
      row = py(
        `import sqlite3; con = sqlite3.connect(r"${DB}"); r = con.execute("SELECT message FROM notifications WHERE title='Pengingat kuliah' AND message LIKE '%${TITLE}%'").fetchone(); print(r[0] if r else "")`
      );
      if (row) break;
      console.log(`menunggu beat... (${Math.round((deadline - Date.now()) / 1000)}s tersisa)`);
      await sleep(POLL_MS);
    }
    check("notifikasi LECTURE_REMINDER tercipta via beat", Boolean(row), row);

    // 4. klik lonceng → panel → item tampil
    if (row) {
      await bell.click();
      const panel = page.locator("#notificationPanel");
      await panel.waitFor({ state: "visible", timeout: 5000 });
      check("panel terbuka saat lonceng diklik", true);

      const item = page
        .locator(".notification-item", { hasText: "Pengingat kuliah" })
        .first();
      await item.waitFor({ state: "visible", timeout: 5000 });
      const text = await item.innerText();
      check(
        "item 'Pengingat kuliah' tampil di panel",
        text.includes("Pengingat kuliah"),
        JSON.stringify(text.slice(0, 90))
      );

      // 5. auto-mount di halaman lain (fix sesi sebelumnya).
      //    Elemen lonceng ada di template — itu tidak membuktikan apa-apa.
      //    Yang membuktikan mount() berjalan: KLIK lonceng membuka panel
      //    (handler-nya hanya terpasang kalau mount() jalan).
      await page.goto(BASE + "/reminder-system/", { waitUntil: "networkidle" });
      const bell2 = page.locator("#notificationBell");
      check("lonceng ada di halaman lain", (await bell2.count()) === 1);
      await bell2.click();
      const panel2 = page.locator("#notificationPanel");
      await panel2.waitFor({ state: "visible", timeout: 5000 });
      check("klik lonceng di halaman lain membuka panel (mount aktif)", true);
    }
  } finally {
    await browser.close();
    deleteEntry(entryId);
    console.log("data uji dibersihkan.");
  }

  console.log(`\n${checks - failed}/${checks} lulus`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
