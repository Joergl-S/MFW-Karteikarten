/**
 * segment-worker.js – Segmentierung im Web Worker (OpenCV.js), damit die UI flüssig bleibt.
 *
 * Ablauf für ein Arbeitsbild (lange Kante ca. 1600 px):
 *   1. Lab-Farbraum, leichter Weichzeichner gegen Rauschen
 *   2. Hintergrund schätzen: Median der Bildränder (oder angetippte Farbe),
 *      dann ein grobes Raster (12 × n Zellen), damit Helligkeitsverläufe /
 *      Vignettierung nicht als „Teil“ zählen
 *   3. Farbabstand jedes Pixels zum lokalen Hintergrund. Pixel, die nur DUNKLER
 *      sind (Schatten), zählen schwächer.
 *   4. Schwellwert (Otsu, begrenzt) mit Hysterese, Morphologie, Löcher füllen,
 *      Krümel entfernen
 *   5. Berührende Teile trennen: Distance-Transform → Kerne → Watershed.
 *      Teilstücke, die gleichfarbig sind UND breit aneinanderstoßen, werden
 *      wieder vereint (verhindert Zerstückeln von L-Formen usw.)
 *   6. Regionen mit Box, Fläche, Maske; Debug-Bild
 *
 * Nachrichten:
 *   → {type:'segment', id, width, height, data:ArrayBuffer(RGBA), params}
 *   ← {type:'result', id, regions, stats, debug:{overlay:ArrayBuffer, mask:ArrayBuffer}}
 *   ← {type:'error', id, message}
 *   → {type:'init'}  ← {type:'ready'}
 */

/* global importScripts */
let cv = null;
let cvError = null;
try {
  importScripts('../vendor/opencv.js');
} catch (e) {
  cvError = e;
}

/** OpenCV.js (Emscripten) ist „thenable“ – then() entfernen, sonst Endlosschleife bei await. */
const cvReady = new Promise((resolve, reject) => {
  const m = self.cv;
  if (!m) { reject(cvError || new Error('OpenCV.js konnte nicht geladen werden.')); return; }
  if (m.Mat && m.getBuildInformation) { cv = m; resolve(); return; }
  if (typeof m.then === 'function') {
    m.then(mod => { delete mod.then; cv = mod; resolve(); });
  } else {
    m.onRuntimeInitialized = () => { cv = m; resolve(); };
  }
});

self.onmessage = async ev => {
  const msg = ev.data;
  try {
    await cvReady;
    if (msg.type === 'init') { self.postMessage({ type: 'ready' }); return; }
    if (msg.type === 'segment') {
      const out = segment(new Uint8Array(msg.data), msg.width, msg.height, msg.params || {});
      const transfer = [out.debug.overlay, out.debug.mask, ...out.regions.map(r => r.mask.buffer)];
      self.postMessage({ type: 'result', id: msg.id, ...out }, transfer);
    }
  } catch (e) {
    self.postMessage({ type: 'error', id: msg.id, message: (e && e.message) || String(e) });
  }
};

/* ================================================================ Hilfen */

const L8 = v => v * 100 / 255;     // OpenCV-8-bit-Lab → echte Einheiten
const AB8 = v => v - 128;

function medianFromHist(hist, n) {
  let acc = 0;
  const half = n / 2;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= half) return i; }
  return 255;
}

/** Median-Lab (8-bit) eines Randstreifens. */
function borderMedian(lab, w, h) {
  const band = Math.max(3, Math.round(Math.min(w, h) * 0.02));
  const H = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let n = 0;
  for (let y = 0; y < h; y++) {
    const rowBand = y < band || y >= h - band;
    for (let x = 0; x < w; x++) {
      if (!rowBand && x === band) x = w - band;     // Bildmitte überspringen
      const i = (y * w + x) * 3;
      H[0][lab[i]]++; H[1][lab[i + 1]]++; H[2][lab[i + 2]]++;
      n++;
    }
  }
  return [medianFromHist(H[0], n), medianFromHist(H[1], n), medianFromHist(H[2], n)];
}

/**
 * Grobes Hintergrundmodell: pro Rasterzelle der Median aller Pixel, die
 * dem globalen Hintergrund ähnlich sind. Zellen ohne genug Hintergrund werden
 * aus Nachbarn aufgefüllt. Werte in echten Lab-Einheiten.
 */
