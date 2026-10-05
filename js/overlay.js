/**
 * overlay.js – Zoombare Bildansicht mit Boxen (Canvas, Touch).
 *
 * - Ein Finger: verschieben; zwei Finger: zoomen; Doppeltipp: hinein-/herauszoomen
 * - Tippen: onTap(x, y) in Originalkoordinaten
 * - Rechteck-Modus: Aufziehen → onRect({x,y,w,h})
 * - Gezeichnet wird die verkleinerte Anzeige-Kopie (≤ 2048 px), Boxen als Vektor-
 *   Overlay → flüssig auch bei 12-MP-Fotos.
 */

export class Viewer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{onTap?:Function, onRect?:Function}} opts
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts;
    this.img = null;          // Canvas/Bitmap, das gezeichnet wird
    this.ow = 1; this.oh = 1; // Originalgröße (Koordinatensystem der Boxen)
    this.s = 1; this.tx = 0; this.ty = 0;   // Bildschirm = Original · s + t (CSS-Pixel)
    this.boxes = [];
    this.dim = 'show';        // 'show' | 'dim' | 'hide'
    this.rectMode = false;
    this.marker = null;       // {x,y} z. B. angetippter Hintergrund
    this.pointers = new Map();
    this.gesture = null;
    this.lastTap = 0;
    this._raf = 0;

    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', e => this._down(e));
    canvas.addEventListener('pointermove', e => this._move(e));
    canvas.addEventListener('pointerup', e => this._up(e));
    canvas.addEventListener('pointercancel', e => this._up(e, true));
    canvas.addEventListener('wheel', e => this._wheel(e), { passive: false });
    // iOS: eigene Gesten-Events von Safari unterdrücken (sonst zoomt die Seite)
    canvas.addEventListener('gesturestart', e => e.preventDefault());
    this._ro = new ResizeObserver(() => { this._resize(); });
    this._ro.observe(canvas);
  }

  setImage(img, origW, origH) {
    this.img = img;
    this.ow = origW || img.width;
    this.oh = origH || img.height;
    this._resize();
    this.fit();
  }

  /** Bild entfernen (vor dem Freigeben des Canvas aufrufen!). */
  clear() { this.img = null; this.boxes = []; this.redraw(); }

  setBoxes(boxes) { this.boxes = boxes || []; this.redraw(); }
  setDim(mode) { this.dim = mode; this.redraw(); }
  setMarker(m) { this.marker = m; this.redraw(); }

  _resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      const first = this.cw === undefined || this.cw <= 1;
      this.canvas.width = w; this.canvas.height = h;
      this.cw = r.width; this.ch = r.height; this.dpr = dpr;
      if (first && this.img) this.fit();
    }
    this.cw = r.width; this.ch = r.height; this.dpr = dpr;
    this.redraw();
  }

  /** Ganzes Bild einpassen. */
  fit() {
    if (!this.img || !this.cw) return;
    this.s = Math.min(this.cw / this.ow, this.ch / this.oh);
    this.tx = (this.cw - this.ow * this.s) / 2;
    this.ty = (this.ch - this.oh * this.s) / 2;
    this.redraw();
  }

  get fitScale() { return Math.min(this.cw / this.ow, this.ch / this.oh); }

  /** Auf ein Rechteck (Original) zoomen, mit kurzer Animation. */
  zoomTo(rect, padFactor = 2.5) {
    if (!this.cw) return;
    const w = Math.max(rect.w, 20) * padFactor, h = Math.max(rect.h, 20) * padFactor;
    const s = Math.min(this.cw / w, this.ch / h, this.fitScale * 12);
    const tx = this.cw / 2 - (rect.x + rect.w / 2) * s;
    const ty = this.ch / 2 - (rect.y + rect.h / 2) * s;
    const from = { s: this.s, tx: this.tx, ty: this.ty };
    const t0 = performance.now();
    const step = now => {
      const k = Math.min(1, (now - t0) / 280);
      const e = 1 - (1 - k) ** 3;
      this.s = from.s + (s - from.s) * e;
      this.tx = from.tx + (tx - from.tx) * e;
      this.ty = from.ty + (ty - from.ty) * e;
      this._draw();
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  toOrig(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (clientX - r.left - this.tx) / this.s, y: (clientY - r.top - this.ty) / this.s };
  }

  _zoomAt(px, py, factor) {
    const ns = Math.max(this.fitScale * 0.5, Math.min(this.fitScale * 20, this.s * factor));
    const f = ns / this.s;
    this.tx = px - (px - this.tx) * f;
    this.ty = py - (py - this.ty) * f;
    this.s = ns;
    this.redraw();
  }

  /* ------------------------------------------------------------ Eingaben */

  _local(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _down(e) {
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, this._local(e));
    if (this.pointers.size === 1) {
      const p = this._local(e);
      this.gesture = { type: this.rectMode ? 'rect' : 'pan', start: p, last: p, t: performance.now(), moved: 0 };
      if (this.rectMode) this.dragRect = { a: this.toOrig(e.clientX, e.clientY), b: null };
    } else if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.gesture = { type: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, moved: 99 };
      this.dragRect = null;
    }
  }

  _move(e) {
    if (!this.pointers.has(e.pointerId)) return;
    const p = this._local(e);
    this.pointers.set(e.pointerId, p);
    const g = this.gesture;
    if (!g) return;
    if (g.type === 'pan') {
      this.tx += p.x - g.last.x;
      this.ty += p.y - g.last.y;
      g.moved += Math.hypot(p.x - g.last.x, p.y - g.last.y);
      g.last = p;
      this.redraw();
    } else if (g.type === 'rect') {
      g.moved += Math.hypot(p.x - g.last.x, p.y - g.last.y);
      g.last = p;
      this.dragRect.b = this.toOrig(e.clientX, e.clientY);
      this.redraw();
    } else if (g.type === 'pinch' && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      this.tx += cx - g.cx; this.ty += cy - g.cy;
      this._zoomAt(cx, cy, d / Math.max(1, g.d));
      g.d = d; g.cx = cx; g.cy = cy;
    }
  }

  _up(e, cancel = false) {
    const g = this.gesture;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size > 0) {
      // Von Pinch zurück auf einen Finger: als Pan weiter, ohne Sprung
      const p = [...this.pointers.values()][0];
      this.gesture = { type: 'pan', start: p, last: p, t: 0, moved: 99 };
      return;
    }
    this.gesture = null;
    if (!g || cancel) { this.dragRect = null; return; }
    const now = performance.now();
    const isTap = g.moved < 10 && now - g.t < 400;
    if (g.type === 'rect') {
      const r = this.dragRect;
      this.dragRect = null;
      if (r && r.b && !isTap) {
        const rect = { x: Math.min(r.a.x, r.b.x), y: Math.min(r.a.y, r.b.y), w: Math.abs(r.b.x - r.a.x), h: Math.abs(r.b.y - r.a.y) };
        if (this.opts.onRect) this.opts.onRect(rect);
      } else if (isTap && this.opts.onTap) {
        const o = this.toOrig(e.clientX, e.clientY);
        this.opts.onTap(o.x, o.y, { manual: true });
      }
      this.redraw();
      return;
    }
    if (!isTap) return;
    const p = this._local(e);
    if (now - this.lastTap < 300) {
      // Doppeltipp
      this.lastTap = 0;
      if (this.s > this.fitScale * 2.5) this.fit(); else this._zoomAt(p.x, p.y, 2.5);
      return;
    }
    this.lastTap = now;
    const o = this.toOrig(e.clientX, e.clientY);
    if (this.opts.onTap) this.opts.onTap(o.x, o.y, {});
  }

  _wheel(e) {
    e.preventDefault();
    const p = this._local(e);
    this._zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0015));
  }

  /** Box unter einem Punkt (kleinste zuerst, damit verschachtelte erreichbar sind). */
  boxAt(x, y) {
    const pad = 6 / this.s;
    const hits = this.boxes.filter(b => !b.hidden && x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad);
    hits.sort((a, b) => a.w * a.h - b.w * b.h);
    return hits[0] || null;
  }

  /* ------------------------------------------------------------ Zeichnen */

  redraw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._draw(); });
  }

  _draw() {
    const { ctx } = this;
    ctx.setTransform(this.dpr || 1, 0, 0, this.dpr || 1, 0, 0);
    ctx.clearRect(0, 0, this.cw, this.ch);
    if (!this.img || !this.img.width) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = this.s * (this.ow / this.img.width) > 1.5 ? 'low' : 'high';
    ctx.drawImage(this.img, 0, 0, this.img.width, this.img.height, this.tx, this.ty, this.ow * this.s, this.oh * this.s);
    drawBoxes(ctx, this.boxes, this.dim, this.s, this.tx, this.ty, this.ow, this.oh, 1);
    if (this.marker) {
      const x = this.marker.x * this.s + this.tx, y = this.marker.y * this.s + this.ty;
      ctx.lineWidth = 3; ctx.strokeStyle = '#fff';
      ctx.beginPath(); ctx.arc(x, y, 14, 0, 7); ctx.stroke();
      ctx.lineWidth = 1.5; ctx.strokeStyle = '#000';
      ctx.beginPath(); ctx.arc(x, y, 14, 0, 7); ctx.stroke();
    }
    if (this.dragRect && this.dragRect.b) {
      const { a, b } = this.dragRect;
      ctx.setLineDash([6, 4]); ctx.lineWidth = 2; ctx.strokeStyle = '#38bdf8';
      ctx.strokeRect(Math.min(a.x, b.x) * this.s + this.tx, Math.min(a.y, b.y) * this.s + this.ty,
        Math.abs(b.x - a.x) * this.s, Math.abs(b.y - a.y) * this.s);
      ctx.setLineDash([]);
    }
  }
}

