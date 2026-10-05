/**
 * image.js – Foto laden (EXIF-Ausrichtung), Arbeitskopien und Ausschnitte.
 *
 * Speicher auf dem iPad:
 *  - Safari erlaubt Canvas-Flächen nur bis ca. 16,7 Megapixel. Größere Fotos
 *    (z. B. 48-MP-Kamera) werden beim Laden auf ≤ 16 MP verkleinert.
 *  - Es gibt genau EIN Original-Canvas, eine Anzeigekopie (≤ 2048 px) und
 *    kurzlebige Arbeitskopien. Nicht mehr benötigte Canvas werden auf 0×0 gesetzt,
 *    damit Safari den Speicher sofort freigibt.
 */

const MAX_PIXELS = 16_000_000;     // Safari-Canvas-Grenze (mit Reserve)
const DISPLAY_MAX = 2048;          // Anzeige-Kopie
export const WORK_MAX = 1600;      // Segmentierung

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function releaseCanvas(c) {
  if (c) { c.width = 0; c.height = 0; }
}

/**
 * Lädt eine Bilddatei. Safari und Chrome wenden die EXIF-Ausrichtung beim
 * Dekodieren über <img> automatisch an.
 */
export async function loadPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    try {
      await img.decode();
    } catch {
      throw new Error('Das Foto konnte nicht gelesen werden (Format nicht unterstützt?).');
    }
    const W = img.naturalWidth, H = img.naturalHeight;
    if (!W || !H) throw new Error('Das Foto ist leer oder beschädigt.');
    const s = Math.min(1, Math.sqrt(MAX_PIXELS / (W * H)));
    const w = Math.round(W * s), h = Math.round(H * s);
    const orig = makeCanvas(w, h);
    const ctx = orig.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const ds = Math.min(1, DISPLAY_MAX / Math.max(w, h));
    const display = makeCanvas(w * ds, h * ds);
    const dctx = display.getContext('2d');
    dctx.imageSmoothingQuality = 'high';
    dctx.drawImage(orig, 0, 0, display.width, display.height);
    return {
      orig, display,
      width: w, height: h,
      srcWidth: W, srcHeight: H,
      reduced: s < 1,
      name: file.name || 'Foto',
      bytes: file.size || 0,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function releasePhoto(p) {
  if (!p) return;
  releaseCanvas(p.orig);
  releaseCanvas(p.display);
}

/**
 * Verkleinerte Arbeitskopie eines Bildbereichs (Originalkoordinaten).
 * @returns {{imageData: ImageData, ox:number, oy:number, scale:number}}  scale = Originalpixel je Arbeitspixel
 */
export function workImage(photo, rect = { x: 0, y: 0, w: photo.width, h: photo.height }, maxSide = WORK_MAX) {
  const s = Math.min(1, maxSide / Math.max(rect.w, rect.h));
  const c = makeCanvas(rect.w * s, rect.h * s);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(photo.orig, rect.x, rect.y, rect.w, rect.h, 0, 0, c.width, c.height);
  const imageData = ctx.getImageData(0, 0, c.width, c.height);
  releaseCanvas(c);
  return { imageData, ox: rect.x, oy: rect.y, scale: rect.w / imageData.width };
}

/** Mittlere Farbe (RGB) in einem Kreis um (x, y) im Original. */
export function sampleColor(photo, x, y, r = 8) {
  const x0 = Math.max(0, Math.round(x - r)), y0 = Math.max(0, Math.round(y - r));
  const w = Math.min(photo.width - x0, 2 * r + 1), h = Math.min(photo.height - y0, 2 * r + 1);
  const d = photo.orig.getContext('2d', { willReadFrequently: true }).getImageData(x0, y0, w, h).data;
  let R = 0, G = 0, B = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { R += d[i]; G += d[i + 1]; B += d[i + 2]; n++; }
  return [R / n, G / n, B / n];
}

/** Median der Randpixel eines ImageData (Hintergrundschätzung). */
export function borderMedianRgb(imageData) {
  const { width: w, height: h, data } = imageData;
  const band = Math.max(3, Math.round(Math.min(w, h) * 0.02));
  const H = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let n = 0;
  for (let y = 0; y < h; y++) {
    const rowBand = y < band || y >= h - band;
    for (let x = 0; x < w; x++) {
      if (!rowBand && x === band) x = w - band;
      const i = (y * w + x) * 4;
      H[0][data[i]]++; H[1][data[i + 1]]++; H[2][data[i + 2]]++; n++;
    }
  }
  return H.map(hist => {
    let acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n / 2) return v; }
    return 255;
  });
}

