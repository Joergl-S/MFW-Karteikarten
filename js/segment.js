/**
 * segment.js – Steuert den Segmentierungs-Worker (Haupt-Thread).
 *
 * - Ganzes Bild: eine Arbeitskopie (lange Kante 1600 px)
 * - Kachel-Modus (2×2 / 3×3): jede Kachel (mit Überlappung) einzeln in 1600 px →
 *   effektiv höhere Auflösung und lokaler Schwellwert. Ein Teil gehört der
 *   Kachel, in deren Kernbereich sein Mittelpunkt liegt → keine Doppelten.
 * - Alle Regionen werden in ORIGINAL-Koordinaten zurückgegeben; die Maske
 *   bleibt in Arbeitsauflösung (mScale = Originalpixel je Maskenpixel).
 */

import { workImage, borderMedianRgb, makeCanvas, releaseCanvas, WORK_MAX } from './image.js';
import { srgbToLab } from './color.js';

let worker = null;
let readyPromise = null;
let jobId = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker('js/segment-worker.js');
  worker.onmessage = ev => {
    const m = ev.data;
    if (m.type === 'ready') return;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.type === 'error') p.reject(new Error(m.message));
    else p.resolve(m);
  };
  worker.onerror = ev => {
    const err = new Error('Analyse-Modul abgestürzt' + (ev.message ? ': ' + ev.message : '') +
      '. Evtl. zu wenig Speicher – andere Apps/Tabs schließen oder Kachel-Modus nutzen.');
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    killWorker();
  };
  return worker;
}

function killWorker() {
  if (worker) worker.terminate();
  worker = null;
  readyPromise = null;
}

/** Lädt OpenCV.js im Hintergrund vor (ca. 10 MB, einmalig, danach im Cache). */
export function warmup() {
  if (readyPromise) return readyPromise;
  const w = getWorker();
  readyPromise = new Promise((resolve, reject) => {
    const id = ++jobId;
    pending.set(id, { resolve, reject });
    const onReady = ev => {
      if (ev.data.type === 'ready') {
        w.removeEventListener('message', onReady);
        pending.delete(id);
        resolve();
      } else if (ev.data.type === 'error') {
        w.removeEventListener('message', onReady);
        pending.delete(id);
        readyPromise = null;
        reject(new Error('OpenCV.js konnte nicht geladen werden: ' + ev.data.message));
      }
    };
    w.addEventListener('message', onReady);
    w.postMessage({ type: 'init', id });
  });
  return readyPromise;
}

function runJob(imageData, params, signal) {
  const w = getWorker();
  return new Promise((resolve, reject) => {
    const id = ++jobId;
    pending.set(id, { resolve, reject });
    const onAbort = () => {
      pending.delete(id);
      killWorker();                 // einzige Möglichkeit, eine laufende Berechnung zu stoppen
      reject(new DOMException('Abgebrochen', 'AbortError'));
    };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const buf = imageData.data.buffer;
    w.postMessage({ type: 'segment', id, width: imageData.width, height: imageData.height, data: buf, params }, [buf]);
  });
}

/** Parameter je Modus. */
export function modeParams(mode) {
  if (mode === 'small') {
    // 50–100 Teile: Teile größer im Bild, seltener berührend → strenger filtern, vorsichtiger trennen
    return { splitK: 0.55, minRel: 0.1, open: 5, close: 5, largeFactor: 1.8, colorSplitDE: 22, minAreaPx: 80 };
  }
  return { splitK: 0.5, minRel: 0.06, open: 3, close: 5, largeFactor: 2.2, colorSplitDE: 25, minAreaPx: 40 };
}

/**
 * Segmentiert das Foto.
 * @param photo         aus image.loadPhoto
 * @param opts.tiles    1, 2 oder 3
 * @param opts.mode     'normal' | 'small'
 * @param opts.bgRgb    angetippte Hintergrundfarbe oder null
 * @returns {{regions, stats, debug:{canvas, maskCanvas}, bgRgb, bgLab}}
 */
