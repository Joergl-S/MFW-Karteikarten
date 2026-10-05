#!/usr/bin/env bash
# Lädt die Rebrickable-CSV-Dateien nach lego/data/ und schreibt version.json.
# Lokal ausführen:  bash lego/tools/update-data.sh
# Automatisch:      GitHub Action .github/workflows/lego-data.yml (monatlich + manuell)
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../data" && pwd)"
BASE="https://cdn.rebrickable.com/media/downloads"
UA="Mozilla/5.0 (LEGO-Teilefinder data update)"

for t in parts colors part_categories part_relationships; do
  echo "Lade $t.csv.gz …"
  curl -fsSL --retry 3 -A "$UA" "$BASE/$t.csv.gz" -o "$DIR/$t.csv.gz.tmp"
  # Plausibilitätsprüfung: gültiges gzip, Kopfzeile anzeigen
  gzip -t "$DIR/$t.csv.gz.tmp"
  gzip -dc "$DIR/$t.csv.gz.tmp" | head -n1 || true
  mv "$DIR/$t.csv.gz.tmp" "$DIR/$t.csv.gz"
done

printf '{ "updated": "%s" }\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DIR/version.json"
ls -la "$DIR"
