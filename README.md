# Freundeskalender

Ein schlichter Veranstaltungskalender für eine feste Gruppe: jeder trägt Termine ein,
jeder antwortet pro Termin per Ampel (**rot / gelb / grün**), und jeder sieht, wer dabei ist.
Dazu ein persönlicher Abo-Link für den Handy-Kalender.

Die Ampel ist absichtlich nur farbig und immer in derselben Reihenfolge — rot links,
grün rechts. Wer wie geantwortet hat, steht in der Spalte direkt unter dem jeweiligen Knopf,
die Zuordnung hängt also nicht allein an der Farbe. Vorlesesoftware bekommt die Bedeutung
über `aria-label`.

- **Frontend**: statische Seite auf GitHub Pages (`web/`) — kein Build-Schritt, kein Framework.
- **Backend**: ein Cloudflare Worker mit D1-Datenbank (`worker/`) — liefert API und ICS-Feed.
- **Anmeldung**: persönlicher Einladungslink. Einmal öffnen, danach bleibt man eingeloggt.

---

## Einrichtung

Gebraucht werden ein GitHub-Account, ein kostenloser Cloudflare-Account und **Node.js 22
oder neuer** (Wrangler verlangt das). Beide Dienste bleiben für eine Gruppe dieser Größe
dauerhaft im Gratis-Kontingent.

