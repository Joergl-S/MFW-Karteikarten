/**
 * settings.js – Einstellungen und Suchliste in localStorage.
 *
 * Es werden keine Geheimnisse gespeichert. Alles bleibt lokal auf dem Gerät.
 */

const SETTINGS_KEY = 'lego-tf.settings.v1';
const WISHLIST_KEY = 'lego-tf.wishlist.v1';

/** Standardwerte. Neue Einstellungen hier ergänzen. */
export const DEFAULTS = Object.freeze({
  mode: 'normal',          // 'normal' (100–300 Teile) | 'small' (50–100 Teile)
  tiles: 1,                // Kachel-Modus: 1 = aus, 2 = 2x2, 3 = 3x3
  checkAll: false,         // alle Ausschnitte an Brickognize schicken
  debug: true,             // Debug-Ansicht (Maske, Konturen, Messwerte)
  apiUrl: 'https://api.brickognize.com', // oder eigene Cloudflare-Worker-URL
  parallel: 3,             // gleichzeitige API-Anfragen
  scoreSure: 0.8,          // ab hier gilt ein Treffer als „sicher“
  scoreUnsure: 0.5,        // ab hier „unsicher“, darunter „kein Treffer“
  hidePrints: true,        // bedruckte Varianten in der Textsuche ausblenden
});

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn('localStorage nicht beschreibbar', e);
  }
}

/** Liefert die aktuellen Einstellungen (Standardwerte + gespeicherte Werte). */
export function loadSettings() {
  return { ...DEFAULTS, ...readJson(SETTINGS_KEY, {}) };
}

export function saveSettings(settings) {
  writeJson(SETTINGS_KEY, settings);
}

export function resetSettings() {
  try { localStorage.removeItem(SETTINGS_KEY); } catch { /* egal */ }
  return { ...DEFAULTS };
}

/**
 * Suchliste: Array von Einträgen
 * { id, partNum, partName, colorId (Zahl oder null = Farbe egal), qty (Zahl oder null) }
 */
export function loadWishlist() {
  const list = readJson(WISHLIST_KEY, []);
  return Array.isArray(list) ? list : [];
}

export function saveWishlist(list) {
  writeJson(WISHLIST_KEY, list);
}
