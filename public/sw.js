/* Service worker for the Task Command Center — receives Web Push reminders
   and shows them even when the app is fully closed. */
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { title: "Task reminder", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "⏰ Task reminder";
  const options = {
    body: data.body || "",
    tag: data.taskId ? "marco-task-" + data.taskId : "marco-task",
    data: { url: data.url || "/tasks", taskId: data.taskId || null },
    requireInteraction: /due now/i.test(title),
    badge: "/assets/marco.jpg",
    icon: "/assets/marco.jpg",
    vibrate: [120, 60, 120],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/tasks";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes("/tasks") && "focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
      return undefined;
    }),
  );
});
