/**
 * ui.js – Einstiegspunkt: Tabs, Teilesuche, Farbauswahl, Suchliste, Einstellungen.
 */

import { loadSettings, saveSettings, resetSettings, loadWishlist, saveWishlist, DEFAULTS } from './settings.js';
import { loadStored, downloadAll, importFiles, fetchRepoVersion } from './data.js';
import { requestPersistence } from './db.js';
import { PartIndex, partImageUrl, PLACEHOLDER_IMG } from './search.js';
import { pickerColors, swatchStyle } from './color.js';

export const APP_VERSION = 'E1 · 2026-10-05';

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

/** Laufzeitzustand der App */
const state = {
  settings: loadSettings(),
  wishlist: loadWishlist(),
  data: null,          // Rohdaten aus IndexedDB
  index: null,         // PartIndex
  colors: [],          // sortierte Farben für die Auswahl
  colorById: new Map(),
  dialogPart: null,    // aktuell im Dialog geöffnetes Teil
  dialogColor: null,   // gewählte Farb-ID oder null (= Farbe egal)
};

/* ================================================================ Banner */

function showBanner(html, kind = 'info', { sticky = false } = {}) {
  const b = $('#banner');
  b.className = 'banner ' + kind;
  b.innerHTML = html;
  b.hidden = false;
  clearTimeout(showBanner._t);
  if (!sticky) showBanner._t = setTimeout(() => { b.hidden = true; }, 5000);
}

function hideBanner() { $('#banner').hidden = true; }

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ================================================================== Tabs */

function initTabs() {
  for (const btn of $$('.tab')) {
    btn.addEventListener('click', () => {
      $$('.tab').forEach(b => b.classList.toggle('active', b === btn));
      $$('.panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + btn.dataset.tab));
    });
  }
}

/* ================================================================= Daten */

function applyData(data) {
  state.data = data;
  state.index = new PartIndex(data.parts, data.part_categories, data.part_relationships);
  state.colors = pickerColors(data.colors);
  state.colorById = new Map(data.colors.map(c => [c.id, c]));
  renderDataStatus();
  renderWishlist();
  $('#search-input').disabled = false;
  $('#search-status').textContent = `${data.parts.length.toLocaleString('de-DE')} Teile, ${state.colors.length} Farben bereit.`;
  runSearch();
}

async function initData() {
  $('#search-input').disabled = true;
  $('#search-status').textContent = 'Lade Teiledaten …';
  let data = null;
  try {
    data = await loadStored();
  } catch (e) {
    showBanner('Lokale Datenbank nicht lesbar: ' + esc(e.message), 'error', { sticky: true });
  }
  if (data) {
    applyData(data);
    checkForDataUpdate(data.meta);
    return;
  }
  await reloadData();
}

/** Lädt alles aus dem Netz neu. */
async function reloadData() {
  $('#search-input').disabled = true;
  showBanner('Teiledaten werden geladen … (einmalig, ca. 5 MB)', 'info', { sticky: true });
  try {
    const data = await downloadAll(msg => { $('#search-status').textContent = msg; });
    applyData(data);
    showBanner('Teiledaten geladen und gespeichert.', 'ok');
    requestPersistence();
  } catch (e) {
    console.error(e);
    $('#search-status').textContent = 'Keine Teiledaten vorhanden.';
    showBanner(
      '<strong>Teiledaten konnten nicht geladen werden.</strong><br>' + esc(e.message) +
      '<br>Bitte Internetverbindung prüfen oder in den Einstellungen die CSV-Dateien von ' +
      'rebrickable.com/downloads importieren.', 'error', { sticky: true });
  }
}

/** Neuere Daten im Repo? Dann still im Hintergrund aktualisieren. */
async function checkForDataUpdate(meta) {
  if (!navigator.onLine) return;
  const v = await fetchRepoVersion();
  if (v && meta && meta.repoVersion !== v && !Object.values(meta.sources || {}).includes('Import')) {
    try {
      const data = await downloadAll(() => {});
      applyData(data);
      showBanner('Teiledaten aktualisiert (Stand ' + esc(v.slice(0, 10)) + ').', 'ok');
    } catch (e) {
      console.warn('Hintergrund-Update fehlgeschlagen', e);
    }
  }
}

function renderDataStatus() {
  const m = (state.data && state.data.meta) || {};
  const c = m.counts || {};
  const src = m.sources || {};
  const when = m.loadedAt ? new Date(m.loadedAt).toLocaleString('de-DE') : '–';
  const repo = m.repoVersion ? ` · Datenstand ${esc(m.repoVersion.slice(0, 10))}` : '';
  $('#data-status').innerHTML = state.data
    ? `Teile: ${c.parts ?? '?'} (${esc(src.parts || '?')}) · Farben: ${c.colors ?? '?'} · ` +
      `Kategorien: ${c.part_categories ?? '?'} · Beziehungen: ${c.part_relationships ?? '?'}<br>` +
      `Geladen: ${when}${repo}`
    : 'Keine Daten geladen.';
}

/* ================================================================ Suche */

let searchTimer = 0;

function runSearch() {
  const ul = $('#search-results');
  const q = $('#search-input').value;
  if (!state.index) { ul.innerHTML = ''; return; }
  if (!q.trim()) { ul.innerHTML = ''; return; }
  const t0 = performance.now();
  const hits = state.index.search(q, { hidePrints: $('#hide-prints').checked });
  const ms = Math.round(performance.now() - t0);
  $('#search-status').textContent = hits.length
    ? `${hits.length}${hits.length >= 60 ? '+' : ''} Treffer (${ms} ms)`
    : 'Keine Treffer. Tipp: Englische Namen verwenden, z. B. „plate 1 x 2“, „slope“, „technic pin“.';
  ul.innerHTML = hits.map(e => `
    <li class="result" data-num="${esc(e.num)}">
      <img loading="lazy" src="${partImageUrl(e.num)}" alt="" width="56" height="56">
      <div class="result-text">
        <div><span class="mono">${esc(e.num)}</span>${e.isPrint ? ' <span class="tag">Druck</span>' : ''}</div>
        <div class="result-name">${esc(e.name)}</div>
        <div class="muted small">${esc(state.index.categoryName(e.cat))}</div>
      </div>
    </li>`).join('');
}

function initSearch() {
  const input = $('#search-input');
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 120);
  });
  $('#hide-prints').checked = state.settings.hidePrints;
  $('#hide-prints').addEventListener('change', e => {
    state.settings.hidePrints = e.target.checked;
    saveSettings(state.settings);
    runSearch();
  });
  $('#search-results').addEventListener('click', e => {
    const li = e.target.closest('.result');
    if (li) openPartDialog(li.dataset.num);
  });
  // Kaputte Vorschaubilder durch Platzhalter ersetzen (Event-Delegation, auch für dynamische Bilder)
  document.addEventListener('error', e => {
    const img = e.target;
    if (img.tagName === 'IMG' && img.src !== PLACEHOLDER_IMG) img.src = PLACEHOLDER_IMG;
  }, true);
}

