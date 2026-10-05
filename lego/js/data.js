/**
 * data.js – Rebrickable-Daten laden, parsen und in IndexedDB ablegen.
 *
 * Quellen (in dieser Reihenfolge):
 *   1. data/*.csv.gz im eigenen Repo (per GitHub Action aktuell gehalten,
 *      gleiche Herkunft → kein CORS-Problem)
 *   2. direkt von cdn.rebrickable.com (klappt nur, falls Rebrickable CORS erlaubt)
 *   3. manueller Import in den Einstellungen (Dateien aus der „Dateien“-App)
 *
 * Gespeichertes Format (kompakt, damit IndexedDB/Speicher klein bleiben):
 *   parts:         [[part_num, name, cat_id], ...]
 *   colors:        [{id, name, rgb, trans, numParts}, ...]
 *   categories:    {cat_id: name}
 *   relationships: [[rel_type, child_part_num, parent_part_num], ...]
 */

import { dbGet, dbSetMany } from './db.js';

export const TABLES = ['parts', 'colors', 'part_categories', 'part_relationships'];
const REQUIRED = ['parts', 'colors'];
const LOCAL_BASE = 'data/';
const REMOTE_BASE = 'https://cdn.rebrickable.com/media/downloads/';
const META_KEY = 'meta';

/* ------------------------------------------------------------------ CSV */

/**
 * RFC-4180-CSV-Parser (Anführungszeichen, Kommas und Zeilenumbrüche in Feldern).
 * Liefert {header, rows} mit rows als Array von String-Arrays.
 */
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM entfernen
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  const n = text.length;
  let inQuotes = false;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\n' || c === '\r') {
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      if (c === '\r' && text[i + 1] === '\n') i++;
      i++; continue;
    }
    // Schneller Pfad: unproblematische Zeichen am Stück übernehmen
    let j = i + 1;
    while (j < n) {
      const d = text[j];
      if (d === ',' || d === '"' || d === '\n' || d === '\r') break;
      j++;
    }
    field += text.slice(i, j);
    i = j;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const header = (rows.shift() || []).map(h => h.trim().toLowerCase());
  return { header, rows };
}

/* --------------------------------------------------------------- Gzip */

function isGzip(bytes) {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** Wandelt Bytes in Text um; entpackt automatisch, falls gzip. */
async function bytesToText(buffer) {
  const bytes = new Uint8Array(buffer);
  if (!isGzip(bytes)) return new TextDecoder('utf-8').decode(bytes);
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Dieser Browser kann .gz-Dateien nicht entpacken (iPadOS 16.4 oder neuer nötig). ' +
      'Bitte die Dateien entpackt (.csv) importieren.');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).text();
}

/* ------------------------------------------------------- Umwandlung */

function col(header, name, table) {
  const idx = header.indexOf(name);
  if (idx < 0) throw new Error(`Spalte „${name}“ fehlt in ${table}.csv – ist das die richtige Datei?`);
  return idx;
}

/** Wandelt eine geparste Tabelle ins kompakte Speicherformat um. */
function convert(table, { header, rows }) {
  switch (table) {
    case 'parts': {
      const a = col(header, 'part_num', table), b = col(header, 'name', table), c = col(header, 'part_cat_id', table);
      return rows.map(r => [r[a], r[b], Number(r[c]) || 0]);
    }
    case 'colors': {
      const id = col(header, 'id', table), name = col(header, 'name', table),
        rgb = col(header, 'rgb', table), tr = col(header, 'is_trans', table);
      const np = header.indexOf('num_parts');
      return rows.map(r => ({
        id: Number(r[id]),
        name: r[name],
        rgb: (r[rgb] || '000000').toUpperCase(),
        trans: /^(t|true|1)$/i.test(r[tr] || ''),
        numParts: np >= 0 ? Number(r[np]) || 0 : 0,
      }));
    }
    case 'part_categories': {
      const id = col(header, 'id', table), name = col(header, 'name', table);
      const out = {};
      for (const r of rows) out[r[id]] = r[name];
      return out;
    }
    case 'part_relationships': {
      const t = col(header, 'rel_type', table), c = col(header, 'child_part_num', table),
        p = col(header, 'parent_part_num', table);
      return rows.map(r => [r[t], r[c], r[p]]);
    }
    default:
      throw new Error('Unbekannte Tabelle ' + table);
  }
}