function backgroundGrid(lab, w, h, seed) {
  const gx = 12;
  const gy = Math.max(3, Math.round(gx * h / w));
  const cw = w / gx, ch = h / gy;
  const G = gx * gy;
  const L = new Float32Array(G), A = new Float32Array(G), B = new Float32Array(G);
  const valid = new Uint8Array(G);
  const [sL, sA, sB] = seed;
  const H = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (let cy = 0; cy < gy; cy++) {
    for (let cx = 0; cx < gx; cx++) {
      H[0].fill(0); H[1].fill(0); H[2].fill(0);
      let n = 0, total = 0;
      const x0 = Math.floor(cx * cw), x1 = Math.floor((cx + 1) * cw);
      const y0 = Math.floor(cy * ch), y1 = Math.floor((cy + 1) * ch);
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const i = (y * w + x) * 3;
          total++;
          const dl = L8(lab[i]) - sL, da = AB8(lab[i + 1]) - sA, db = AB8(lab[i + 2]) - sB;
          if (dl * dl + da * da + db * db < 18 * 18) {
            H[0][lab[i]]++; H[1][lab[i + 1]]++; H[2][lab[i + 2]]++; n++;
          }
        }
      }
      const g = cy * gx + cx;
      if (n >= Math.max(10, total * 0.12)) {
        L[g] = L8(medianFromHist(H[0], n));
        A[g] = AB8(medianFromHist(H[1], n));
        B[g] = AB8(medianFromHist(H[2], n));
        valid[g] = 1;
      }
    }
  }
  // Lücken aus Nachbarn füllen
  let anyValid = valid.some(v => v);
  if (!anyValid) { L.fill(sL); A.fill(sA); B.fill(sB); valid.fill(1); }
  for (let pass = 0; pass < gx + gy && valid.some(v => !v); pass++) {
    const nv = valid.slice();
    for (let cy = 0; cy < gy; cy++) for (let cx = 0; cx < gx; cx++) {
      const g = cy * gx + cx;
      if (valid[g]) continue;
      let sl = 0, sa = 0, sb = 0, k = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= gx || y >= gy) continue;
        const q = y * gx + x;
        if (valid[q]) { sl += L[q]; sa += A[q]; sb += B[q]; k++; }
      }
      if (k) { L[g] = sl / k; A[g] = sa / k; B[g] = sb / k; nv[g] = 1; }
    }
    valid.set(nv);
  }
  return { gx, gy, cw, ch, L, A, B };
}

/** Union-Find für Label-Zusammenführung */
function makeUF(n) {
  const p = new Int32Array(n);
  for (let i = 0; i < n; i++) p[i] = i;
  const find = x => { while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; } return x; };
  return { find, union: (a, b) => { a = find(a); b = find(b); if (a !== b) p[Math.max(a, b)] = Math.min(a, b); } };
}

function matFrom(arr, h, w, type) {
  const m = new cv.Mat(h, w, type);
  m.data.set(arr);
  return m;
}


/**
 * Prüft, ob eine Komponente aus (mindestens) zwei deutlich verschiedenen Farben
 * besteht (k-Means mit k = 2 im Lab-Raum). Liefert zusammenhängende, sichere
 * Farbstücke (Pixel-Indizes) oder null.
 */
