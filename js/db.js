/**
 * db.js – Minimaler IndexedDB-Wrapper.
 *
 * Ein einziger Object Store „kv“ (Schlüssel → Wert). Jede Rebrickable-Tabelle
 * wird als EIN Datensatz (kompaktes Array) gespeichert. Das ist in Safari
 * deutlich schneller als zehntausende Einzeldatensätze per Cursor zu lesen.
 * Später kommen hier auch Caches dazu (z. B. Brickognize-Ergebnisse nach Hash).
 */

const DB_NAME = 'lego-teilefinder';
const DB_VERSION = 1;
const STORE = 'kv';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in self)) {
      reject(new Error('Dieser Browser unterstützt keine lokale Datenbank (IndexedDB).'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      // Falls eine andere Instanz (neuer Tab) die Version erhöht: sauber schließen.
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Datenbank ist blockiert – bitte andere Tabs der App schließen.'));
  });
  return dbPromise;
}

function tx(mode, fn) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    Promise.resolve(fn(store)).then(r => { result = r; });
    t.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaktion abgebrochen'));
  }));
}

export function dbGet(key) {
  return tx('readonly', store => store.get(key));
}

export function dbSet(key, value) {
  return tx('readwrite', store => { store.put(value, key); });
}

/** Schreibt mehrere Schlüssel in EINER Transaktion (alles oder nichts). */
export function dbSetMany(entries) {
  return tx('readwrite', store => {
    for (const [k, v] of Object.entries(entries)) store.put(v, k);
  });
}

export function dbDelete(key) {
  return tx('readwrite', store => { store.delete(key); });
}

/** Bittet den Browser, die Daten nicht automatisch zu löschen (Safari: v. a. für Home-Bildschirm-Apps). */
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      return await navigator.storage.persist();
    }
  } catch { /* nicht unterstützt */ }
  return false;
}
