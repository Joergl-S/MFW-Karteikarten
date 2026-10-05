/**
 * match.js – Abgleich zwischen erkannten Teilen und der Suchliste.
 *
 * Teil: Brickognize liefert BrickLink-Nummern. Ein Kandidat passt zu einem
 * Suchteil, wenn die Nummer gleich ist, zur selben Variantenfamilie gehört
 * (Rebrickable part_relationships: Print, Pattern, Mold, Alternate) oder bis
 * auf einen Buchstaben-Suffix gleich ist (BrickLink „3040“ ↔ Rebrickable „3040b“).
 *
 * Farbe: „exakt“ (nächste Palettenfarbe = Wunschfarbe), „alternativ“ (innerhalb
 * der Toleranz oder fast gleichauf mit der besten Farbe) oder „nein“.
 *
 * Status: sicher (grün) / unsicher (gelb) / kein Treffer.
 */

import { deltaE2000 } from './color.js';

export const baseNum = n => String(n).toLowerCase().replace(/[a-z]$/, '');

/** Passt die Kandidatennummer (BrickLink) zum Suchteil (Rebrickable)? */
export function partMatches(candId, wishNum, index) {
  const c = String(candId).toLowerCase(), w = String(wishNum).toLowerCase();
  if (c === w) return true;
  const fam = index ? index.family(wishNum).map(s => s.toLowerCase()) : [w];
  if (fam.includes(c)) return true;
  const bc = baseNum(c);
  if (bc === baseNum(w) || fam.some(f => baseNum(f) === bc)) return true;
  if (index) {
    const e = index.get(candId);
    if (e && index.family(e.num).some(f => f.toLowerCase() === w)) return true;
  }
  return false;
}

/**
 * Wie gut passt die gemessene Farbe zur Wunschfarbe?
 * @returns 'any' | 'exact' | 'alt' | 'no'
 */
export function colorFit(region, wish, colorLab, tolerance) {
  if (wish.colorId == null) return 'any';
  const c = region.color;
  if (!c) return 'no';
  if (c.best && c.best.id === wish.colorId) return 'exact';
  const wl = colorLab.get(wish.colorId);
  if (!wl) return 'no';
  const d = deltaE2000(c.lab, wl);
  // „alternativ“: nah genug an der Wunschfarbe ODER fast gleichauf mit der besten
  // Farbe (typische Verwechslungen wie Schwarz/Dunkelgrau, Hellgrau/Hellblaugrau)
  if (d <= tolerance) return 'alt';
  if (c.alts && c.alts.some(a => a.id === wish.colorId) && d - c.best.dE <= 6) return 'alt';
  return 'no';
}

/** Kommt die Region für Stufe B (Brickognize) in Frage? */
export function passesPrefilter(region, wishlist, colorLab, settings) {
  if (settings.checkAll) return true;
  return wishlist.some(w => colorFit(region, w, colorLab, settings.colorTol) !== 'no');
}

const RANK = { sure: 2, unsure: 1, none: 0 };

/**
 * Bewertet eine Region gegen die ganze Suchliste.
 * @returns {{status, wishId, score, rank, colorFit, candId}}
 */
export function evaluateRegion(region, wishlist, index, colorLab, settings) {
  if (region.override) {
    return { status: region.override.status, wishId: region.override.wishId, score: 1, rank: 0, colorFit: 'manual', candId: null };
  }
  const none = { status: 'none', wishId: null, score: 0, rank: -1, colorFit: null, candId: null };
  if (!region.cands || !region.cands.length) return none;
  let best = none;
  for (const w of wishlist) {
    const cf = colorFit(region, w, colorLab, settings.colorTol);
    if (cf === 'no') continue;
    const rank = region.cands.findIndex(c => partMatches(c.id, w.partNum, index));
    if (rank < 0) continue;
    const cand = region.cands[rank];
    let status = 'none';
    if (rank === 0 && cand.score >= settings.scoreSure && (cf === 'exact' || cf === 'any')) status = 'sure';
    else if (cand.score >= settings.scoreUnsure) status = 'unsure';
    if (status === 'none') continue;
    const r = { status, wishId: w.id, score: cand.score, rank, colorFit: cf, candId: cand.id };
    if (RANK[r.status] > RANK[best.status] || (RANK[r.status] === RANK[best.status] && r.score > best.score)) best = r;
  }
  return best;
}

/**
 * Zähler je Suchteil und Gesamtzusammenfassung.
 * Ohne Mengenangabe zählt ein Suchteil als „1 gesucht“ (mindestens eins finden).
 */
export function summarize(regions, wishlist) {
  const per = new Map(wishlist.map(w => [w.id, { sure: 0, unsure: 0 }]));
  for (const r of regions) {
    const res = r.result;
    if (!res || res.status === 'none' || !per.has(res.wishId)) continue;
    per.get(res.wishId)[res.status]++;
  }
  let wanted = 0, found = 0;
  for (const w of wishlist) {
    const p = per.get(w.id);
    const n = p.sure + p.unsure;
    const want = w.qty || 1;
    wanted += want;
    found += Math.min(n, want);
  }
  const hits = regions.filter(r => r.result && r.result.status !== 'none').length;
  return { per, wanted, found, hits };
}