/* ========================================================= Masken */

/** Maske vergrößern (r > 0) oder verkleinern (r < 0), quadratisches Fenster, separabel. */
export function morphMask(mask, w, h, r) {
  if (!r) return mask;
  const grow = r > 0;
  r = Math.abs(r);
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = grow ? 0 : 1;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        const m = xx < 0 || xx >= w ? 0 : mask[y * w + xx];
        if (grow ? m : !m) { v = grow ? 1 : 0; break; }
      }
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = grow ? 0 : 1;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        const m = yy < 0 || yy >= h ? 0 : tmp[yy * w + x];
        if (grow ? m : !m) { v = grow ? 1 : 0; break; }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/** Liegt der Originalpunkt (ox, oy) in der Maske der Region? */
function maskAt(region, mask, ox, oy) {
  const mx = Math.floor((ox - region.x) / region.mScale);
  const my = Math.floor((oy - region.y) / region.mScale);
  if (mx < 0 || my < 0 || mx >= region.mw || my >= region.mh) return 0;
  return mask[my * region.mw + mx];
}

/**
 * Pixel eines Teils (nur innerhalb der etwas geschrumpften Maske) für die Farbmessung.
 * Liest aus dem Original, verkleinert auf ≤ maxSide.
 * @returns {Uint8Array} flache RGB-Tripel
 */
export function regionPixels(photo, region, maxSide = 96) {
  const s = Math.min(1, maxSide / Math.max(region.w, region.h));
  const cw = Math.max(1, Math.round(region.w * s)), ch = Math.max(1, Math.round(region.h * s));
  const c = makeCanvas(cw, ch);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(photo.orig, region.x, region.y, region.w, region.h, 0, 0, cw, ch);
  const d = ctx.getImageData(0, 0, cw, ch).data;
  releaseCanvas(c);
  // Rand der Maske meiden (Mischfarben mit dem Hintergrund)
  const shrink = Math.max(region.mw, region.mh) > 12 ? 1 : 0;
  let m = region._eroded;
  if (!m) { m = morphMask(region.mask, region.mw, region.mh, -shrink); region._eroded = m; }
  const out = [];
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const ox = region.x + (x + 0.5) / s, oy = region.y + (y + 0.5) / s;
      if (!maskAt(region, m, ox, oy)) continue;
      const i = (y * cw + x) * 4;
      out.push(d[i], d[i + 1], d[i + 2]);
    }
  }
  return Uint8Array.from(out);
}

/**
 * Ausschnitt für Brickognize / Anzeige: Box + Rand, aus dem Original,
 * verkleinert auf ≤ maxSide. Optional werden Nachbarteile mit der
 * Hintergrundfarbe übermalt (bessere Erkennung bei dicht liegenden Teilen).
 */
