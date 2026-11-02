/* Apex Owner service worker: keeps the dashboard opening with a weak or no signal.
   Network first for everything; if the network fails, the last copy (marked X-Apex-Cache) is used.
   Only GET requests under /admin/ and /api/admin/ are cached (never photo uploads or changes). */
var CACHE = "apex-owner-v2";
var SHELL = ["/admin/", "/admin/app.js?v=2", "/admin/photos.js?v=2", "/admin/manifest.webmanifest", "/apple-touch-icon.png"];
self.addEventListener("install", function (e) { e.waitUntil(caches.open(CACHE).then(function (c) { return Promise.all(SHELL.map(function (u) { return fetch(u, { credentials: "same-origin" }).then(function (r) { if (r.ok) return c.put(u, r); }).catch(function () {}); })); }).then(function () { return self.skipWaiting(); })); });
self.addEventListener("activate", function (e) { e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); })); });
self.addEventListener("fetch", function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  var api = url.pathname.indexOf("/api/admin/") === 0, page = url.pathname.indexOf("/admin/") === 0 || url.pathname === "/apple-touch-icon.png";
  if (!api && !page) return;
  if (api && (url.pathname === "/api/admin/export" || /\/api\/admin\/photos\/[^/]+$/.test(url.pathname) && !url.searchParams.has("t"))) return;   // big files: straight to the network
  var key = req.mode === "navigate" ? "/admin/" : req.url;
  e.respondWith(fetch(req).then(function (r) {
    if (r.ok && r.type === "basic") { var copy = r.clone(); caches.open(CACHE).then(function (c) { c.put(key, copy); }); }
    return r;
  }).catch(function () {
    return caches.match(key).then(function (hit) {
      if (!hit) return api ? new Response(JSON.stringify({ error: "You're offline and this wasn't saved on the phone yet." }), { status: 503, headers: { "Content-Type": "application/json" } }) : Response.error();
      if (!api) return hit;
      var h = new Headers(hit.headers); h.set("X-Apex-Cache", "1");
      return hit.blob().then(function (b) { return new Response(b, { status: hit.status, headers: h }); });
    });
  }));
});
