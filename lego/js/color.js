/**
 * color.js – Farbhilfen.
 *
 * Etappe 1: Farbliste für die Auswahl aufbereiten.
 * Etappe 3: Farbmessung im Lab-Raum und Zuordnung per CIEDE2000 (folgt).
 */

/** Rebrickable-Pseudofarben, die in der Auswahl nichts verloren haben. */
const HIDDEN_COLOR_IDS = new Set([-1, 9999]);   // [Unknown], [No Color/Any Color]

export function hexToRgb(hex) {
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Relative Helligkeit 0..1 – für lesbare Schrift auf Farbfeldern. */
export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(v => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
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
