// Service worker for the kill planner: keeps its files on the device so the installed app opens with no
// connection. Serves the saved copy at once and refreshes it in the background when online, so an update
// shows up the second time the app is opened. Other pages in this folder are left alone.
const CACHE = 'kill-planner-v1';
const ASSETS = ['killplanner.html', 'killplanner.webmanifest', 'js/formulas.js', 'js/knockback.js', 'js/killplanner-data.js',
	'js/killplanner-core.js', 'js/killplanner-chart.js', 'js/killplanner.js', 'img/killplanner-180.png', 'img/killplanner-512.png'];
const urls = () => ASSETS.map(a => new URL(a, self.registration.scope).href);

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(urls())).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', e => {
	const url = e.request.url.split('?')[0];
	if (e.request.method !== 'GET' || !urls().includes(url)) return;
	e.respondWith(caches.open(CACHE).then(async cache => {
		const saved = await cache.match(url);
		const fresh = fetch(url, { cache: 'no-cache' }).then(r => { if (r.ok) cache.put(url, r.clone()); return r; });
		if (saved) { fresh.catch(() => { }); return saved; }
		return fresh;
	}));
});