/* ===================================================== Teil-/Farbdialog */

function openPartDialog(num, preset = null) {
  const part = state.index.get(num);
  if (!part) return;
  state.dialogPart = part;
  state.dialogColor = preset ? preset.colorId : null;
  $('#dp-title').textContent = 'Teil hinzufügen';
  $('#dp-num').textContent = part.num;
  $('#dp-name').textContent = part.name;
  $('#dp-cat').textContent = state.index.categoryName(part.cat);
  const fam = state.index.family(part.num);
  $('#dp-rel').textContent = fam.length > 1 ? `${fam.length - 1} ${fam.length === 2 ? 'Variante wird' : 'Varianten werden'} mitgezählt (Druck/Muster/Form)` : '';
  $('#dp-qty').value = preset && preset.qty ? preset.qty : '';
  $('#dp-color-filter').value = '';
  renderColorGrid();
  updateDialogColor();
  $('#dlg-part').returnValue = '';   // sonst bleibt der Wert vom letzten Schließen stehen
  $('#dlg-part').showModal();
}

function renderColorGrid() {
  const f = $('#dp-color-filter').value.trim().toLowerCase();
  const words = f.split(/\s+/).filter(Boolean);
  const list = state.colors.filter(c => words.every(w => c.name.toLowerCase().includes(w)));
  const any = !words.length || 'farbe egal'.includes(f)
    ? `<button type="button" class="swatch any ${state.dialogColor == null ? 'sel' : ''}" data-color="">
         <span class="chip" style="${swatchStyle(null)}"></span><span>Farbe egal</span></button>`
    : '';
  $('#dp-colors').innerHTML = any + list.map(c => `
    <button type="button" class="swatch ${state.dialogColor === c.id ? 'sel' : ''}" data-color="${c.id}" title="${esc(c.name)}">
      <span class="chip" style="${swatchStyle(c)}"></span><span>${esc(c.name)}</span>
    </button>`).join('');
}

