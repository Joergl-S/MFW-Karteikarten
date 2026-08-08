# Urlaub Packliste – Einrichtung (einmalig, ca. 5 Minuten)

Die Packliste (`urlaubspackliste.html`) zeigt allen Familienmitgliedern denselben
Stand in Echtzeit. Dafür wird eine kostenlose Firebase Realtime Database
verwendet (kein OneDrive möglich, da OneDrive keine echtzeitfähige, ohne
Server nutzbare API für mehrere gleichzeitige Nutzer bietet – Firebase ist
dafür gemacht und komplett kostenlos für diesen Anwendungsfall).

## 1. Firebase-Projekt anlegen

1. Gehe zu https://console.firebase.google.com und melde dich mit einem
   Google-Konto an.
2. Klicke auf **"Projekt hinzufügen"**, vergib einen Namen (z.B. `familie-urlaub`)
   und schließe die Erstellung ab (Google Analytics kann deaktiviert werden).

## 2. Realtime Database aktivieren

1. Im Projekt links im Menü **Build → Realtime Database** öffnen.
2. **"Datenbank erstellen"** klicken, einen Standort wählen (z.B. Europe).
3. Im Dialog **"Testmodus starten"** wählen (wir schränken die Regeln gleich
   gezielt ein).

## 3. Sicherheitsregeln setzen

Im Tab **"Regeln"** der Realtime Database folgendes eintragen und
**veröffentlichen**:

```json
{
  "rules": {
    "urlaubspackliste": {
      ".read": true,
      ".write": true
    }
  }
}
```

Das erlaubt Lesen/Schreiben nur innerhalb des Pfads `urlaubspackliste`
(unsere Packliste), ohne Login – passend für eine private Familienliste ohne
sensible Daten. Der Link zur Seite sollte daher nicht öffentlich geteilt
werden, sondern nur an die Familie.

## 4. Web-App registrieren und Zugangsdaten kopieren

1. Zurück zur Projektübersicht (Zahnrad oben links → **Projekteinstellungen**).
2. Unter **"Meine Apps"** auf das Web-Symbol `</>` klicken, App registrieren
   (z.B. Name „Packliste“), **Firebase Hosting nicht** nötig.
3. Es erscheint ein `firebaseConfig`-Objekt mit Werten wie `apiKey`,
   `authDomain`, `databaseURL`, `projectId`, usw. – diese kopieren.

## 5. Werte in die App eintragen

In `urlaubspackliste.html` den Abschnitt `firebaseConfig` (oben im
`<script>`-Bereich) mit den kopierten Werten ersetzen:

```js
const firebaseConfig = {
  apiKey: "…",
  authDomain: "…",
  databaseURL: "…",
  projectId: "…",
  storageBucket: "…",
  messagingSenderId: "…",
  appId: "…"
};
```

Speichern, committen und pushen. Danach die Seite `urlaubspackliste.html`
öffnen (lokal oder über GitHub Pages) – die Meldung „Einmalige Einrichtung
nötig“ verschwindet und die Liste ist einsatzbereit.

## 6. Mit der Familie teilen

Den Link zu `urlaubspackliste.html` (z.B. die GitHub-Pages-URL dieses Repos)
per Nachricht an die 4 Reisenden schicken. Jede Spalte kann durch Klick auf
den Spaltenkopf umbenannt werden (z.B. mit den echten Namen). Alle Häkchen
und neuen Einträge erscheinen sofort bei allen anderen.