function colorSplit(pix, lab, dt, w, h, area, minDE, minArea) {
  // Innenpixel (Abstand ≥ 2 px zum Rand) stichprobenartig
  const step = Math.max(1, Math.floor(pix.length / 3000));
  const sL = [], sA = [], sB = [];
  for (let k = 0; k < pix.length; k += step) {
    const i = pix[k];
    if (dt[i] < 2) continue;
    sL.push(L8(lab[i * 3])); sA.push(AB8(lab[i * 3 + 1])); sB.push(AB8(lab[i * 3 + 2]));
  }
  const n = sL.length;
  if (n < 30) return null;
  // Start: Punkt am weitesten vom Mittel, dann am weitesten davon
  let mL = 0, mA = 0, mB = 0;
  for (let k = 0; k < n; k++) { mL += sL[k]; mA += sA[k]; mB += sB[k]; }
  mL /= n; mA /= n; mB /= n;
  const far = (cL, cA, cB) => {
    let best = 0, bd = -1;
    for (let k = 0; k < n; k++) {
      const d = (sL[k] - cL) ** 2 + (sA[k] - cA) ** 2 + (sB[k] - cB) ** 2;
      if (d > bd) { bd = d; best = k; }
    }
    return best;
  };
  const k1 = far(mL, mA, mB), k2 = far(sL[k1], sA[k1], sB[k1]);
  const C = [[sL[k1], sA[k1], sB[k1]], [sL[k2], sA[k2], sB[k2]]];
  for (let it = 0; it < 10; it++) {
    const acc = [[0, 0, 0, 0], [0, 0, 0, 0]];
    for (let k = 0; k < n; k++) {
      const d0 = (sL[k] - C[0][0]) ** 2 + (sA[k] - C[0][1]) ** 2 + (sB[k] - C[0][2]) ** 2;
      const d1 = (sL[k] - C[1][0]) ** 2 + (sA[k] - C[1][1]) ** 2 + (sB[k] - C[1][2]) ** 2;
      const a = acc[d0 <= d1 ? 0 : 1];
      a[0] += sL[k]; a[1] += sA[k]; a[2] += sB[k]; a[3]++;
    }
    for (let c = 0; c < 2; c++) if (acc[c][3]) C[c] = [acc[c][0] / acc[c][3], acc[c][1] / acc[c][3], acc[c][2] / acc[c][3]];
    if (!acc[0][3] || !acc[1][3]) return null;
  }
  const cd = Math.sqrt((C[0][0] - C[1][0]) ** 2 + (C[0][1] - C[1][1]) ** 2 + (C[0][2] - C[1][2]) ** 2);
  if (cd < minDE) return null;

  // Sichere Zuordnung: deutlich näher an einem Zentrum, nicht am Rand
  const own = new Map();   // Pixelindex → Cluster (0/1)
  for (let k = 0; k < pix.length; k++) {
    const i = pix[k];
    if (dt[i] < 2) continue;
    const L = L8(lab[i * 3]), A = AB8(lab[i * 3 + 1]), B = AB8(lab[i * 3 + 2]);
    const d0 = Math.sqrt((L - C[0][0]) ** 2 + (A - C[0][1]) ** 2 + (B - C[0][2]) ** 2);
    const d1 = Math.sqrt((L - C[1][0]) ** 2 + (A - C[1][1]) ** 2 + (B - C[1][2]) ** 2);
    if (Math.abs(d0 - d1) > cd * 0.35) own.set(i, d0 < d1 ? 0 : 1);
  }
  // Zusammenhängende Stücke je Cluster (4er-Nachbarschaft)
  const seen = new Set();
  const pieces = [];
  const minPiece = Math.max(minArea * 0.5, area * 0.12);
  const clustersHit = new Set();
  for (const [start, cl] of own) {
    if (seen.has(start)) continue;
    const stack = [start];
    seen.add(start);
    const px = [];
    while (stack.length) {
      const i = stack.pop();
      px.push(i);
      const x = i % w;
      const nbs = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w];
      for (const j of nbs) {
        if (j < 0 || seen.has(j) || own.get(j) !== cl) continue;
        seen.add(j);
        stack.push(j);
      }
    }
    if (px.length >= minPiece) { pieces.push(Int32Array.from(px)); clustersHit.add(cl); }
  }
  return pieces.length >= 2 && clustersHit.size === 2 ? pieces : null;
}

/* ============================================================ Segmentierung */