Mit [nvm](https://github.com/nvm-sh/nvm) nimmt `nvm use` im Projektordner automatisch die
in `.nvmrc` hinterlegte Version:

```bash
nvm install 22   # einmalig, falls noch nicht vorhanden
nvm use          # liest .nvmrc
```

### 1. Backend ausrollen

```bash
cd worker
npm install
npx wrangler login          # öffnet den Browser zur Cloudflare-Anmeldung

npx wrangler d1 create kalender
```

Der letzte Befehl gibt eine `database_id` aus. Diese in [`worker/wrangler.toml`](worker/wrangler.toml)
anstelle von `HIER_DIE_DATABASE_ID_EINTRAGEN` einsetzen. Dann:

```bash
npm run db:init             # legt die Tabellen an
npm run deploy              # gibt die Worker-URL aus, z.B. https://kalender.DEINNAME.workers.dev
```

Bei einer **bereits bestehenden** Datenbank legt `db:init` keine neuen Spalten an
(`CREATE TABLE IF NOT EXISTS`). Dafür gibt es `worker/migrations/` — jede Datei einmal
anwenden, zum Beispiel:

```bash
npx wrangler d1 execute kalender --remote --file migrations/0001_personenfarbe.sql
```

### 2. Dich selbst als Admin anlegen

Die erste Person muss direkt in der Datenbank angelegt werden — alle weiteren legst du
danach bequem auf der Seite an.

```bash
cd worker
TOKEN=$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=')
ICS=$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=')

npx wrangler d1 execute kalender --remote --command \
  "INSERT INTO users (name, token, ics_token, is_admin) VALUES ('Fidelis', '$TOKEN', '$ICS', 1)"

echo "Dein Einladungslink endet auf:  #t=$TOKEN"
```

Den Token notieren — er ist dein Zugang.

### 3. Frontend veröffentlichen

Die Worker-URL aus Schritt 1 in [`web/config.js`](web/config.js) eintragen:

```js
window.KALENDER_API = "https://kalender.DEINNAME.workers.dev";
```

Dann das Repository zu GitHub pushen und unter **Settings → Pages → Source** den Punkt
**GitHub Actions** wählen. Der mitgelieferte Workflow veröffentlicht `web/` bei jedem Push.

Die Seite liegt danach unter `https://DEINNAME.github.io/REPONAME/`.
Zum ersten Mal öffnest du sie mit deinem Token angehängt:

```
https://DEINNAME.github.io/REPONAME/#t=DEIN_TOKEN
```

Der Token wandert in den Browser-Speicher, der Link wird aus der Adresszeile entfernt.
Ab jetzt reicht die nackte Adresse.

### 4. Absichern (empfohlen)

In [`worker/wrangler.toml`](worker/wrangler.toml) `ALLOWED_ORIGIN` auf die eigene
Pages-Adresse setzen und `npm run deploy` nochmal laufen lassen:

```toml
ALLOWED_ORIGIN = "https://DEINNAME.github.io"
```

### 5. Freunde einladen

Auf der Seite unter **Personen verwalten** einen Namen eintragen. Es erscheint ein
persönlicher Einladungslink zum Kopieren — einmal verschicken, fertig. Wer ihn öffnet,
ist dauerhaft angemeldet und taucht bei allen Veranstaltungen mit seinem Namen auf.

---

## Profil, Farben und Zweitgerät

Unter **Mein Profil** kann jeder seinen angezeigten Namen und seine Farbe ändern. In dieser
Farbe erscheint man bei allen anderen in den Veranstaltungen. Neu angelegte Personen bekommen
reihum automatisch eine Farbe aus einer Palette von zwölf.

Im selben Bereich steht unter **Weiteres Gerät hinzufügen** der eigene Einladungslink noch
einmal zum Kopieren — zum Anmelden auf Handy, Tablet oder in einem zweiten Browser. Es ist
derselbe Link wie bei der Einladung; er gilt unbegrenzt und für beliebig viele Geräte.

## Kalender abonnieren

Unter **Kalender abonnieren** findet jeder seinen persönlichen Link.

- **iPhone**: auf „Im Handy-Kalender öffnen" tippen (`webcal://`-Link).
- **Android / Google Kalender**: die `https://…/ics/….ics`-Adresse kopieren und unter
  [calendar.google.com](https://calendar.google.com) → *Weitere Kalender* → *Per URL* einfügen.
  (Die Google-App selbst kann keine Abos anlegen, nur die Weboberfläche.)

Im Feed stehen alle Veranstaltungen, bei denen du **nicht abgesagt** hast. Sagst du ab,
verschwindet der Termin beim nächsten Sync aus deinem Kalender. Zusagen erscheinen als
feste Termine, alles andere als unverbindlich (`TENTATIVE`, wird nicht als „beschäftigt" gewertet).

Wer nur die festen Zusagen im Kalender haben will, hängt `?only=yes` an die Abo-Adresse.

**Wichtig:** Handy-Kalender holen Abos in eigenem Rhythmus — iOS je nach Einstellung alle
5 Minuten bis täglich, Google Calendar oft erst nach Stunden. Änderungen erscheinen also
nicht sofort. Auf der Webseite dagegen sind sie es.

---

## Wie die Anmeldung funktioniert

Jede Person hat ein zufälliges, unbegrenzt gültiges Token. Es steckt im Einladungslink,
landet im `localStorage` des Browsers und wird bei jeder Anfrage als
`Authorization: Bearer …` mitgeschickt. Kein Passwort, keine Sitzung, kein Ablaufdatum.

Das heißt auch: **wer den Link hat, ist diese Person.** Für einen Freundeskreis ist das
in Ordnung, für Fremde nicht. Ist ein Link abhandengekommen, lässt sich über
`POST /api/users/:id/tokens` (Admin) ein neues Paar erzeugen; der alte Link wird damit ungültig.

Der ICS-Abo-Link trägt ein zweites, getrenntes Token, weil Kalender-Apps keine
Anmelde-Header schicken können. Er erlaubt nur Lesen.

---

## API

Alle `/api/`-Endpunkte erwarten `Authorization: Bearer <token>`.

| Methode | Pfad | Zweck |
|---|---|---|
| `GET` | `/api/state` | Alles auf einmal: eigenes Profil, Personen, Veranstaltungen, Antworten, Abo-URL, Farbpalette |
| `PATCH` | `/api/me` | Eigenen Namen und/oder Anzeigefarbe ändern: `{"name":"…","color":"#1971c2"}` |
| `POST` | `/api/events` | Veranstaltung anlegen |
| `PATCH` | `/api/events/:id` | Ändern (nur Ersteller oder Admin) |
| `DELETE` | `/api/events/:id` | Löschen (nur Ersteller oder Admin) |
| `PUT` | `/api/events/:id/rsvp` | Antwort setzen: `{"status":"yes"\|"maybe"\|"no"}` |
| `DELETE` | `/api/events/:id/rsvp` | Antwort zurücknehmen |
| `GET` | `/api/users` | Personen inkl. Einladungs-Token (Admin) |
| `POST` | `/api/users` | Person anlegen (Admin) |
| `DELETE` | `/api/users/:id` | Person entfernen (Admin) |
| `POST` | `/api/users/:id/tokens` | Neue Tokens erzeugen (Admin) |
| `GET` | `/ics/<ics_token>.ics` | ICS-Feed, ohne Header-Anmeldung |

Zeitpunkte: ganztägige Termine als `YYYY-MM-DD`, sonst als UTC (`YYYY-MM-DDTHH:MM:SSZ`).
Die Oberfläche rechnet durchgehend in Europe/Berlin um, auch über die Zeitumstellung hinweg.

---

## Lokal entwickeln

```bash
cd worker
npm run db:init:local
npx wrangler d1 execute kalender --local --command \
  "INSERT INTO users (name, token, ics_token, is_admin) VALUES ('Test','testtoken1234567890abcd','testics1234567890abcdef',1)"
npx wrangler dev                      # API auf http://127.0.0.1:8787

# in einem zweiten Terminal:
cd web && python3 -m http.server 8080
```

Dafür in `web/config.js` kurzzeitig `http://127.0.0.1:8787` eintragen und
`http://127.0.0.1:8080/index.html#t=testtoken1234567890abcd` öffnen.

Der lokale `wrangler dev` würde `ALLOWED_ORIGIN` aus `wrangler.toml` lesen und damit nur die
Pages-Adresse erlauben. Lege stattdessen `worker/.dev.vars` an — die Datei gilt nur für
`wrangler dev`, wird nie deployt und ist über `.gitignore` ausgeschlossen:

```
ALLOWED_ORIGIN = "*"
```

> Läuft etwas nicht, ist fast immer die Node-Version schuld: `node --version` muss 22+
> zeigen. Wrangler bricht sonst mit einem klaren Hinweis ab.