/**
 * Zeichnet Boxen. Gemeinsam genutzt von der Ansicht und dem PNG-Export.
 * box: {x,y,w,h, color, label?, kind:'hit'|'other'|'selected', hidden?}
 */
export function drawBoxes(ctx, boxes, dim, s, tx, ty, ow, oh, uiScale) {
  const hits = boxes.filter(b => b.kind === 'hit' || b.kind === 'selected');
  if (dim === 'dim' && hits.length) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(tx, ty, ow * s, oh * s);
    for (const b of hits) ctx.rect(b.x * s + tx - 4 * uiScale, b.y * s + ty - 4 * uiScale, b.w * s + 8 * uiScale, b.h * s + 8 * uiScale);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fill('evenodd');
    ctx.restore();
  }
  const fontPx = 12 * uiScale;
  ctx.font = `600 ${fontPx}px -apple-system, system-ui, sans-serif`;
  ctx.textBaseline = 'top';
  // Nicht-Treffer zuerst, Treffer obenauf
  const order = boxes.filter(b => !b.hidden && !(dim === 'hide' && b.kind === 'other'))
    .sort((a, b) => (a.kind === 'other') - (b.kind === 'other')).reverse();
  for (const b of order) {
    const x = b.x * s + tx, y = b.y * s + ty, w = b.w * s, h = b.h * s;
    const other = b.kind === 'other';
    ctx.lineWidth = (other ? 1.5 : b.kind === 'selected' ? 4 : 3) * uiScale;
    if (!other) { ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.strokeRect(x - 1, y - 1, w + 2, h + 2); }
    ctx.strokeStyle = b.color;
    if (b.dashed) ctx.setLineDash([5 * uiScale, 4 * uiScale]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    if (b.label && (!other || w > 60 * uiScale)) {
      const text = b.label;
      const tw = ctx.measureText(text).width + 8 * uiScale;
      const th = fontPx + 6 * uiScale;
      let ly = y - th - 2 * uiScale;
      if (ly < 0) ly = y + h + 2 * uiScale;
      ctx.fillStyle = b.color;
      ctx.fillRect(x - ctx.lineWidth / 2, ly, tw, th);
      ctx.fillStyle = b.textColor || '#000';
      ctx.fillText(text, x - ctx.lineWidth / 2 + 4 * uiScale, ly + 3 * uiScale);
    }
  }
}