function segment(rgba, w, h, P) {
  const T = {};
  let t = performance.now();
  const tick = name => { const n = performance.now(); T[name] = Math.round(n - t); t = n; };
  const N = w * h;
  const prm = {
    shadow: 0.6,          // Gewicht für „dunkler als Hintergrund“
    shadowL: 15,          // bis zu diesem ΔL gilt „nur dunkler, gleiche Farbe“ als Schatten
    colorSplitDE: 25,     // Mindest-Farbabstand für die Farbtrennung
    minT: 5, maxT: 25,    // erlaubter Schwellwertbereich (ΔE)
    margin: 4,            // Abstand über dem Hintergrundrauschen (ΔE)
    open: 3, close: 5,    // Morphologie-Kerngrößen
    minAreaPx: 40,        // absolute Mindestfläche (Arbeitsbild-Pixel)
    minRel: 0.06,         // Mindestfläche relativ zum Median
    splitK: 0.5,          // Kern = Distanz ≥ splitK · Maximum der Komponente
    mergeNeck: 0.8,       // Wiedervereinigen, wenn Kontaktbreite ≥ … · Teilbreite …
    mergeDE: 12,          // … und Farbunterschied < … ΔE
    largeFactor: 2.2,     // Fläche > … · Median → „evtl. mehrere Teile“
    bgLab: null,          // vorgegebener Hintergrund [L,a,b] (echte Einheiten)
    ...P,
  };
  const warnings = [];

  // --- 1. Lab -------------------------------------------------------------
  const src = matFrom(rgba, h, w, cv.CV_8UC4);
  const rgb = new cv.Mat();
  cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
  src.delete();
  const blur = new cv.Mat();
  cv.GaussianBlur(rgb, blur, new cv.Size(5, 5), 0);
  const labM = new cv.Mat();
  cv.cvtColor(blur, labM, cv.COLOR_RGB2Lab);
  blur.delete();
  const lab = labM.data.slice();
  labM.delete();

  let sumL = 0;
  for (let i = 0; i < N; i++) sumL += lab[i * 3];
  const meanL = L8(sumL / N);
  if (meanL < 18) warnings.push('dark');
  tick('lab');

  // --- 2. Hintergrund --------------------------------------------------------
  let seed;
  if (prm.bgLab) seed = prm.bgLab;
  else {
    const m = borderMedian(lab, w, h);
    seed = [L8(m[0]), AB8(m[1]), AB8(m[2])];
  }
  const grid = backgroundGrid(lab, w, h, seed);
  tick('background');

  // --- 3. Abstand zum Hintergrund ------------------------------------------
  const dist = new Uint8Array(N);            // ΔE · 4, gekappt bei 255
  const ixA = new Int32Array(w), txA = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let fx = (x + 0.5) / grid.cw - 0.5;
    fx = Math.max(0, Math.min(grid.gx - 1.0001, fx));
    ixA[x] = Math.floor(fx); txA[x] = fx - ixA[x];
  }
  for (let y = 0; y < h; y++) {
    let fy = (y + 0.5) / grid.ch - 0.5;
    fy = Math.max(0, Math.min(grid.gy - 1.0001, fy));
    const iy = Math.floor(fy), ty = fy - iy;
    const iy2 = Math.min(grid.gy - 1, iy + 1);
    for (let x = 0; x < w; x++) {
      const ix = ixA[x], tx = txA[x], ix2 = Math.min(grid.gx - 1, ix + 1);
      const g00 = iy * grid.gx + ix, g01 = iy * grid.gx + ix2, g10 = iy2 * grid.gx + ix, g11 = iy2 * grid.gx + ix2;
      const w00 = (1 - tx) * (1 - ty), w01 = tx * (1 - ty), w10 = (1 - tx) * ty, w11 = tx * ty;
      const bL = grid.L[g00] * w00 + grid.L[g01] * w01 + grid.L[g10] * w10 + grid.L[g11] * w11;
      const bA = grid.A[g00] * w00 + grid.A[g01] * w01 + grid.A[g10] * w10 + grid.A[g11] * w11;
      const bB = grid.B[g00] * w00 + grid.B[g01] * w01 + grid.B[g10] * w10 + grid.B[g11] * w11;
      const i = y * w + x, j = i * 3;
      let dl = L8(lab[j]) - bL;
      const da = AB8(lab[j + 1]) - bA, db = AB8(lab[j + 2]) - bB;
      let d;
      if (dl < 0 && -dl < prm.shadowL && da * da + db * db < 36) {
        d = Math.sqrt(da * da + db * db) * 4;     // typischer Schatten: nur dunkler, kaum Farbänderung
      } else {
        if (dl < 0) dl *= prm.shadow;           // dunkle Teile zählen etwas schwächer
        d = Math.sqrt(dl * dl + da * da + db * db) * 4;
      }
      dist[i] = d > 255 ? 255 : d;
    }
  }
  tick('distance');

  // --- 4. Schwellwert mit Hysterese -----------------------------------------
  const distM = matFrom(dist, h, w, cv.CV_8UC1);
  const tmp = new cv.Mat();
  const otsu = cv.threshold(distM, tmp, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
  tmp.delete(); distM.delete();
  // Otsu trennt meist nur Hintergrund vs. KRÄFTIGE Farben und liegt für graue/weiße
  // Teile zu hoch. Deshalb Schwelle aus dem Rauschen des Hintergrunds ableiten:
  // 75.-Perzentil der Pixel unterhalb der Otsu-Schwelle, mal 2, plus Sicherheitsabstand.
  let noise;
  {
    const hist = new Uint32Array(256);
    let n = 0;
    for (let i = 0; i < N; i++) if (dist[i] < otsu) { hist[dist[i]]++; n++; }
    let acc = 0;
    noise = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.75) { noise = v; break; } }
  }
  const thr = Math.max(prm.minT * 4, Math.min(prm.maxT * 4, otsu, noise * 2 + prm.margin * 4));
  const weakThr = thr * 0.75;
  const weak = new Uint8Array(N);
  for (let i = 0; i < N; i++) weak[i] = dist[i] > weakThr ? 255 : 0;
  let mask;
  {
    const weakM = matFrom(weak, h, w, cv.CV_8UC1);
    const lbl = new cv.Mat();
    const n = cv.connectedComponents(weakM, lbl, 8, cv.CV_32S);
    weakM.delete();
    const L = lbl.data32S;
    const strong = new Uint8Array(n);
    for (let i = 0; i < N; i++) if (dist[i] > thr) strong[L[i]] = 1;
    strong[0] = 0;
    mask = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (strong[L[i]]) mask[i] = 255;
    lbl.delete();
  }

  // Morphologie
  let maskM = matFrom(mask, h, w, cv.CV_8UC1);
  {
    const k1 = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(prm.open, prm.open));
    const k2 = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(prm.close, prm.close));
    const t1 = new cv.Mat();
    cv.morphologyEx(maskM, t1, cv.MORPH_OPEN, k1);
    cv.morphologyEx(t1, maskM, cv.MORPH_CLOSE, k2);
    t1.delete(); k1.delete(); k2.delete();
  }
  mask = maskM.data.slice();
  tick('threshold');

  // Komponenten + Median-Fläche
  const ccStats = m => {
    const lbl = new cv.Mat(), st = new cv.Mat(), ce = new cv.Mat();
    const n = cv.connectedComponentsWithStats(m, lbl, st, ce, 8, cv.CV_32S);
    const S = st.data32S.slice();
    const L = lbl.data32S.slice();
    lbl.delete(); st.delete(); ce.delete();
    return { n, S, L };   // S: [left, top, width, height, area] je Label
  };
  let cc = ccStats(maskM);
  const areas = [];
  for (let k = 1; k < cc.n; k++) if (cc.S[k * 5 + 4] >= prm.minAreaPx) areas.push(cc.S[k * 5 + 4]);
  areas.sort((a, b) => a - b);
  let median = areas.length ? areas[areas.length >> 1] : 0;

  // Löcher füllen (z. B. Technic-Löcher), aber keine großen Hintergrundflächen
  {
    const inv = new Uint8Array(N);
    for (let i = 0; i < N; i++) inv[i] = mask[i] ? 0 : 255;
    const invM = matFrom(inv, h, w, cv.CV_8UC1);
    const hc = ccStats(invM);
    invM.delete();
    const fill = new Uint8Array(hc.n);
    for (let k = 1; k < hc.n; k++) {
      const [x, y, bw, bh, a] = hc.S.subarray(k * 5, k * 5 + 5);
      const atBorder = x === 0 || y === 0 || x + bw >= w || y + bh >= h;
      if (!atBorder && a < Math.max(prm.minAreaPx, median * 0.6)) fill[k] = 1;
    }
    for (let i = 0; i < N; i++) if (fill[hc.L[i]]) mask[i] = 255;
  }

  // Krümel entfernen
  const minArea = Math.max(prm.minAreaPx, median * prm.minRel);
  maskM.data.set(mask);
  cc = ccStats(maskM);
  let removedSmall = 0;
  {
    const drop = new Uint8Array(cc.n);
    for (let k = 1; k < cc.n; k++) if (cc.S[k * 5 + 4] < minArea) { drop[k] = 1; removedSmall++; }
    for (let i = 0; i < N; i++) if (drop[cc.L[i]]) { mask[i] = 0; cc.L[i] = 0; }
    maskM.data.set(mask);
  }
  let fg = 0;
  for (let i = 0; i < N; i++) if (mask[i]) fg++;
  const fgFraction = fg / N;
  if (fgFraction > 0.6) warnings.push('bgFail');
  tick('cleanup');

  // --- 5. Trennen: Distance-Transform + Farbe + Watershed ---------------------
  const dtM = new cv.Mat();
  cv.distanceTransform(maskM, dtM, cv.DIST_L2, 5);
  const dt = dtM.data32F.slice();
  dtM.delete();
  maskM.delete();
  const comp = cc.L;              // Komponenten-Label je Pixel (0 = Hintergrund)
  const nComp = cc.n;
  const compArea = new Int32Array(nComp);
  const compMax = new Float32Array(nComp);
  for (let i = 0; i < N; i++) {
    const c = comp[i];
    if (!c) continue;
    compArea[c]++;
    if (dt[i] > compMax[c]) compMax[c] = dt[i];
  }
  // Pixel-Listen je Komponente (Counting Sort)
  const compStart = new Int32Array(nComp + 1);
  for (let c = 1; c < nComp; c++) compStart[c + 1] = compStart[c] + compArea[c];
  const compPix = new Int32Array(compStart[nComp]);
  {
    const fillPos = compStart.slice();
    for (let i = 0; i < N; i++) if (comp[i]) compPix[fillPos[comp[i]]++] = i;
  }

  // 5a. Kerne aus der Distanztransformation (trennt Teile an Engstellen)
  const core = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const c = comp[i];
    if (c && dt[i] >= prm.splitK * compMax[c] && dt[i] >= 1.5) core[i] = 255;
  }
  const coreM = matFrom(core, h, w, cv.CV_8UC1);
  const mk = ccStats(coreM);
  coreM.delete();
  const biggestCore = new Float32Array(nComp);
  const coreComp = new Int32Array(mk.n);
  for (let i = 0; i < N; i++) {
    const m = mk.L[i];
    if (m && !coreComp[m]) coreComp[m] = comp[i];
  }
  for (let m = 1; m < mk.n; m++) {
    const a = mk.S[m * 5 + 4], c = coreComp[m];
    if (a > biggestCore[c]) biggestCore[c] = a;
  }
  const markerOk = new Uint8Array(mk.n);
  for (let m = 1; m < mk.n; m++) {
    // Winzige Kerne (Rauschen auf dem Distanz-Plateau) verwerfen
    if (mk.S[m * 5 + 4] >= Math.max(3, biggestCore[coreComp[m]] * 0.08)) markerOk[m] = 1;
  }

  // 5b. Farbtrennung: berührende Teile unterschiedlicher Farbe (häufigster Fall,
  //     den die Form allein nicht trennt, z. B. zwei Steine Seite an Seite)
  const colorLbl = new Int32Array(N);       // 0 = keine Farbtrennung
  let nColorLbl = 0;
  const colorSplitComp = new Uint8Array(nComp);
  for (let c = 1; c < nComp; c++) {
    if (compArea[c] < Math.max(minArea * 2, median * 0.5)) continue;
    const pieces = colorSplit(compPix.subarray(compStart[c], compStart[c + 1]), lab, dt, w, h, compArea[c], prm.colorSplitDE, minArea);
    if (!pieces) continue;
    colorSplitComp[c] = 1;
    for (const px of pieces) {
      nColorLbl++;
      for (let k = 0; k < px.length; k++) colorLbl[px[k]] = nColorLbl;
    }
  }

  // Markerbild: 1 = Hintergrund, ≥2 = Teil-Kerne, 0 = unbekannt
  // Farbstücke: Enthält ein Farbstück ≥ 2 Form-Kerne, werden diese genutzt, sonst das Farbstück selbst.
  const colorBase = mk.n + 2;
  const coresInColor = new Map();          // Farblabel → Set(Kern-Label)
  for (let i = 0; i < N; i++) {
    const cl = colorLbl[i], m = mk.L[i];
    if (cl && m && markerOk[m]) {
      let s = coresInColor.get(cl);
      if (!s) { s = new Set(); coresInColor.set(cl, s); }
      s.add(m);
    }
  }
  const coresPerComp = new Int32Array(nComp);
  for (let m = 1; m < mk.n; m++) if (markerOk[m]) coresPerComp[coreComp[m]]++;
  const wholeBase = colorBase + nColorLbl + 1;
  const markersM = new cv.Mat(h, w, cv.CV_32S);
  const M = markersM.data32S;
  for (let i = 0; i < N; i++) {
    const c = comp[i];
    if (!mask[i]) { M[i] = 1; continue; }
    if (colorSplitComp[c]) {
      const cl = colorLbl[i], m = mk.L[i];
      const cores = cl ? coresInColor.get(cl) : null;
      if (cl && cores && cores.size >= 2) M[i] = m && markerOk[m] && cores.has(m) ? m + 1 : 0;
      else M[i] = cl ? colorBase + cl : 0;
    } else if (mk.L[i] && markerOk[mk.L[i]]) M[i] = mk.L[i] + 1;
    else if (coresPerComp[c] === 0) M[i] = wholeBase + c;      // Komponente ohne Kern: als Ganzes
    else M[i] = 0;
  }
  cv.watershed(rgb, markersM);
  const lab32 = markersM.data32S.slice();
  markersM.delete();
  rgb.delete();
  const nLabels = wholeBase + nComp + 1;

  // Watershed lässt den Hintergrund-Marker teils in die Teilemaske laufen.
  // Die Maske ist aber verbindlich: solche Pixel per Breitensuche dem
  // nächstgelegenen Teil-Label zuordnen.
  {
    const queue = new Int32Array(N);
    let qh = 0, qt = 0;
    for (let i = 0; i < N; i++) {
      if (!mask[i]) { lab32[i] = 0; continue; }
      if (lab32[i] >= 2) queue[qt++] = i; else lab32[i] = 0;
    }
    while (qh < qt) {
      const i = queue[qh++], l = lab32[i];
      const x = i % w;
      const nbs = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w];
      for (const j of nbs) {
        if (j < 0 || j >= N || !mask[j] || lab32[j]) continue;
        lab32[j] = l;
        queue[qt++] = j;
      }
    }
  }
  tick('watershed');

  // Teilstücke ggf. wieder vereinen (gleichfarbig UND breiter Kontakt)
  const stat = { area: new Float64Array(nLabels), L: new Float64Array(nLabels), A: new Float64Array(nLabels),
    B: new Float64Array(nLabels), dt: new Float32Array(nLabels) };
  for (let i = 0; i < N; i++) {
    const l = lab32[i];
    if (!l) continue;
    stat.area[l]++;
    stat.L[l] += lab[i * 3]; stat.A[l] += lab[i * 3 + 1]; stat.B[l] += lab[i * 3 + 2];
    if (dt[i] > stat.dt[l]) stat.dt[l] = dt[i];
  }
  const contact = new Map();
  const addContact = (a, b) => {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const key = lo * 1048576 + hi;
    contact.set(key, (contact.get(key) || 0) + 1);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, l = lab32[i];
      if (!l) continue;
      if (x < w - 1 && lab32[i + 1] && lab32[i + 1] !== l) addContact(l, lab32[i + 1]);
      if (y < h - 1 && lab32[i + w] && lab32[i + w] !== l) addContact(l, lab32[i + w]);
    }
  }
  const uf = makeUF(nLabels);
  let merges = 0;
  for (const [key, cnt] of contact) {
    const a = Math.floor(key / 1048576), b = key % 1048576;
    if (!stat.area[a] || !stat.area[b]) continue;
    const width = 2 * Math.min(stat.dt[a], stat.dt[b]);
    const neck = cnt / Math.max(1, width);
    const dL = L8(stat.L[a] / stat.area[a]) - L8(stat.L[b] / stat.area[b]);
    const dA = (stat.A[a] / stat.area[a]) - (stat.A[b] / stat.area[b]);
    const dB = (stat.B[a] / stat.area[a]) - (stat.B[b] / stat.area[b]);
    const dE = Math.sqrt(dL * dL + dA * dA + dB * dB);
    if (neck >= prm.mergeNeck && dE < prm.mergeDE) { uf.union(a, b); merges++; }
  }
  const final = new Int32Array(N);
  for (let i = 0; i < N; i++) final[i] = lab32[i] ? uf.find(lab32[i]) : 0;
  tick('merge');

  // --- 6. Regionen -----------------------------------------------------------
  const R = new Map();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, l = final[i];
      if (!l) continue;
      let r = R.get(l);
      if (!r) { r = { x0: x, y0: y, x1: x, y1: y, area: 0, sx: 0, sy: 0, L: 0, A: 0, B: 0, comp: comp[i] }; R.set(l, r); }
      if (x < r.x0) r.x0 = x; if (x > r.x1) r.x1 = x;
      if (y < r.y0) r.y0 = y; if (y > r.y1) r.y1 = y;
      r.area++; r.sx += x; r.sy += y;
      r.L += lab[i * 3]; r.A += lab[i * 3 + 1]; r.B += lab[i * 3 + 2];
    }
  }
  const compPieces = new Int32Array(nComp);
  for (const r of R.values()) compPieces[r.comp]++;
  const finalAreas = [...R.values()].map(r => r.area).filter(a => a >= minArea).sort((a, b) => a - b);
  median = finalAreas.length ? finalAreas[finalAreas.length >> 1] : median;
  const regions = [];
  const keepIds = new Map();
  for (const [l, r] of R) {
    if (r.area < minArea) continue;
    const bw = r.x1 - r.x0 + 1, bh = r.y1 - r.y0 + 1;
    const m = new Uint8Array(bw * bh);
    for (let y = r.y0; y <= r.y1; y++) {
      for (let x = r.x0; x <= r.x1; x++) if (final[y * w + x] === l) m[(y - r.y0) * bw + x - r.x0] = 1;
    }
    keepIds.set(l, regions.length);
    regions.push({
      x: r.x0, y: r.y0, w: bw, h: bh,
      area: r.area,
      cx: r.sx / r.area, cy: r.sy / r.area,
      lab: [L8(r.L / r.area), AB8(r.A / r.area), AB8(r.B / r.area)],
      border: r.x0 <= 1 || r.y0 <= 1 || r.x1 >= w - 2 || r.y1 >= h - 2,
      large: r.area > prm.largeFactor * median,
      split: compPieces[r.comp] > 1,
      mask: m,
    });
  }
  const nLarge = regions.filter(r => r.large).length;
  if (!regions.length) warnings.push('noParts');
  else if (nLarge > Math.max(3, regions.length * 0.15)) warnings.push('manyLarge');
  if (regions.length > 800) warnings.push('tooMany');
  tick('regions');

  // --- Debug-Bilder ------------------------------------------------------------
  const overlay = new Uint8ClampedArray(N * 4);
  const maskOut = new Uint8Array(N);
  const hue = l => {
    const k = (keepIds.get(l) || 0) * 137.508;
    const hh = (k % 360) / 60, c = 200, xx = c * (1 - Math.abs((hh % 2) - 1));
    const t6 = Math.floor(hh);
    return [[c, xx, 0], [xx, c, 0], [0, c, xx], [0, xx, c], [xx, 0, c], [c, 0, xx]][t6 % 6];
  };
  const colorCache = new Map();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, o = i * 4, l = final[i];
      const kept = l && keepIds.has(l);
      maskOut[i] = kept ? 255 : 0;
      const r0 = rgba[o], g0 = rgba[o + 1], b0 = rgba[o + 2];
      if (!kept) {
        // Hintergrund abgedunkelt; entfernte Krümel/Trennlinien in Rot
        const sep = mask[i] ? 1 : 0;
        overlay[o] = sep ? 255 : r0 * 0.35; overlay[o + 1] = sep ? 40 : g0 * 0.35; overlay[o + 2] = sep ? 40 : b0 * 0.35;
      } else {
        const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
          final[i - 1] !== l || final[i + 1] !== l || final[i - w] !== l || final[i + w] !== l;
        if (edge) {
          const big = regions[keepIds.get(l)].large;
          overlay[o] = 255; overlay[o + 1] = big ? 140 : 255; overlay[o + 2] = big ? 0 : 255;
        } else {
          let c = colorCache.get(l);
          if (!c) { c = hue(l); colorCache.set(l, c); }
          overlay[o] = r0 * 0.55 + c[0] * 0.45; overlay[o + 1] = g0 * 0.55 + c[1] * 0.45; overlay[o + 2] = b0 * 0.55 + c[2] * 0.45;
        }
      }
      overlay[o + 3] = 255;
    }
  }
  tick('debug');

  return {
    regions,
    stats: {
      width: w, height: h,
      bgLab: seed,
      thresholdDE: thr / 4,
      noiseDE: noise / 4,
      otsuDE: otsu / 4,
      medianArea: median,
      minArea,
      components: nComp - 1,
      splitComponents: Array.from(compPieces).filter(n => n > 1).length,
      merges,
      removedSmall,
      regions: regions.length,
      large: nLarge,
      meanL,
      fgFraction,
      timings: T,
      warnings,
    },
    debug: { overlay: overlay.buffer, mask: maskOut.buffer },
  };
}
