// 홈 화면 앱용 작은 보관소: 인터넷이 될 때는 늘 새 파일을 받고(바로 업데이트), 안 될 때만 보관해 둔 파일을 쓴다.
const CACHE = "jpi-v1.5";
const FILES = ["./", "./index.html", "./app.js", "./glossary.js", "./phrases.js", "./pcm-worklet.js", "./manifest.json", "./icon-180.png", "./icon-192.png", "./icon-512.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== "GET" || u.origin !== location.origin || u.pathname.includes("/tests/") || u.pathname === "/token") return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    try {
      // 신호가 약하면 4초만 기다리고 보관본을 쓴다
      const r = await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error("slow")), 4000))]);
      if (r.ok) c.put(req, r.clone());
      return r;
    } catch (_) {
      return (await c.match(req, { ignoreSearch: true })) || (await c.match("./index.html")) || Response.error();
    }
  })());
});
