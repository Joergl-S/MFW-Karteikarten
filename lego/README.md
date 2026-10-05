# LEGO-Teilefinder

Private PWA (HTML/CSS/JS, ohne Build-Schritt), die auf einem Foto mit vielen
LEGO-Teilen gesuchte Teile inklusive Farbe findet und markiert.
Zielgerät: iPad mit Safari.

**URL (GitHub Pages):** `https://<benutzer>.github.io/MFW-Karteikarten/lego/`

## Stand

| Etappe | Inhalt | Status |
|---|---|---|
| E1 | Grundgerüst, PWA, Teilesuche (Text), Farbe, Suchliste | ✅ |
| E2 | Foto laden, Segmentierung (OpenCV.js), Trennung berührender Teile, Debug | – |
| E3 | Farbbestimmung (Lab, CIEDE2000), Vorfilter | – |
| E4 | Brickognize-Erkennung, Beispielfoto, Abgleich | – |
| E5 | Markierung, Zoom/Pan, Trefferliste, Korrektur | – |
| E6 | Weißabgleich, Kachel-Modus, PNG-Export, Feinschliff | – |

## Einrichtung

1. **GitHub Pages** aktivieren (Repo → Settings → Pages → Branch `main`, Ordner `/root`).
2. **Teiledaten einmalig laden:** Repo → Actions → „LEGO-Teiledaten aktualisieren“
   → *Run workflow*. Die Action lädt `parts`, `colors`, `part_categories` und
   `part_relationships` von rebrickable.com nach `lego/data/` und committet sie.
   Danach läuft sie monatlich automatisch.
   Alternativ lokal: `bash lego/tools/update-data.sh` und die Dateien committen.
3. Auf dem iPad die URL in Safari öffnen → Teilen → **Zum Home-Bildschirm**.
   Als Home-Bildschirm-App löscht Safari die lokalen Daten nicht nach 7 Tagen.

Die App lädt die Daten beim ersten Start (ca. 5 MB) und speichert sie in IndexedDB.
Danach funktioniert die Teilesuche offline. Lädt nichts, kann man die CSV-Dateien
auch direkt importieren: rebrickable.com/downloads → Dateien in der „Dateien“-App
sichern → Einstellungen → „Dateien importieren …“ (`.csv` oder `.csv.gz`).

## Aufbau

```
lego/
  index.html              Oberfläche (4 Schritte als Tabs, Dialoge)
  manifest.webmanifest    PWA-Manifest
  sw.js                   Service Worker (App-Shell offline)
  css/app.css
  js/ui.js                Einstieg, Tabs, Suche, Farbauswahl, Suchliste, Einstellungen
  js/settings.js          Einstellungen + Suchliste (localStorage)
  js/db.js                IndexedDB-Wrapper
  js/data.js              Rebrickable-CSVs laden/parsen/importieren
  js/search.js            Suchindex + Variantenfamilien (part_relationships)
  js/color.js             Farbhilfen (ab E3: Lab/CIEDE2000)
  data/                   Rebrickable-Daten (von der Action geschrieben)
  tools/update-data.sh    Daten-Update-Skript
```

Bei Änderungen an App-Dateien `CACHE_VERSION` in `sw.js` erhöhen, sonst sieht
das iPad die neue Version nicht. Die App zeigt dann „Neue Version verfügbar“.

## Datenschutz / Secrets

Keine Schlüssel im Code. Einstellungen und Suchliste liegen nur im Browser
(localStorage), Teiledaten in IndexedDB. Fotos verlassen das Gerät erst ab E4,
und dann nur als Ausschnitte an Brickognize (bzw. an den eingestellten Proxy).