export async function segmentPhoto(photo, { tiles = 1, mode = 'normal', bgRgb = null, onProgress = () => {}, signal } = {}) {
  onProgress('Lade Bildanalyse (OpenCV) …');
  await warmup();
  const params = modeParams(mode);

  // Hintergrund global bestimmen (für Kacheln wichtig, da deren Ränder voller Teile sein können)
  let bg = bgRgb;
  if (!bg) {
    const small = workImage(photo, undefined, 800);
    bg = borderMedianRgb(small.imageData);
  }
  const bgLab = srgbToLab(...bg.map(Math.round));
  if (bgRgb || tiles > 1) params.bgLab = bgLab;

  const n = Math.max(1, Math.min(3, tiles | 0));
  const W = photo.width, H = photo.height;
  const tw = W / n, th = H / n;
  const ov = n > 1 ? Math.round(0.18 * Math.min(tw, th)) : 0;

  // Debug-Bilder in Anzeigegröße zusammensetzen
  const dScale = Math.min(1, 2048 / Math.max(W, H));
  const debugCanvas = makeCanvas(W * dScale, H * dScale);
  const maskCanvas = makeCanvas(W * dScale, H * dScale);
  const dctx = debugCanvas.getContext('2d');
  const mctx = maskCanvas.getContext('2d');

  const regions = [];
  const tileStats = [];
  for (let ty = 0; ty < n; ty++) {
    for (let tx = 0; tx < n; tx++) {
      if (signal && signal.aborted) throw new DOMException('Abgebrochen', 'AbortError');
      const core = { x0: Math.round(tx * tw), y0: Math.round(ty * th), x1: Math.round((tx + 1) * tw), y1: Math.round((ty + 1) * th) };
      const rect = {
        x: Math.max(0, core.x0 - ov), y: Math.max(0, core.y0 - ov),
        w: Math.min(W, core.x1 + ov) - Math.max(0, core.x0 - ov),
        h: Math.min(H, core.y1 + ov) - Math.max(0, core.y0 - ov),
      };
      onProgress(n > 1 ? `Segmentiere Kachel ${ty * n + tx + 1} von ${n * n} …` : 'Segmentiere Teile …');
      const work = workImage(photo, rect, WORK_MAX);
      const ww = work.imageData.width, wh = work.imageData.height;
      const res = await runJob(work.imageData, params, signal);
      const s = work.scale;
      const st = res.stats;
      st.tile = n > 1 ? `${tx + 1}/${ty + 1}` : 'ganz';
      tileStats.push(st);

      for (const r of res.regions) {
        const cx = work.ox + r.cx * s, cy = work.oy + r.cy * s;
        if (n > 1 && (cx < core.x0 || cx >= core.x1 || cy < core.y0 || cy >= core.y1)) continue;   // gehört anderer Kachel
        const touchesTileEdge =
          (r.x <= 1 && rect.x > 0) || (r.y <= 1 && rect.y > 0) ||
          (r.x + r.w >= ww - 1 && rect.x + rect.w < W) || (r.y + r.h >= wh - 1 && rect.y + rect.h < H);
        regions.push({
          x: work.ox + r.x * s, y: work.oy + r.y * s, w: r.w * s, h: r.h * s,
          area: r.area * s * s,
          cx, cy,
          mask: r.mask, mw: r.w, mh: r.h, mScale: s,
          border: (r.border && !touchesTileEdge) || false,
          cut: touchesTileEdge,
          split: r.split,
          labWork: r.lab,
        });
      }

      // Debug-Bilder dieser Kachel (nur Kernbereich) einzeichnen
      const ovl = new ImageData(new Uint8ClampedArray(res.debug.overlay), ww, wh);
      const tmp = makeCanvas(ww, wh);
      tmp.getContext('2d').putImageData(ovl, 0, 0);
      const cxs = (core.x0 - rect.x) / s, cys = (core.y0 - rect.y) / s;
      const cws = (core.x1 - core.x0) / s, chs = (core.y1 - core.y0) / s;
      dctx.drawImage(tmp, cxs, cys, cws, chs, core.x0 * dScale, core.y0 * dScale, (core.x1 - core.x0) * dScale, (core.y1 - core.y0) * dScale);
      const mk = new Uint8Array(res.debug.mask);
      const mimg = new ImageData(ww, wh);
      for (let i = 0; i < mk.length; i++) {
        const v = mk[i];
        mimg.data[i * 4] = v; mimg.data[i * 4 + 1] = v; mimg.data[i * 4 + 2] = v; mimg.data[i * 4 + 3] = 255;
      }
      tmp.getContext('2d').putImageData(mimg, 0, 0);
      mctx.drawImage(tmp, cxs, cys, cws, chs, core.x0 * dScale, core.y0 * dScale, (core.x1 - core.x0) * dScale, (core.y1 - core.y0) * dScale);
      releaseCanvas(tmp);
    }
  }

  // Größen-Flags global neu bestimmen
  const areas = regions.map(r => r.area).sort((a, b) => a - b);
  const median = areas.length ? areas[areas.length >> 1] : 0;
  for (const r of regions) r.large = r.area > params.largeFactor * median;
  regions.forEach((r, i) => { r.id = i + 1; });

  const warnings = new Set(tileStats.flatMap(s => s.warnings));
  const nLarge = regions.filter(r => r.large).length;
  if (nLarge > Math.max(3, regions.length * 0.15)) warnings.add('manyLarge');
  if (!regions.length) warnings.add('noParts');

  return {
    regions,
    stats: { tiles: tileStats, median, large: nLarge, regions: regions.length, warnings: [...warnings], mode, tileCount: n * n },
    debug: { canvas: debugCanvas, maskCanvas, scale: dScale },
    bgRgb: bg,
    bgLab,
  };
}
