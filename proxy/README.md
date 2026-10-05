# Brickognize-Proxy (Cloudflare Worker)

Nur nötig, wenn in der App unter **Einstellungen → Verbindung testen** die Meldung
„nicht erreichbar … CORS“ erscheint, obwohl Internet da ist.

## Einrichten (im Browser, auch am iPad möglich, ca. 5 Minuten)

1. Kostenloses Konto auf https://dash.cloudflare.com anlegen und einloggen.
2. Links **Workers & Pages** → **Create** → **Create Worker** (bzw. „Start with Hello World!“).
   Name z. B. `brickognize-proxy` → **Deploy**.
3. **Edit code** → den gesamten Inhalt durch `proxy/worker.js` aus diesem Repo ersetzen → **Deploy**.
4. Zurück zum Worker → **Settings** → **Variables and Secrets** → **Add**:
   - Typ: *Text*, Name: `ALLOWED_ORIGIN`, Wert: `https://DEIN-GITHUB-NAME.github.io`
     (genau so, ohne Pfad und ohne Schrägstrich am Ende) → **Deploy**.
5. Die Worker-Adresse kopieren, z. B. `https://brickognize-proxy.DEINNAME.workers.dev`.
6. In der App: **Einstellungen → API-/Proxy-URL** = diese Adresse → **Verbindung testen** → **Speichern**.

Der Free-Plan von Cloudflare erlaubt 100 000 Anfragen pro Tag, das reicht locker.
Der Proxy speichert nichts und leitet nur `POST /predict/…` weiter.