function updateDialogColor() {
  const c = state.dialogColor == null ? null : state.colorById.get(state.dialogColor);
  $('#dp-img').src = partImageUrl(state.dialogPart.num, c ? c.id : null);
  $('#dp-color-selected').innerHTML =
    `<span class="chip" style="${swatchStyle(c)}"></span> <strong>${c ? esc(c.name) : 'Farbe egal'}</strong>` +
    (c ? ` <span class="muted small">#${c.rgb} · ID ${c.id}</span>` : '');
  $$('#dp-colors .swatch').forEach(b => {
    const id = b.dataset.color === '' ? null : Number(b.dataset.color);
    b.classList.toggle('sel', id === state.dialogColor);
  });
}

function initPartDialog() {
  const dlg = $('#dlg-part');
  $('#dp-color-filter').addEventListener('input', renderColorGrid);
  $('#dp-colors').addEventListener('click', e => {
    const b = e.target.closest('.swatch');
    if (!b) return;
    state.dialogColor = b.dataset.color === '' ? null : Number(b.dataset.color);
    updateDialogColor();
  });
  dlg.querySelectorAll('[data-qty]').forEach(b => b.addEventListener('click', () => {
    const inp = $('#dp-qty');
    const v = Math.max(0, (Number(inp.value) || 0) + Number(b.dataset.qty));
    inp.value = v || '';
  }));
  // Enter im Filterfeld soll den Dialog nicht absenden
  $('#dp-color-filter').addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); });
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'add' || !state.dialogPart) return;
    const qty = Math.max(0, Math.round(Number($('#dp-qty').value) || 0)) || null;
    addToWishlist(state.dialogPart, state.dialogColor, qty);
  });
  // Tippen auf den abgedunkelten Hintergrund schließt den Dialog
  for (const d of $$('dialog')) {
    d.addEventListener('click', e => { if (e.target === d) d.close('cancel'); });
  }
}

/* ============================================================ Suchliste */

function addToWishlist(part, colorId, qty) {
  const existing = state.wishlist.find(w => w.partNum === part.num && w.colorId === colorId);
  if (existing) {
    existing.qty = qty == null ? existing.qty : (existing.qty || 0) + qty;
    showBanner(`${esc(part.num)} war schon in der Liste – Menge angepasst.`, 'info');
  } else {
    state.wishlist.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      partNum: part.num,
      partName: part.name,
      colorId,
      qty,
    });
  }
  saveWishlist(state.wishlist);
  renderWishlist();
}

function renderWishlist() {
  const ul = $('#wish-list');
  $('#wish-empty').hidden = state.wishlist.length > 0;
  $('#btn-clear-list').hidden = state.wishlist.length === 0;
  ul.innerHTML = state.wishlist.map(w => {
    const c = w.colorId == null ? null : state.colorById.get(w.colorId);
    const colorName = w.colorId == null ? 'Farbe egal' : (c ? c.name : `Farbe ${w.colorId}`);
    return `
      <li class="wish" data-id="${w.id}">
        <img loading="lazy" src="${partImageUrl(w.partNum, w.colorId)}" alt="" width="56" height="56">
        <div class="result-text">
          <div class="mono">${esc(w.partNum)}</div>
          <div class="result-name">${esc(w.partName)}</div>
          <div class="small"><span class="chip sm" style="${swatchStyle(c)}"></span> ${esc(colorName)}</div>
        </div>
        <div class="qty compact">
          <button type="button" class="btn" data-act="dec" aria-label="weniger">−</button>
          <span class="qty-val">${w.qty ?? '∞'}</span>
          <button type="button" class="btn" data-act="inc" aria-label="mehr">+</button>
        </div>
        <button type="button" class="icon-btn danger" data-act="del" aria-label="Entfernen">🗑</button>
      </li>`;
  }).join('');
}

