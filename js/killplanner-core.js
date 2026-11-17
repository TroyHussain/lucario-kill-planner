// Lucario kill planner core. Needs only formulas.js and knockback.js (Knockback, DamageSpeedUpFrames, ...) and
// KP_DATA from killplanner-data.js, so the page runs from a double-click with no server and no network.
//
// The KO question splits in two:
//   1. Physics: the knockback KB* needed to KO from a position. A flight depends only on its knockback, launch
//      angle, the opponent's gravity/fall speeds and the DI stick, never on where it starts. So each opponent gets
//      one table of free flights over a knockback grid ("envelopes"); KB* for any position and stage is read off
//      it, then pinned down exactly with a few real flights.
//   2. Formula: the knockback formula is linear in the opponent's percent, so the kill percent for any Lucario
//      percent (aura, rage), stock difference, move and short hop is a closed-form inverse of KB*.
var KPCore = (function () {
	'use strict';

	const VERSION = 'core-4';   // bump when the physics or formula changes, so stored tables are recomputed
	const FRESH = 1.05, SH_MULT = 0.85, ONE_V_ONE = 1.2;
	const KB_GRID = Array.from({ length: 231 }, (_, i) => 40 + 2 * i);

	// Lucario's kill moves. Launch class = launch angle + whether the opponent is airborne; bair, dair and ftilt
	// share one class (Sakurai angle, 38° at kill knockback).
	const M = KP_DATA.lucario;
	const VARIANTS = [
		{ id: 'bairFH', label: 'Bair (full hop)', family: 0, move: M.bair, dash: [] },
		{ id: 'bairSH', label: 'Bair (short hop)', family: 0, move: M.bair, sh: true, dash: [6, 4] },
		{ id: 'dairFH', label: 'Dair (full hop)', family: 1, move: M.dair, dash: [] },
		{ id: 'dairSH', label: 'Dair (short hop)', family: 1, move: M.dair, sh: true, dash: [6, 4] },
		{ id: 'uairSH', label: 'Uair (short hop, 18.19)', family: 2, move: M.uair, sh: true, height: 18.19, dash: [6, 4] },
		{ id: 'uairFH', label: 'Uair (full hop, 37.62)', family: 2, move: M.uair, height: 37.62, dash: [] },
		{ id: 'uairDJ', label: 'Uair (double jump, 75.24)', family: 2, move: M.uair, height: 75.24, dash: [2, 3] },
		{ id: 'ftilt', label: 'Ftilt', family: 3, move: M.ftilt, dash: [] },
		{ id: 'dash', label: 'Dash attack', family: 4, move: M.dash, dash: [] },
		{ id: 'fairFH', label: 'Fair (full hop, 37.62)', family: 5, move: M.fair, height: 37.62, dash: [] },
		{ id: 'fairDJ', label: 'Fair (double jump, 75.24)', family: 5, move: M.fair, height: 75.24, dash: [2, 3] },
		{ id: 'utilt', label: 'Utilt', family: 6, move: M.utilt, dash: [] },
		{ id: 'espeed', label: 'Extreme Speed', family: 7, move: M.espeed, dash: [10, 3, 2, 3] }
	];
	const CLASSES = {};
	VARIANTS.forEach(v => {
		v.cls = v.move.angle + (v.height ? 'a' : 'g');
		CLASSES[v.cls] = { angle: v.move.angle, aerial: !!v.height };
		v.combo = v.cls + '@' + (v.height || 0);   // the launch class plus the starting height
	});
	const COMBOS = [...new Set(VARIANTS.map(v => v.combo))];

	// DI stick positions, exactly as Calculator.GenerateStickPositions (GameCube controller, deadzone skipped)
	function sticks(step) {
		const list = [];
		for (let i = 0; i < 360; i += step) {
			let x = Math.floor(128 * Math.cos(i * PI / 180)), y = Math.floor(128 * Math.sin(i * PI / 180));
			x = Math.max(-127, Math.min(128, x)); y = Math.max(-127, Math.min(128, y));
			if (x != 0 && x > -24 && x < 24) continue;
			if (y != 0 && y > -24 && y < 24) continue;
			list.push({ x, y });
		}
		return list;
	}
	const S5 = [{ x: 0, y: 0 }].concat(sticks(5)), S1 = sticks(1);

	// Same value as +x.toFixed(6), which the engine applies every frame, without the string round trip
	const fix6 = x => { const s = x * 1e6, f = s - Math.floor(s); return (f > 0.499999 && f < 0.500001) ? +x.toFixed(6) : Math.round(s) / 1e6; };

	// One free flight from (0,0): a lean copy of Distance's loop with no stage (same arithmetic and rounding,
	// verified bit-identical). Returns the features Distance's KO check uses: furthest right, furthest left,
	// highest, lowest, and highest point while still rising at launch speed >= 2.4.
	function flight(kb, cls, stick, a) {
		const k = new Knockback(kb, cls.angle, a.gravity, a.dftGravity, cls.aerial, false, false, 0, false, stick, 1);
		const su = k.tumble ? DamageSpeedUpFrames(Math.max(0, FirstActionableFrame(k.base_kb, false, false)), k.angle) : [];
		const rawH = Math.max(0, k.hitstun), H = k.tumble ? su[su.length - 1] : rawH;
		const ang = k.angle * PI / 180, cosA = Math.cos(ang), sinA = Math.sin(ang);
		const dx = parameters.decay * cosA, dy = parameters.decay * sinA;
		let lx = fix6(+k.horizontal_launch_speed), ly = fix6(+k.vertical_launch_speed);
		if (cosA < 0) lx = -lx;
		if (sinA < 0) ly = -ly;
		const dft = k.tumble && k.damageflytop, limit = rawH < 200 ? rawH : 200;
		let px = 0, py = 0, cy = 0, g = 0, fg = 0;
		const xs = [0], ys = [0], vs = [];
		for (let i = 0; i < limit; i++) {
			const nx = px + lx, ny = py + ly + cy;
			vs.push(ly);
			if (lx !== 0) { const pos = lx > 0; lx = fix6(lx - dx); if (!pos && lx > 0) lx = 0; else if (pos && lx < 0) lx = 0; }
			if (ly !== 0) { const pos = ly > 0; ly = fix6(ly - dy); if (!pos && ly > 0) ly = 0; else if (pos && ly < 0) ly = 0; }
			if (!dft) { g -= a.gravity; fg = Math.max(g, -a.fallSpeed); }
			else if (i < rawH) { g -= a.dftGravity; fg = Math.max(g, -a.dftFallSpeed); }
			else {
				if (i === rawH) g = fg;
				if (cy < -a.fallSpeed) { g += a.gravity; fg = Math.min(g, -a.fallSpeed); } else { g -= a.gravity; fg = Math.max(g, -a.fallSpeed); }
			}
			cy = fix6(fg);
			px = nx; py = ny;
			if (!(i + 1 < su.length && k.tumble) || GetFrameWithSpeedUp(su, i) === i) { xs.push(fix6(px)); ys.push(fix6(py)); }
		}
		vs.push(ly);
		const anyTop = H < (2.4 / 0.03) * 0.4;
		let xMax = -Infinity, xMin = Infinity, yMax = -Infinity, yMin = Infinity, y24 = -Infinity;
		for (let i = 0; i <= H && i < xs.length; i++) {
			const x = xs[i], y = ys[i];
			if (x > xMax) xMax = x; if (x < xMin) xMin = x; if (y > yMax) yMax = y; if (y < yMin) yMin = y;
			if ((anyTop || vs[i] >= 2.4) && y > y24) y24 = y;
		}
		return [xMax, xMin, yMax, yMin, y24];
	}

	// Distance's KO test for a flight's features from start (x0, y0): side or bottom blast zone, above the top
	// blast zone by 30, or above it while still rising at >= 2.4.
	const koFrom = (f, x0, y0, bz) => x0 + f[0] >= bz[1] || x0 + f[1] <= bz[0] || y0 + f[3] <= bz[3] || y0 + f[2] >= bz[2] + 30 || y0 + f[4] >= bz[2];

	// Features of every knockback on the grid for one class and stick, made monotone in knockback (the only
	// non-monotone points are at knockback 80, where tumble starts, far below any kill)
	function envelope(cls, stick, a) {
		const n = KB_GRID.length, f = [0, 1, 2, 3, 4].map(() => new Float64Array(n));
		KB_GRID.forEach((kb, i) => { const r = flight(kb, cls, stick, a); for (let j = 0; j < 5; j++) f[j][i] = r[j]; });
		for (let i = 1; i < n; i++) {
			for (const j of [0, 2, 4]) if (f[j][i] < f[j][i - 1]) f[j][i] = f[j][i - 1];
			for (const j of [1, 3]) if (f[j][i] > f[j][i - 1]) f[j][i] = f[j][i - 1];
		}
		return f;
	}

	function crossing(arr, need, up) {
		const n = arr.length, ok = i => up ? arr[i] >= need : arr[i] <= need;
		if (!ok(n - 1)) return Infinity;
		if (ok(0)) return KB_GRID[0];
		let lo = 0, hi = n - 1;
		while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ok(m)) hi = m; else lo = m; }
		const f0 = arr[lo], f1 = arr[hi];
		if (!isFinite(f0) || f1 === f0) return KB_GRID[hi];
		return KB_GRID[lo] + (need - f0) / (f1 - f0) * (KB_GRID[hi] - KB_GRID[lo]);
	}
	// Smooth estimate of KB* from one envelope (within ~1 knockback of exact)
	const estimateKB = (f, x0, y0, bz) => Math.min(crossing(f[0], bz[1] - x0, true), crossing(f[1], bz[0] - x0, false),
		crossing(f[3], bz[3] - y0, false), crossing(f[2], bz[2] + 30 - y0, true), crossing(f[4], bz[2] - y0, true));

	// Exact KB* by bisection on real flights around an estimate (flights count whole frames, so the true
	// threshold has small steps the smooth estimate can't follow)
	function exactKB(cls, stick, a, x0, y0, bz, guess) {
		if (!isFinite(guess)) return guess;
		const ko = kb => koFrom(flight(kb, cls, stick, a), x0, y0, bz);
		let lo = Math.max(1, guess - 3), hi = guess + 3;
		while (ko(lo)) { hi = lo; lo -= 6; if (lo < 1) return hi; }
		while (!ko(hi)) { lo = hi; hi += 6; if (hi > 2000) return Infinity; }
		while (hi - lo > 0.02) { const m = (lo + hi) / 2; if (ko(m)) hi = m; else lo = m; }
		return hi;
	}

	// For each 5° stick, the 1° sticks strictly between its neighbouring 5° sticks. Usually that's ±4°, but the
	// stick deadzone leaves wider gaps (e.g. no 5° stick between 165° and 180°, while 166°–169° exist at 1°).
	const deg = s => (Math.atan2(s.y, s.x) * 180 / Math.PI + 360) % 360;
	const NEIGHBOURHOOD = (function () {
		const ring = S5.slice(1).map((s, k) => ({ i: k + 1, a: deg(s) })).sort((p, q) => p.a - q.a), out = [[]];
		const between = (lo, hi, a) => lo < hi ? a > lo && a < hi : a > lo || a < hi;
		ring.forEach((r, k) => {
			const prev = ring[(k - 1 + ring.length) % ring.length].a, nxt = ring[(k + 1) % ring.length].a;
			out[r.i] = S1.filter(s => between(prev, nxt, deg(s)));
		});
		return out;
	})();

	// KB* for a launch class from (x0, y0). envs = the class's envelopes, indexed like S5 (0 = neutral stick).
	// mode 'n' = no DI; 'b' = the opponent's best survival DI: rank every 5° stick by estimate, settle the top 5
	// exactly, then try every 1° stick between the neighbours of each of the best 3. The DI landscape has
	// near-tied peaks, and the best stick often sits at a deadzone edge (e.g. 169°) between 5° positions.
	function kbStar(cls, envs, a, x0, y0, bz, mode) {
		if (mode === 'n') return exactKB(cls, S5[0], a, x0, y0, bz, estimateKB(envs[0], x0, y0, bz));
		const settled = envs.map((f, i) => [estimateKB(f, x0, y0, bz), i]).sort((p, q) => q[0] - p[0]).slice(0, 5)
			.map(([e, i]) => [exactKB(cls, S5[i], a, x0, y0, bz, e), i]).sort((p, q) => q[0] - p[0]);
		let best = settled[0][0];
		for (const [k, i] of settled.slice(0, 3)) {
			if (!isFinite(k) || i === 0) continue;
			for (const s of NEIGHBOURHOOD[i]) { const kk = exactKB(cls, s, a, x0, y0, bz, k); if (kk > best) best = kk; }
		}
		return best;
	}
	const estimateStar = (envs, x0, y0, bz, mode) => mode === 'n' ? estimateKB(envs[0], x0, y0, bz) : Math.max(...envs.map(f => estimateKB(f, x0, y0, bz)));

	// Inverse of VSKB: the opponent's percent (before the move) at which this move deals knockback kb.
	// Fresh move, 1v1, Lucario aura from his percent and the stock difference, rage from his percent.
	function percentFor(v, L, kb, weight, stock) {
		if (kb === undefined) return undefined;
		if (!isFinite(kb)) return null;
		const aura = Aura(L, stock, 2), rage = Rage(L), c = 1 - (1 - FRESH) * 0.3;
		const base = v.move.damage * aura;
		let dmg = base, pre = v.move.pre * aura * ONE_V_ONE;   // earlier hits of the move deal 1v1 damage
		if (v.sh) { dmg *= SH_MULT; pre *= SH_MULT; }   // short hop scales damage dealt, not the formula's damage term
		const P = ((kb / rage - v.move.bkb) * 100 / v.move.kbg - 18) / (1.4 * 200 / (weight + 100)) / (0.1 + base * c / 20);
		const J = P - (pre + dmg) * FRESH;
		return J > 999 ? null : Math.max(0, J);
	}

	function stage(name) {
		const s = KP_DATA.stages[name];
		const floorY = x => {
			let y = null;
			for (const [x1, y1, x2, y2] of s.floors) {
				if (x < x1 - 1e-6 || x > x2 + 1e-6) continue;
				const yy = y1 + (x - x1) / (x2 - x1) * (y2 - y1);
				if (y === null || yy > y) y = yy;
			}
			return y === null ? s.ledgeY : y;
		};
		return { name, ledgeX: s.ledgeX, maxD: Math.floor(s.ledgeX), floorY, blast: s.blast };
	}

	function character(name) {
		const c = KP_DATA.characters.find(x => x.name === name);
		return c && { name: c.name, weight: c.weight, gravity: c.gravity, dftGravity: c.dftGravity, fallSpeed: c.fallSpeed, dftFallSpeed: c.dftFallSpeed };
	}

	// Quick end-to-end check against a value verified with the full engine (Joker at FD's ledge, 2 units in,
	// full-hop bair, Lucario 65%, no DI: 77.10%)
	function selfCheck() {
		const a = character('Joker'), st = stage('Final Destination'), v = VARIANTS[0], cls = CLASSES[v.cls], x0 = st.ledgeX - 2;
		const kb = kbStar(cls, [envelope(cls, S5[0], a)], a, x0, st.floorY(x0), st.blast, 'n');
		const J = percentFor(v, 65, kb, a.weight, '0');
		return { ok: Math.abs(J - 77.1) < 0.05, value: J };
	}

	return { VERSION, VARIANTS, CLASSES, COMBOS, KB_GRID, S5, S1, sticks, fix6, flight, envelope, estimateKB, exactKB, kbStar, estimateStar, percentFor, stage, character, selfCheck };
})();
