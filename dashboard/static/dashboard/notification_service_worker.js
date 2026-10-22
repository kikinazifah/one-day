/* Service Worker untuk notifikasi peramban.
 *
 * File ini disajikan Django dari URL /sw.js — bukan dari /static/. Alasannya
 * scope: default Service Worker hanya menguasai direktori tempat file-nya
 * berada. Kalau file-nya dilayani dari /static/dashboard/, scope-nya jadi
 * /static/dashboard/ dan tidak bisa mengendalikan /reminder-system/.
 * Disajikan dari akar situs, scope-nya / dan bisa gruduk semuanya.
 *
 * Worker ini tidak melakukan polling sendiri — halaman yang melakukan
 * polling lalu mengirim pesan ke sini lewat postMessage. Worker hanya
 * menampilkan notifikasi sistem, karena showNotification() hanya boleh
 * dipanggil dari konteks worker.
 */

self.addEventListener("install", (event) => {
  // Langsung aktifkan worker baru — tidak perlu menunggu tab ditutup.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "show-notification") return;

  const title = data.title || "Pengingat tugas";
  const options = {
    body: data.body || "",
    tag: data.tag || undefined,
    icon: data.icon || undefined,
    badge: data.badge || undefined,
    data: data.data || undefined,
  };

  event.waitUntil(
    self.registration.showNotification(title, options).catch((error) => {
      // Notifikasi bisa ditolak pengguna atau diblokir browser — jangan
      // sampai error ini menggagalkan halaman.
      console.warn("[sw] gagal memunculkan notifikasi:", error);
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const target = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
