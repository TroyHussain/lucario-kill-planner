// Lucario kill planner UI: inputs, background work, saved tables and rendering.
// Physics and the knockback formula live in killplanner-core.js; data comes from killplanner-data.js.
(function () {
	'use strict';

	const Core = KPCore, VARIANTS = Core.VARIANTS, CLASSES = Core.CLASSES, COMBOS = Core.COMBOS, S5 = Core.S5;
	const $id = id => document.getElementById(id);
	const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	const familyColor = f => css('--s' + (f + 1));

	// ---------- Settings (remembered between visits) ----------
	const SETTINGS_KEY = 'lucario-kill-planner.settings';
	function loadSettings() { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (e) { return {}; } }
	const saved = loadSettings();
	const state = { opp: 'Joker', stage: 'Final Destination', stock: '0', L: 50, d: 10, mode: 'n', hidden: new Set() };
	if (Core.character(saved.opp)) state.opp = saved.opp;
	if (KP_DATA.stages[saved.stage]) state.stage = saved.stage;
	if (['-2', '-1', '0', '+1', '+2'].includes(saved.stock)) state.stock = saved.stock;
	if (saved.L >= 0 && saved.L <= 200) state.L = Math.round(saved.L);
	if (saved.d >= 0) state.d = Math.round(saved.d);
	if (saved.mode === 'b') state.mode = 'b';
	if (Array.isArray(saved.hidden)) saved.hidden.forEach(id => state.hidden.add(id));
	function saveSettings() {
		try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...state, hidden: [...state.hidden] })); } catch (e) { /* storage unavailable: settings just won't persist */ }
	}

	// ---------- Saved tables (IndexedDB): exact KB* at every distance, both DI modes, per opponent + stage ----------
	const Store = (function () {
		let dbp = null;
		const open = () => dbp || (dbp = new Promise((resolve, reject) => {
			try {
				const r = indexedDB.open('lucario-kill-planner', 1);
				r.onupgradeneeded = () => r.result.createObjectStore('kb');
				r.onsuccess = () => resolve(r.result);
				r.onerror = () => reject(r.error);
			} catch (e) { reject(e); }
		}));
		const run = (mode, fn) => open().then(db => new Promise((resolve, reject) => {
			const t = db.transaction('kb', mode), req = fn(t.objectStore('kb'));
			t.oncomplete = () => resolve(req.result);
			t.onerror = () => reject(t.error);
		}));
		return {
			get: k => run('readonly', s => s.get(k)).catch(() => undefined),
			put: (k, v) => run('readwrite', s => s.put(v, k)).catch(() => undefined),
			count: () => run('readonly', s => s.count()).catch(() => null),
			clear: () => run('readwrite', s => s.clear()).catch(() => undefined)
		};
	})();
	const storeKey = (opp, stage) => [Core.VERSION, KP_DATA.hash, opp, stage].join('|');

	// ---------- Physics caches ----------
	const phys = new Map();   // opponent -> { a: attributes, env: { class: [envelope per S5 stick] } }
	function physicsFor(opp) { if (!phys.has(opp)) phys.set(opp, { a: Core.character(opp), env: {} }); return phys.get(opp); }
	const envReady = (opp, all) => { const env = physicsFor(opp).env; return Object.keys(CLASSES).every(ck => env[ck] && (all ? env[ck].length === S5.length && env[ck].every(Boolean) : env[ck][0])); };

	let geo = Core.stage(state.stage);
	const exact = new Map(), est = new Map(), complete = new Set();
	const key = (combo, d, mode) => [state.opp, state.stage, combo, d, mode].join('|');
	const pairKey = () => state.opp + '|' + state.stage;
	function position(combo, d) {
		const [ck, h] = combo.split('@'), x0 = geo.ledgeX - d;
		return { ck, cls: CLASSES[ck], x0, y0: geo.floorY(x0) + +h };
	}
	function estimateFor(combo, d, mode) {
		const k = key(combo, d, mode);
		if (est.has(k)) return est.get(k);
		if (!envReady(state.opp, mode === 'b')) return undefined;
		const p = position(combo, d), v = Core.estimateStar(physicsFor(state.opp).env[p.ck], p.x0, p.y0, geo.blast, mode);
		est.set(k, v);
		return v;
	}
	function ensureExact(combo, d, mode) {
		const k = key(combo, d, mode);
		if (exact.has(k)) return exact.get(k);
		if (!envReady(state.opp, mode === 'b')) return undefined;
		const ph = physicsFor(state.opp), p = position(combo, d);
		const v = Core.kbStar(p.cls, ph.env[p.ck], ph.a, p.x0, p.y0, geo.blast, mode);
		exact.set(k, v);
		return v;
	}
	// Best available KB*: exact if settled, otherwise the smooth estimate
	const kbFor = (combo, d, mode) => { const e = exact.get(key(combo, d, mode)); return e !== undefined ? e : estimateFor(combo, d, mode); };
	const percent = (v, L, kb) => Core.percentFor(v, L, kb, physicsFor(state.opp).a.weight, state.stock);

	// ---------- Background work ----------
	// Order: neutral envelopes, exact no-DI here (the table), the DI sticks' envelopes (after which every chart draws
	// from estimates), exact optimal DI here, exact everywhere, then save the finished tables.
	let gen = 0, work = [], workTotal = 0, running = false, loadedFromStore = false;
	const exactJobs = (d, modes) => { const jobs = []; for (const mode of modes) for (const c of COMBOS) if (!exact.has(key(c, d, mode))) jobs.push(() => ensureExact(c, d, mode)); return jobs; };
	function envelopeJobs(all) {
		const ph = physicsFor(state.opp), jobs = [];
		for (const ck of Object.keys(CLASSES)) {
			if (!ph.env[ck]) ph.env[ck] = [];
			for (let i = all ? 1 : 0; i < (all ? S5.length : 1); i++) if (!ph.env[ck][i]) jobs.push(() => { ph.env[ck][i] = Core.envelope(CLASSES[ck], S5[i], ph.a); });
		}
		return jobs;
	}
	function saveTables() {
		const v = { maxD: geo.maxD, n: {}, b: {} };
		for (const mode of ['n', 'b']) for (const c of COMBOS) {
			v[mode][c] = Array.from({ length: geo.maxD + 1 }, (_, d) => exact.get(key(c, d, mode)));
			if (v[mode][c].some(x => x === undefined)) return;
		}
		complete.add(pairKey());
		Store.put(storeKey(state.opp, state.stage), v).then(showStorage);
	}
	async function schedule() {
		const g = ++gen;
		work = []; running = false; loadedFromStore = false;
		const pk = pairKey();
		if (!complete.has(pk)) {
			const stored = await Store.get(storeKey(state.opp, state.stage));
			if (g !== gen) return;
			if (stored && stored.maxD === geo.maxD) {
				for (const mode of ['n', 'b']) for (const c of COMBOS) stored[mode][c].forEach((kb, d) => exact.set(key(c, d, mode), kb));
				complete.add(pk); loadedFromStore = true;
			}
		}
		if (complete.has(pk)) { render(); showProgress(); return; }
		const jobs = envelopeJobs(false).concat(exactJobs(state.d, ['n']), envelopeJobs(true), exactJobs(state.d, ['b']));
		for (let d = 0; d <= geo.maxD; d++) if (d !== state.d) jobs.push(...exactJobs(d, ['n', 'b']));
		jobs.push(saveTables);
		work = jobs; workTotal = jobs.length; running = true;
		pump(g);
	}
	// Moving the distance slider puts that distance's exact values at the front of the queue
	function prioritize(d) {
		if (!running) return;
		work.unshift(...exactJobs(d, envReady(state.opp, true) ? ['n', 'b'] : ['n']));
		workTotal = Math.max(workTotal, work.length);
	}
	// Yield between slices with a MessageChannel: unlike setTimeout it isn't throttled in background tabs
	const channel = new MessageChannel();
	let next = null;
	channel.port1.onmessage = () => { const f = next; next = null; if (f) f(); };
	let lastRender = 0;
	function pump(g) {
		if (g !== gen) return;
		const t0 = performance.now();
		while (work.length && performance.now() - t0 < 30) work.shift()();
		const now = performance.now();
		if (!work.length || now - lastRender > 150) { render(); lastRender = now; }
		showProgress();
		if (work.length) { next = () => pump(g); channel.port2.postMessage(0); } else running = false;
	}
	function showProgress() {
		const done = workTotal - work.length, pct = work.length ? Math.round(100 * done / (workTotal || 1)) : 100;
		$id('barFill').style.width = pct + '%';
		$id('status').textContent = !work.length
			? (loadedFromStore ? `Loaded ${state.opp} on ${state.stage} from saved tables.` : `Ready: ${state.opp} on ${state.stage}, exact everywhere and saved.`)
			: !envReady(state.opp, true) ? `Building ${state.opp}'s flight tables… ${pct}% (no-DI charts are ready)`
			: `Refining to exact values… ${pct}% (charts are already within ~1%)`;
	}

	// ---------- Rendering ----------
	const fmt = x => x === undefined ? '…' : x === null ? 'No KO' : x.toFixed(1) + '%';
	const swatch = v => `<svg class="swatch" width="22" height="8" aria-hidden="true"><line x1="1" y1="4" x2="21" y2="4" stroke="${familyColor(v.family)}" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="${v.dash.join(' ')}"/></svg>`;
	const colors = () => ({ grid: css('--grid'), axis: css('--axis'), muted: css('--muted'), ink: css('--ink'), ink2: css('--ink-2'), surface: css('--surface'), border: css('--border') });
	const yOpts = { yTitle: "Opponent's kill % (before the move)", yMax: 240, yStep: 20, colors };
	const chartA = new KPChart.LineChart($id('chartA'), { ...yOpts, xTitle: "Lucario's percent", xStep: 20 });
	const chartB = new KPChart.LineChart($id('chartB'), { ...yOpts, xTitle: 'Distance from the ledge', xStep: 10 });
	const xsA = Array.from({ length: 201 }, (_, L) => L);
	const nul = p => p === undefined || p === null ? null : p;

	function render() {
		const mode = state.mode, xsB = Array.from({ length: geo.maxD + 1 }, (_, d) => d);
		chartA.set(xsA, VARIANTS.map(v => {
			const kb = kbFor(v.combo, state.d, mode);
			return { label: v.label, color: familyColor(v.family), dash: v.dash, hidden: state.hidden.has(v.id), ys: xsA.map(L => nul(percent(v, L, kb))) };
		}), 200, state.L);
		chartB.set(xsB, VARIANTS.map(v => ({
			label: v.label, color: familyColor(v.family), dash: v.dash, hidden: state.hidden.has(v.id),
			ys: xsB.map(d => nul(percent(v, state.L, kbFor(v.combo, d, mode))))
		})), geo.maxD, state.d);
		$id('chartATitle').textContent = `Kill % vs Lucario's percent (opponent ${state.d} from the ledge)`;
		$id('chartBTitle').textContent = `Kill % vs distance from the ledge (Lucario at ${state.L}%)`;
		$id('rows').innerHTML = VARIANTS.map(v => {
			const n = percent(v, state.L, kbFor(v.combo, state.d, 'n')), b = percent(v, state.L, kbFor(v.combo, state.d, 'b'));
			const gap = n == null || b == null ? '' : '+' + (b - n).toFixed(1);
			return `<tr><td>${swatch(v)}${v.label}</td><td class="num">${fmt(n)}</td><td class="num">${fmt(b)}</td><td class="num">${gap}</td></tr>`;
		}).join('');
		saveSettings();
	}

	// ---------- Inputs ----------
	function showOpponent() {
		const a = physicsFor(state.opp).a;
		$id('oppStats').textContent = `Weight ${a.weight} · gravity ${a.gravity} · fall speed ${a.fallSpeed}`;
	}
	function showStage() {
		const b = geo.blast, dist = $id('dist');
		$id('stageStats').textContent = `Ledge at x = ${geo.ledgeX.toFixed(1)} · blast zones: side ${Math.round(b[1])}, top ${Math.round(b[2])}`;
		dist.max = geo.maxD;
		state.d = Math.min(state.d, geo.maxD); dist.value = state.d; $id('dOut').textContent = state.d;
	}
	function showStorage() {
		Store.count().then(n => { $id('storage').textContent = n === null ? 'Saving is unavailable in this browser, so tables are rebuilt each visit.' : `${n} opponent/stage table${n === 1 ? '' : 's'} saved in this browser.`; });
	}

	function bind() {
		const opp = $id('opp'), stage = $id('stage');
		opp.innerHTML = KP_DATA.characters.map(c => `<option${c.name === state.opp ? ' selected' : ''}>${c.name}</option>`).join('');
		stage.innerHTML = Object.keys(KP_DATA.stages).map(s => `<option${s === state.stage ? ' selected' : ''}>${s}</option>`).join('');
		$id('stock').value = state.stock;
		$id('lucPct').value = state.L; $id('lOut').textContent = state.L + '%';
		$id('legend').innerHTML = VARIANTS.map(v => `<button data-v="${v.id}" aria-pressed="${!state.hidden.has(v.id)}">${swatch(v)}${v.label}</button>`).join('');
		const setMode = m => { state.mode = m; $id('modeNo').setAttribute('aria-pressed', m === 'n'); $id('modeBest').setAttribute('aria-pressed', m === 'b'); render(); };
		setMode(state.mode);

		$id('legend').addEventListener('click', e => {
			const b = e.target.closest('button[data-v]'); if (!b) return;
			const id = b.dataset.v; if (state.hidden.has(id)) state.hidden.delete(id); else state.hidden.add(id);
			b.setAttribute('aria-pressed', !state.hidden.has(id)); render();
		});
		opp.addEventListener('change', () => { state.opp = opp.value; showOpponent(); render(); schedule(); });
		stage.addEventListener('change', () => { state.stage = stage.value; geo = Core.stage(state.stage); showStage(); render(); schedule(); });
		$id('stock').addEventListener('change', e => { state.stock = e.target.value; render(); });
		$id('lucPct').addEventListener('input', e => { state.L = +e.target.value; $id('lOut').textContent = state.L + '%'; render(); });
		$id('dist').addEventListener('input', e => { state.d = +e.target.value; $id('dOut').textContent = state.d; render(); prioritize(state.d); });
		$id('modeNo').addEventListener('click', () => setMode('n'));
		$id('modeBest').addEventListener('click', () => setMode('b'));
		$id('clearStore').addEventListener('click', () => { Store.clear().then(() => { complete.clear(); showStorage(); }); });
		if (window.matchMedia) matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { $id('legend').querySelectorAll('svg line').forEach((l, i) => l.setAttribute('stroke', familyColor(VARIANTS[i].family))); render(); });
	}

	function init() {
		bind(); showOpponent(); showStage(); showStorage();
		const check = Core.selfCheck();
		$id('selfcheck').textContent = check.ok ? `Self-check passed (Joker at FD's ledge, full-hop bair, Lucario 65%: ${check.value.toFixed(2)}%, matching the full engine).`
			: `Self-check FAILED: got ${check.value && check.value.toFixed(2)}%, expected 77.10%. The engine files may have changed; don't trust these numbers.`;
		if (!check.ok) $id('selfcheck').style.color = 'var(--bad)';
		render(); schedule();
	}

	// ---------- Console helpers ----------
	// KP.fast(id, L, d, mode): synchronous kill % for the current opponent and stage (builds what it needs)
	// KP.bench(): rebuilds the current opponent's physics from scratch and times each phase (ms)
	function buildAllSync() { envelopeJobs(false).forEach(f => f()); envelopeJobs(true).forEach(f => f()); }
	window.KP = {
		state, Core,
		fast: (id, L, d, mode) => { buildAllSync(); const v = VARIANTS.find(x => x.id === id); return percent(v, L, ensureExact(v.combo, d, mode)); },
		bench: () => {
			gen++; work = []; running = false;
			for (const m of [exact, est]) for (const k of [...m.keys()]) if (k.startsWith(pairKey() + '|')) m.delete(k);
			complete.delete(pairKey()); physicsFor(state.opp).env = {};
			const t = {}; let t0 = performance.now();
			const lap = name => { const now = performance.now(); t[name] = Math.round(now - t0); t0 = now; };
			envelopeJobs(false).forEach(f => f()); lap('neutralEnvelopes');
			exactJobs(state.d, ['n']).forEach(f => f()); lap('exactNoDIHere');
			envelopeJobs(true).forEach(f => f()); lap('diEnvelopes');
			exactJobs(state.d, ['b']).forEach(f => f()); lap('exactDIHere');
			for (let d = 0; d <= geo.maxD; d++) exactJobs(d, ['n', 'b']).forEach(f => f());
			lap('exactEverywhere');
			saveTables(); render(); showProgress();
			return t;
		}
	};
	init();
})();
