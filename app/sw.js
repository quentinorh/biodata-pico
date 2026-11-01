/* Cache de l'interface Biodata Pico. Les flux du capteur (/api) restent en direct. */
var CACHE = "biodata-pico-v1";
var SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./script.js",
  "./faust-player.js",
  "./quantizer.js",
  "./default-config.js",
  "./inter-var.woff2",
  "./faust/catalog.js",
  "./manifest.webmanifest",
  "./favicon.ico",
  "./favicon-32.png",
  "./apple-touch-icon.png",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return Promise.all(SHELL.map(function (url) {
        return cache.add(url).catch(function () {});
      }));
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (key) {
        return key !== CACHE;
      }).map(function (key) {
        return caches.delete(key);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

function store(cacheKey, response) {
  if (!response || response.status !== 200 || response.type !== "basic" || response.redirected) {
    return;
  }
  var copy = response.clone();
  caches.open(CACHE).then(function (cache) {
    cache.put(cacheKey, copy);
  });
}

function networkFirst(request, cacheKey) {
  return fetch(request).then(function (response) {
    store(cacheKey, response);
    return response;
  }).catch(function () {
    return caches.match(cacheKey).then(function (cached) {
      return cached || caches.match("./index.html");
    });
  });
}

function cacheFirst(request, cacheKey) {
  return caches.match(cacheKey).then(function (cached) {
    if (cached) return cached;
    return fetch(request).then(function (response) {
      store(cacheKey, response);
      return response;
    });
  });
}

self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "GET") return;
  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf("/api/") === 0) return;

  var path = url.pathname;
  var navigation = request.mode === "navigate" || path === "/" || /\.html$/.test(path);
  var cacheKey = new Request(navigation ? new URL("./", self.location).href : url.origin + path);
  var fresh = navigation || /\.(js|css|json|webmanifest)$/.test(path);
  event.respondWith(fresh ? networkFirst(request, cacheKey) : cacheFirst(request, cacheKey));
});