function initWishlist() {
  $('#wish-list').addEventListener('click', e => {
    const li = e.target.closest('.wish');
    if (!li) return;
    const w = state.wishlist.find(x => x.id === li.dataset.id);
    if (!w) return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'inc') w.qty = (w.qty || 0) + 1;
    else if (act === 'dec') w.qty = w.qty > 1 ? w.qty - 1 : null;   // null = beliebig viele
    else if (act === 'del') state.wishlist = state.wishlist.filter(x => x !== w);
    else return;
    saveWishlist(state.wishlist);
    renderWishlist();
  });
  $('#btn-clear-list').addEventListener('click', () => {
    if (!confirm('Suchliste wirklich leeren?')) return;
    state.wishlist = [];
    saveWishlist(state.wishlist);
    renderWishlist();
  });
}

/* ======================================================== Einstellungen */

function fillSettingsForm(s) {
  $('#set-mode').value = s.mode;
  $('#set-tiles').value = String(s.tiles);
  $('#set-checkall').checked = s.checkAll;
  $('#set-debug').checked = s.debug;
  $('#set-api').value = s.apiUrl;
  $('#set-parallel').value = s.parallel;
  $('#set-sure').value = s.scoreSure;
  $('#set-unsure').value = s.scoreUnsure;
}

function readSettingsForm() {
  const num = (sel, def, min, max) => {
    const v = Number($(sel).value);
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
  };
  return {
    ...state.settings,
    mode: $('#set-mode').value,
    tiles: Number($('#set-tiles').value) || 1,
    checkAll: $('#set-checkall').checked,
    debug: $('#set-debug').checked,
    apiUrl: ($('#set-api').value.trim() || DEFAULTS.apiUrl).replace(/\/+$/, ''),
    parallel: Math.round(num('#set-parallel', DEFAULTS.parallel, 1, 6)),
    scoreSure: num('#set-sure', DEFAULTS.scoreSure, 0, 1),
    scoreUnsure: num('#set-unsure', DEFAULTS.scoreUnsure, 0, 1),
  };
}

function initSettings() {
  const dlg = $('#dlg-settings');
  $('#app-version').textContent = 'Version ' + APP_VERSION;
  $('#btn-settings').addEventListener('click', () => {
    fillSettingsForm(state.settings);
    renderDataStatus();
    dlg.returnValue = '';
    dlg.showModal();
  });
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'save') return;
    state.settings = readSettingsForm();
    saveSettings(state.settings);
    showBanner('Einstellungen gespeichert.', 'ok');
  });
  $('#btn-settings-reset').addEventListener('click', () => {
    fillSettingsForm(resetSettings());
  });
  $('#btn-data-reload').addEventListener('click', async () => {
    dlg.close('cancel');
    await reloadData();
  });
  $('#data-import').addEventListener('change', async e => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    dlg.close('cancel');
    showBanner('Importiere …', 'info', { sticky: true });
    try {
      const data = await importFiles(files, msg => { $('#search-status').textContent = msg; });
      if (data) {
        applyData(data);
        showBanner('Import erfolgreich.', 'ok');
      } else {
        showBanner('Import gespeichert, aber es fehlen noch parts.csv und/oder colors.csv.', 'warn', { sticky: true });
      }
    } catch (err) {
      showBanner('Import fehlgeschlagen: ' + esc(err.message), 'error', { sticky: true });
    }
  });
}

/* ======================================================= Service Worker */

function initServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then(reg => {
    // Neue Version wartet → Hinweis mit „Neu laden“
    const offerUpdate = worker => {
      showBanner('Neue Version verfügbar. <button id="btn-update" class="btn small">Jetzt neu laden</button>', 'info', { sticky: true });
      $('#btn-update').addEventListener('click', () => worker.postMessage('skipWaiting'));
    };
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w && w.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(w);
      });
    });
  }).catch(e => console.warn('Service Worker nicht registriert', e));
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}

/* ================================================================ Start */

function init() {
  initTabs();
  initSearch();
  initPartDialog();
  initWishlist();
  initSettings();
  initServiceWorker();
  renderWishlist();
  initData();
  window.addEventListener('offline', () => showBanner('Offline – Suche funktioniert weiter, Erkennung braucht Internet.', 'warn'));
}

// Kleine Hilfe für Fehlerberichte: globale Fehler sichtbar machen
window.addEventListener('error', e => { if (e.message) showBanner('Fehler: ' + esc(e.message), 'error'); });
window.addEventListener('unhandledrejection', e => {
  showBanner('Fehler: ' + esc((e.reason && e.reason.message) || e.reason), 'error');
});

init();

// für die Konsole / spätere Module
export { state, showBanner, hideBanner };
