// Minimal canvas line chart for the kill planner (no dependencies, so the page works offline).
// Series share one x grid; y values may be null (gap). Colors come from a callback so dark mode can restyle.
var KPChart = (function () {
	'use strict';

	const PAD = { left: 50, right: 14, top: 10, bottom: 40 };

	function LineChart(canvas, opts) {
		this.canvas = canvas;
		this.opts = opts;   // { xTitle, yTitle, yMax, yStep, xStep, colors() }
		this.xs = []; this.series = []; this.xMax = 1; this.marker = null; this.hover = null;
		const redraw = () => this.draw();
		if (window.ResizeObserver) new ResizeObserver(redraw).observe(canvas);
		window.addEventListener('resize', redraw);
		canvas.addEventListener('mousemove', e => this.onMove(e));
		canvas.addEventListener('mouseleave', () => { this.hover = null; this.draw(); });
		// Touch: tap or drag along a line to read values (vertical drags still scroll the page)
		const touch = e => { if (e.touches[0]) this.onMove(e.touches[0]); };
		canvas.addEventListener('touchstart', touch, { passive: true });
		canvas.addEventListener('touchmove', touch, { passive: true });
	}

	LineChart.prototype.set = function (xs, series, xMax, marker) {
		this.xs = xs; this.series = series; this.xMax = xMax; this.marker = marker;
		if (this.hover && (!series[this.hover.s] || series[this.hover.s].hidden)) this.hover = null;
		this.draw();
	};

	LineChart.prototype.geometry = function () {
		const w = this.canvas.clientWidth, h = this.canvas.clientHeight, o = this.opts;
		const plot = { x: PAD.left, y: PAD.top, w: Math.max(10, w - PAD.left - PAD.right), h: Math.max(10, h - PAD.top - PAD.bottom) };
		return {
			w, h, plot,
			px: x => plot.x + x / this.xMax * plot.w,
			py: y => plot.y + plot.h - y / o.yMax * plot.h
		};
	};

	LineChart.prototype.draw = function () {
		const c = this.canvas, dpr = window.devicePixelRatio || 1, g = this.geometry(), o = this.opts, col = o.colors();
		if (!g.w || !g.h) return;
		if (c.width !== Math.round(g.w * dpr) || c.height !== Math.round(g.h * dpr)) { c.width = Math.round(g.w * dpr); c.height = Math.round(g.h * dpr); }
		const ctx = c.getContext('2d'), p = g.plot;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, g.w, g.h);
		ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';

		// Grid and y ticks
		ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
		for (let y = 0; y <= o.yMax; y += o.yStep) {
			const yy = Math.round(g.py(y)) + 0.5;
			ctx.strokeStyle = col.grid; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(p.x, yy); ctx.lineTo(p.x + p.w, yy); ctx.stroke();
			ctx.fillStyle = col.muted; ctx.fillText(String(y), p.x - 6, yy);
		}
		// x axis and ticks
		const base = Math.round(p.y + p.h) + 0.5;
		ctx.strokeStyle = col.axis; ctx.beginPath(); ctx.moveTo(p.x, base); ctx.lineTo(p.x + p.w, base); ctx.stroke();
		ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = col.muted;
		for (let x = 0; x <= this.xMax; x += o.xStep) ctx.fillText(String(x), g.px(x), base + 5);
		if (this.xMax % o.xStep) ctx.fillText(String(this.xMax), g.px(this.xMax), base + 5);
		// Axis titles
		ctx.fillStyle = col.ink2; ctx.font = '12px system-ui, -apple-system, "Segoe UI", sans-serif';
		ctx.fillText(o.xTitle, p.x + p.w / 2, base + 21);
		ctx.save(); ctx.translate(13, p.y + p.h / 2); ctx.rotate(-Math.PI / 2); ctx.textBaseline = 'middle'; ctx.fillText(o.yTitle, 0, 0); ctx.restore();

		// Series, clipped to the plot
		ctx.save(); ctx.beginPath(); ctx.rect(p.x, p.y, p.w, p.h); ctx.clip();
		ctx.lineJoin = 'round'; ctx.lineCap = 'round';
		this.series.forEach((s, si) => {
			if (s.hidden) return;
			ctx.strokeStyle = s.color; ctx.lineWidth = this.hover && this.hover.s === si ? 3 : 2; ctx.setLineDash(s.dash || []);
			ctx.beginPath();
			let pen = false;
			s.ys.forEach((y, i) => {
				if (y === null || y === undefined) { pen = false; return; }
				const X = g.px(this.xs[i]), Y = g.py(y);
				if (pen) ctx.lineTo(X, Y); else { ctx.moveTo(X, Y); pen = true; }
			});
			ctx.stroke();
		});
		ctx.setLineDash([]);
		// Marker for the current slider value
		if (this.marker !== null && this.marker !== undefined) {
			const mx = Math.round(g.px(this.marker)) + 0.5;
			ctx.strokeStyle = col.axis; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
			ctx.beginPath(); ctx.moveTo(mx, p.y); ctx.lineTo(mx, p.y + p.h); ctx.stroke(); ctx.setLineDash([]);
		}
		ctx.restore();

		// Hover point and tooltip
		if (this.hover) {
			const s = this.series[this.hover.s], i = this.hover.i, X = g.px(this.xs[i]), Y = g.py(s.ys[i]);
			ctx.fillStyle = s.color; ctx.strokeStyle = col.surface; ctx.lineWidth = 2;
			ctx.beginPath(); ctx.arc(X, Y, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
			const lines = [s.label, `${o.xTitle}: ${this.xs[i]} → kills at ${s.ys[i].toFixed(1)}%`];
			ctx.font = '12px system-ui, -apple-system, "Segoe UI", sans-serif';
			const tw = Math.max(...lines.map(t => ctx.measureText(t).width)) + 16, th = 42;
			let tx = X + 12, ty = Y - th - 8;
			if (tx + tw > g.w - 4) tx = X - tw - 12;
			if (ty < 4) ty = Y + 12;
			ctx.fillStyle = col.surface; ctx.strokeStyle = col.border; ctx.lineWidth = 1;
			ctx.beginPath(); ctx.rect(tx + 0.5, ty + 0.5, tw, th); ctx.fill(); ctx.stroke();
			ctx.textAlign = 'left'; ctx.textBaseline = 'top';
			ctx.fillStyle = col.ink; ctx.fillText(lines[0], tx + 8, ty + 6);
			ctx.fillStyle = col.ink2; ctx.fillText(lines[1], tx + 8, ty + 23);
		}
	};

	// Nearest visible point to the mouse, within 28 px
	LineChart.prototype.onMove = function (e) {
		const r = this.canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top, g = this.geometry();
		let best = null, bestD = 28 * 28;
		this.series.forEach((s, si) => {
			if (s.hidden) return;
			s.ys.forEach((y, i) => {
				if (y === null || y === undefined || y > this.opts.yMax) return;
				const dx = g.px(this.xs[i]) - mx, dy = g.py(y) - my, d = dx * dx + dy * dy;
				if (d < bestD) { bestD = d; best = { s: si, i }; }
			});
		});
		const changed = (best && (!this.hover || best.s !== this.hover.s || best.i !== this.hover.i)) || (!best && this.hover);
		this.hover = best;
		if (changed) this.draw();
	};

	return { LineChart };
})();