/* ------------------------------------------------------------- Laden */

async function fetchBytes(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.arrayBuffer();
}

/**
 * Versucht, eine Tabelle aus den Online-Quellen zu laden.
 * @returns {{data, source}}
 */
async function downloadTable(table) {
  const errors = [];
  for (const [label, base] of [['Repo', LOCAL_BASE], ['Rebrickable', REMOTE_BASE]]) {
    try {
      const text = await bytesToText(await fetchBytes(base + table + '.csv.gz'));
      return { data: convert(table, parseCsv(text)), source: label };
    } catch (e) {
      errors.push(`${label}: ${e.message}`);
    }
  }
  const err = new Error(`${table}.csv konnte nicht geladen werden (${errors.join('; ')}).`);
  err.table = table;
  throw err;
}

/** Liest die Version der Repo-Daten (data/version.json, vom Update-Skript geschrieben). */
export async function fetchRepoVersion() {
  try {
    const res = await fetch(LOCAL_BASE + 'version.json', { cache: 'no-cache' });
    if (!res.ok) return null;
    const j = await res.json();
    return j && j.updated ? String(j.updated) : null;
  } catch {
    return null;
  }
}

/**
 * Lädt alle Tabellen neu aus dem Netz und speichert sie.
 * @param {(msg:string)=>void} onProgress
 */
export async function downloadAll(onProgress = () => {}) {
  const result = {};
  const sources = {};
  for (const table of TABLES) {
    onProgress(`Lade ${table} …`);
    try {
      const { data, source } = await downloadTable(table);
      result[table] = data;
      sources[table] = source;
    } catch (e) {
      if (REQUIRED.includes(table)) throw e;
      console.warn(e);           // optionale Tabelle fehlt → App läuft trotzdem
      result[table] = table === 'part_categories' ? {} : [];
      sources[table] = 'fehlt';
    }
  }
  const meta = {
    loadedAt: new Date().toISOString(),
    repoVersion: await fetchRepoVersion(),
    sources,
    counts: Object.fromEntries(TABLES.map(t => [t, Array.isArray(result[t]) ? result[t].length : Object.keys(result[t]).length])),
  };
  onProgress('Speichere …');
  await dbSetMany({ ...result, [META_KEY]: meta });
  return { ...result, meta };
}

/**
 * Importiert vom Nutzer gewählte Dateien (.csv oder .csv.gz).
 * Nicht gewählte Tabellen bleiben, wie sie sind.
 */
export async function importFiles(fileList, onProgress = () => {}) {
  const found = {};
  for (const file of fileList) {
    // „parts.csv.gz“, „parts (1).csv“, „part_relationships.csv“ …
    const base = file.name.toLowerCase().replace(/\s*\(\d+\)/g, '').replace(/\.gz$/, '').replace(/\.csv$/, '');
    const table = TABLES.find(t => base === t);
    if (!table) throw new Error(`Unbekannte Datei „${file.name}“. Erwartet: ${TABLES.map(t => t + '.csv').join(', ')}.`);
    onProgress(`Lese ${file.name} …`);
    const text = await bytesToText(await file.arrayBuffer());
    found[table] = convert(table, parseCsv(text));
  }
  if (!Object.keys(found).length) throw new Error('Keine Dateien gewählt.');
  const old = (await dbGet(META_KEY)) || { sources: {}, counts: {} };
  for (const t of Object.keys(found)) {
    old.sources[t] = 'Import';
    old.counts[t] = Array.isArray(found[t]) ? found[t].length : Object.keys(found[t]).length;
  }
  old.loadedAt = new Date().toISOString();
  onProgress('Speichere …');
  await dbSetMany({ ...found, [META_KEY]: old });
  return loadStored();
}

/** Liest die gespeicherten Daten. Gibt null zurück, wenn Pflichttabellen fehlen. */
export async function loadStored() {
  const [meta, parts, colors, cats, rels] = await Promise.all([
    dbGet(META_KEY), dbGet('parts'), dbGet('colors'), dbGet('part_categories'), dbGet('part_relationships'),
  ]);
  if (!parts || !parts.length || !colors || !colors.length) return null;
  return { meta: meta || {}, parts, colors, part_categories: cats || {}, part_relationships: rels || [] };
}
