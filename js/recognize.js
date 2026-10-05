/**
 * recognize.js – Brickognize-API (Teileerkennung per Bild).
 *
 * Endpoint: POST {apiUrl}/predict/parts/   (multipart/form-data, Feld „query_image“)
 * Antwort (Auszug): { listing_id, bounding_box:{…}, items:[{ id, name, img_url, category, type, score, external_sites }] }
 * Die IDs von Brickognize sind BrickLink-Teilenummern (meist identisch mit Rebrickable).
 * Doku: https://api.brickognize.com/docs
 *
 * - begrenzte Parallelität, Retry mit Backoff, 429/Retry-After
 * - Cache nach SHA-256 des gesendeten JPEGs (IndexedDB), spart Anfragen bei Wiederholung
 * - Abbrechen über AbortSignal
 */

import { dbGet, dbSet } from './db.js';

export class ApiError extends Error {
  constructor(message, { retry = false, status = 0, kind = 'api', retryAfter = 0 } = {}) {
    super(message);
    this.retry = retry;
    this.status = status;
    this.kind = kind;
    this.retryAfter = retryAfter;
  }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Abgebrochen', 'AbortError')); }, { once: true });
});

/** Wandelt die API-Antwort tolerant in ein einheitliches Format um. */
export function parseResponse(j) {
  const list = Array.isArray(j) ? j : (j.items || j.results || j.candidates || []);
  const items = list.map(it => ({
    id: String(it.id ?? it.part_id ?? it.item_no ?? ''),
    name: String(it.name ?? ''),
    score: Number(it.score ?? it.confidence ?? 0),
    img: it.img_url || it.image_url || it.img || '',
    category: it.category || '',
    type: it.type || 'part',
  })).filter(i => i.id);
  return { items, bbox: j.bounding_box || null };
}

/** Eine einzelne Anfrage. */
export async function predict(blob, apiUrl, signal) {
  const url = apiUrl.replace(/\/+$/, '') + '/predict/parts/';
  const fd = new FormData();
  fd.append('query_image', blob, 'teil.jpg');
  let res;
  try {
    res = await fetch(url, { method: 'POST', body: fd, signal, headers: { Accept: 'application/json' } });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError('Brickognize ist nicht erreichbar (keine Verbindung oder vom Browser blockiert/CORS). ' +
      'Internet prüfen; falls es dauerhaft scheitert, in den Einstellungen eine Proxy-URL eintragen.',
    { retry: true, kind: 'network' });
  }
  if (res.status === 429) {
    throw new ApiError('Brickognize meldet zu viele Anfragen – kurze Pause …',
      { retry: true, status: 429, kind: 'rate', retryAfter: Number(res.headers.get('Retry-After')) || 0 });
  }
  if (res.status >= 500) throw new ApiError(`Brickognize-Serverfehler (${res.status}).`, { retry: true, status: res.status });
  if (!res.ok) {
    let t = '';
    try { t = (await res.text()).slice(0, 160); } catch { /* egal */ }
    throw new ApiError(`Brickognize lehnt die Anfrage ab (${res.status}). ${t}`, { status: res.status });
  }
  let j;
  try { j = await res.json(); } catch { throw new ApiError('Unerwartete Antwort von Brickognize (kein JSON).'); }
  return parseResponse(j);
}

async function sha256(blob) {
  if (!self.crypto || !crypto.subtle) return null;     // nur in sicherem Kontext (https)
  const buf = await blob.arrayBuffer();
  const h = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(h), b => b.toString(16).padStart(2, '0')).join('');
}

/** Anfrage mit Cache und Wiederholungen. */
export async function predictCached(blob, apiUrl, signal, { tries = 4 } = {}) {
  const hash = await sha256(blob);
  const key = hash ? 'bg:' + hash : null;
  if (key) {
    try {
      const hit = await dbGet(key);
      if (hit && hit.items) return { ...hit, cached: true };
    } catch { /* Cache optional */ }
  }
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const out = await predict(blob, apiUrl, signal);
      if (key) dbSet(key, { items: out.items, bbox: out.bbox, at: Date.now() }).catch(() => {});
      return out;
    } catch (e) {
      if (e.name === 'AbortError' || !e.retry) throw e;
      lastErr = e;
      // Netzwerkfehler nur einmal wiederholen (meist CORS/offline – bringt nichts)
      if (e.kind === 'network' && attempt >= 1) break;
      const wait = e.retryAfter ? e.retryAfter * 1000 : 800 * 2 ** attempt + Math.random() * 400;
      await sleep(wait, signal);
    }
  }
  throw lastErr;
}

/**
 * Viele Ausschnitte erkennen.
 * @param jobs      [{ makeBlob: () => Promise<Blob>, onResult: (out) => void }]
 * @param opts      { apiUrl, parallel, signal, onProgress(done, total, failed) }
 * @returns {{done, failed, errors}}
 */
export async function recognizeMany(jobs, { apiUrl, parallel = 3, signal, onProgress = () => {} }) {
  let next = 0, done = 0, failed = 0;
  const errors = [];
  let fatal = null;
  let consecutiveNetwork = 0;
  const workerFn = async () => {
    while (next < jobs.length && !fatal) {
      if (signal && signal.aborted) return;
      const job = jobs[next++];
      try {
        const blob = await job.makeBlob();
        const out = await predictCached(blob, apiUrl, signal);
        job.onResult(out);
        consecutiveNetwork = 0;
      } catch (e) {
        if (e.name === 'AbortError') return;
        failed++;
        errors.push(e);
        if (job.onError) job.onError(e);
        if (e.kind === 'network' && ++consecutiveNetwork >= 3) fatal = e;   // offensichtlich keine Verbindung
      }
      done++;
      onProgress(done, jobs.length, failed);
    }
  };
  const n = Math.max(1, Math.min(6, parallel | 0));
  await Promise.all(Array.from({ length: n }, workerFn));
  if (signal && signal.aborted) throw new DOMException('Abgebrochen', 'AbortError');
  if (fatal) throw fatal;
  return { done, failed, errors };
}

/** Verbindungstest mit einem kleinen künstlichen Bild (roter 2×4-Stein). */
export async function testConnection(apiUrl) {
  const c = document.createElement('canvas');
  c.width = 160; c.height = 120;
  const g = c.getContext('2d');
  g.fillStyle = '#e5e7eb'; g.fillRect(0, 0, 160, 120);
  g.fillStyle = '#c91a09'; g.fillRect(20, 35, 120, 60);
  g.fillStyle = '#e0301e';
  for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) { g.beginPath(); g.arc(35 + i * 30, 50 + j * 30, 9, 0, 7); g.fill(); }
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
  const t0 = performance.now();
  const out = await predict(blob, apiUrl);
  return { ms: Math.round(performance.now() - t0), items: out.items.length, first: out.items[0] || null };
}
