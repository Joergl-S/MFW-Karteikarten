/**
 * color.js – Farbhilfen: Auswahlliste, sRGB→Lab, CIEDE2000, Farbmessung pro Teil.
 */

/** Rebrickable-Pseudofarben, die in der Auswahl nichts verloren haben. */
const HIDDEN_COLOR_IDS = new Set([-1, 9999]);   // [Unknown], [No Color/Any Color]

export function hexToRgb(hex) {
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]) {
  return [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/**
 * Sortiert die Farben für die Auswahl: häufige Farben zuerst (falls colors.csv
 * die Spalte num_parts enthält), sonst alphabetisch; transparente ans Ende.
 */
export function pickerColors(colors) {
  const list = colors.filter(c => !HIDDEN_COLOR_IDS.has(c.id));
  const hasCounts = list.some(c => c.numParts > 0);
  list.sort((a, b) =>
    (a.trans - b.trans) ||
    (hasCounts ? b.numParts - a.numParts : 0) ||
    a.name.localeCompare(b.name));
  return list;
}

/** CSS-Hintergrund für ein Farbfeld (transparente Farben mit Karomuster). */
export function swatchStyle(color) {
  if (!color) {
    return 'background: conic-gradient(#ef4444 0 25%, #eab308 0 50%, #22c55e 0 75%, #3b82f6 0)';
  }
  const hex = '#' + color.rgb;
  if (!color.trans) return `background:${hex}`;
  return `background: linear-gradient(${hex}cc, ${hex}cc), ` +
    'repeating-conic-gradient(#cbd5e1 0 25%, #fff 0 50%) 0 0 / 10px 10px';
}

/* ================================================================ Lab */

// sRGB → linear, als Tabelle (schnell für viele Pixel)
const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const v = i / 255;
  LIN[i] = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
const labF = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

/** sRGB (0..255, auch Kommazahlen) → CIE-Lab (D65). */
export function srgbToLab(r, g, b) {
  const lin = v => {
    if (Number.isInteger(v) && v >= 0 && v <= 255) return LIN[v];
    v = Math.max(0, Math.min(255, v)) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  const Y = R * 0.2126729 + G * 0.7151522 + B * 0.0721750;
  const Z = (R * 0.0193339 + G * 0.1191920 + B * 0.9503041) / 1.08883;
  const fx = labF(X), fy = labF(Y), fz = labF(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Lab → sRGB (0..255), für die Anzeige gemessener Farben. */
export function labToRgb([L, a, b]) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const inv = t => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const X = inv(fx) * 0.95047, Y = inv(fy), Z = inv(fz) * 1.08883;
  const lin = [
    X * 3.2404542 + Y * -1.5371385 + Z * -0.4985314,
    X * -0.9692660 + Y * 1.8760108 + Z * 0.0415560,
    X * 0.0556434 + Y * -0.2040259 + Z * 1.0572252,
  ];
  return lin.map(v => {
    v = Math.max(0, Math.min(1, v));
    return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
  });
}

/** CIEDE2000-Farbabstand (Sharma et al. 2005). */
export function deltaE2000([L1, a1, b1], [L2, a2, b2]) {
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const hue = (b, a) => { if (a === 0 && b === 0) return 0; const t = Math.atan2(b, a) / rad; return t < 0 ? t + 360 : t; };
  const h1p = hue(b1, a1p), h2p = hue(b2, a2p);
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lpm = (L1 + L2) / 2, Cpm = (C1p + C2p) / 2;
  let hpm = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hpm += h1p + h2p < 360 ? 360 : -360;
    hpm /= 2;
  }
  const T = 1 - 0.17 * Math.cos((hpm - 30) * rad) + 0.24 * Math.cos(2 * hpm * rad) +
    0.32 * Math.cos((3 * hpm + 6) * rad) - 0.2 * Math.cos((4 * hpm - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hpm - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cpm ** 7 / (Cpm ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lpm - 50) ** 2) / Math.sqrt(20 + (Lpm - 50) ** 2);
  const Sc = 1 + 0.045 * Cpm, Sh = 1 + 0.015 * Cpm * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

/* ============================================================ Palette */

/**
 * Farben, unter denen gemessen wird. Sehr seltene Farben (z. B. Modulex) würden
 * sonst oft zufällig „gewinnen“. Farben aus der Suchliste sind immer dabei.
 * @param {Array} colors  Rebrickable-Farben
 * @param {Set<number>} mustHave  Farb-IDs, die immer enthalten sein sollen
 */
export function buildPalette(colors, mustHave = new Set()) {
  const hasCounts = colors.some(c => c.numParts > 0);
  return colors
    .filter(c => !HIDDEN_COLOR_IDS.has(c.id))
    .filter(c => !hasCounts || c.numParts >= 300 || mustHave.has(c.id))
    .map(c => ({ id: c.id, name: c.name, rgb: c.rgb, trans: c.trans, lab: srgbToLab(...hexToRgb(c.rgb)) }));
}

/**
 * Die n nächstgelegenen Palettenfarben (CIEDE2000).
 * Transparente Farben bekommen einen kleinen Abschlag: Ihr Rebrickable-RGB ist
 * oft fast gleich der deckenden Farbe (Trans-Clear ≈ White), auf dem Foto sehen
 * sie aber eher wie der Hintergrund aus.
 */
export function nearestColors(lab, palette, n = 3) {
  return palette
    .map(p => { const dE = deltaE2000(lab, p.lab); return { id: p.id, dE, rank: dE + (p.trans ? 4 : 0) }; })
    .sort((a, b) => a.rank - b.rank)
    .slice(0, n)
    .map(({ id, dE }) => ({ id, dE }));
}

/* ========================================================== Messung */

/**
 * Weißabgleich-Faktoren aus einer Hintergrundfarbe (soll neutral grau/weiß sein).
 * Nur der Farbstich wird korrigiert, nicht die Helligkeit.
 */
export function whiteBalanceGains([r, g, b]) {
  const m = (r + g + b) / 3;
  const clamp = v => Math.max(0.6, Math.min(1.6, v));
  return [clamp(m / Math.max(1, r)), clamp(m / Math.max(1, g)), clamp(m / Math.max(1, b))];
}

/** Ist eine Farbe (RGB) annähernd neutral (grau/weiß)? Dann taugt sie für den Weißabgleich. */
export function isNeutral(rgb) {
  const [, a, b] = srgbToLab(...rgb);
  return Math.hypot(a, b) < 14;
}

/**
 * Misst die Farbe eines Teils aus seinen Pixeln (RGB-Tripel, flach).
 * Glanzlichter und Schatten/Kanten: hellste und dunkelste 15 % werden verworfen,
 * dann Median je Lab-Kanal.
 * @returns {number[]|null} Lab
 */
export function measureLab(rgbFlat, gains = [1, 1, 1]) {
  const n = Math.floor(rgbFlat.length / 3);
  if (n < 4) return null;
  const Ls = new Float32Array(n), As = new Float32Array(n), Bs = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const [L, a, b] = srgbToLab(
      Math.min(255, rgbFlat[k * 3] * gains[0]),
      Math.min(255, rgbFlat[k * 3 + 1] * gains[1]),
      Math.min(255, rgbFlat[k * 3 + 2] * gains[2]));
    Ls[k] = L; As[k] = a; Bs[k] = b;
  }
  const order = Array.from({ length: n }, (_, k) => k).sort((p, q) => Ls[p] - Ls[q]);
  const lo = Math.floor(n * 0.15), hi = Math.max(lo + 1, Math.ceil(n * 0.85));
  const keep = order.slice(lo, hi);
  const med = arr => {
    const v = keep.map(k => arr[k]).sort((x, y) => x - y);
    return v[v.length >> 1];
  };
  return [med(Ls), med(As), med(Bs)];
}