export function cropRegion(photo, region, { pad = 0.15, maxSide = 512, hideOthers = true, bgRgb = null } = {}) {
  const p = Math.max(8, Math.round(pad * Math.max(region.w, region.h)));
  const x0 = Math.max(0, region.x - p), y0 = Math.max(0, region.y - p);
  const x1 = Math.min(photo.width, region.x + region.w + p), y1 = Math.min(photo.height, region.y + region.h + p);
  const rw = x1 - x0, rh = y1 - y0;
  const s = Math.min(1, maxSide / Math.max(rw, rh));
  const c = makeCanvas(rw * s, rh * s);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(photo.orig, x0, y0, rw, rh, 0, 0, c.width, c.height);
  if (hideOthers && bgRgb && region.mask) {
    let m = region._dilated;
    if (!m) {
      const r = Math.max(2, Math.round(Math.max(region.mw, region.mh) * 0.05));
      // Maske um r erweitern; dafür auf ein größeres Raster legen
      const W = region.mw + 2 * r, H = region.mh + 2 * r;
      const big = new Uint8Array(W * H);
      for (let y = 0; y < region.mh; y++) big.set(region.mask.subarray(y * region.mw, (y + 1) * region.mw), (y + r) * W + r);
      m = { mask: morphMask(big, W, H, r), W, H, r };
      region._dilated = m;
    }
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const ox = x0 + (x + 0.5) / s, oy = y0 + (y + 0.5) / s;
        const mx = Math.floor((ox - region.x) / region.mScale) + m.r;
        const my = Math.floor((oy - region.y) / region.mScale) + m.r;
        const inside = mx >= 0 && my >= 0 && mx < m.W && my < m.H && m.mask[my * m.W + mx];
        if (!inside) {
          const i = (y * c.width + x) * 4;
          d[i] = bgRgb[0]; d[i + 1] = bgRgb[1]; d[i + 2] = bgRgb[2];
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }
  return c;
}

/** Canvas → Blob (JPEG/PNG), als Promise. */
export function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.9) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Bild konnte nicht erzeugt werden.'))), type, quality);
  });
}

/**
 * Region aus einem frei gewählten Rechteck (manuell antippen/aufziehen):
 * Pixel, die sich vom Hintergrund abheben, bilden die Maske.
 */
export function regionFromRect(photo, rect, bgLab, labFn, thresholdDE = 10) {
  const x = Math.max(0, Math.round(rect.x)), y = Math.max(0, Math.round(rect.y));
  const w = Math.min(photo.width - x, Math.round(rect.w)), h = Math.min(photo.height - y, Math.round(rect.h));
  if (w < 4 || h < 4) return null;
  const s = Math.min(1, 160 / Math.max(w, h));
  const mw = Math.max(1, Math.round(w * s)), mh = Math.max(1, Math.round(h * s));
  const c = makeCanvas(mw, mh);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(photo.orig, x, y, w, h, 0, 0, mw, mh);
  const d = ctx.getImageData(0, 0, mw, mh).data;
  releaseCanvas(c);
  let mask = new Uint8Array(mw * mh);
  let n = 0;
  for (let i = 0; i < mw * mh; i++) {
    const lab = labFn(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
    const dl = lab[0] - bgLab[0], da = lab[1] - bgLab[1], db = lab[2] - bgLab[2];
    if (Math.sqrt((dl < 0 ? dl * 0.6 : dl) ** 2 + da * da + db * db) > thresholdDE) { mask[i] = 1; n++; }
  }
  if (n < mw * mh * 0.03) { mask.fill(1); n = mw * mh; }   // nichts erkannt → ganzes Rechteck
  // Maske auf ihre Box zuschneiden
  let bx0 = mw, by0 = mh, bx1 = -1, by1 = -1;
  for (let yy = 0; yy < mh; yy++) for (let xx = 0; xx < mw; xx++) {
    if (mask[yy * mw + xx]) { if (xx < bx0) bx0 = xx; if (xx > bx1) bx1 = xx; if (yy < by0) by0 = yy; if (yy > by1) by1 = yy; }
  }
  const nw = bx1 - bx0 + 1, nh = by1 - by0 + 1;
  const m2 = new Uint8Array(nw * nh);
  for (let yy = 0; yy < nh; yy++) m2.set(mask.subarray((yy + by0) * mw + bx0, (yy + by0) * mw + bx0 + nw), yy * nw);
  mask = m2;
  const mScale = w / mw;
  return {
    x: x + bx0 * mScale, y: y + by0 * mScale, w: nw * mScale, h: nh * mScale,
    mask, mw: nw, mh: nh, mScale,
    area: n * mScale * mScale,
    cx: x + (bx0 + nw / 2) * mScale, cy: y + (by0 + nh / 2) * mScale,
    border: false, large: false, split: false, manual: true,
  };
}
