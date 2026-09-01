# webpilot

Ein steuerbarer Browser mit Aktions-Recorder und MCP-Anbindung.

webpilot startet einen sichtbaren Chromium mit **persistentem Profil**, damit ein
einmal manuell durchgefuehrter Login ueber Neustarts hinweg erhalten bleibt.
Was man in diesem Browser tut, laesst sich **aufzeichnen** (ein Ereignis pro
JSONL-Zeile) und spaeter **wieder abspielen**. Derselbe Browser haengt ausserdem
als **MCP-Server** an stdio, sodass ein Agent wie Claude Code ihn ueber Tools
bedienen kann.

Passwoerter landen dabei nie im Klartext in einer Datei: sie werden bereits in
der Seite durch `{{secret:<feldname>}}` ersetzt und beim Abspielen aus der
Umgebung aufgeloest.

---

## Voraussetzungen

- Node 22 oder neuer
- Chromium fuer Playwright

```bash
npm install
npx playwright install chromium   # entfaellt, wenn PLAYWRIGHT_BROWSERS_PATH schon gesetzt ist
npm run build
```

Playwright ist auf `1.56.1` gepinnt. Die Chromium-Revision muss zur
Playwright-Version passen; ein `npx playwright install chromium` nach einem
Versionswechsel ist Pflicht.

---

## Konfiguration

`config.json` im Projektwurzelverzeichnis:

```json
{
  "allowedDomains": ["localhost", "127.0.0.1"],
  "profilesDir": "profiles",
  "flowsDir": "flows",
  "screenshotsDir": "screenshots",
  "logBufferSize": 500
}
```

`allowedDomains` ist die Domain-Allowlist. Regeln:

| Eintrag           | erlaubt                                            |
| ----------------- | -------------------------------------------------- |
| `example.com`     | `example.com` und jede Subdomain                    |
| `*.example.com`   | nur Subdomains, nicht die Apex-Domain               |
| `*`               | alles (bewusst explizit)                            |

Die Allowlist regelt **Navigationen**. Daneben telefoniert Chromium von sich
aus nach Hause — Autofill-Daten, Komponenten-Updates, Sync, Domain Reliability.
Das hat mit der Absicht des Nutzers nichts zu tun, faellt aber auch nicht unter
"Navigation", weshalb webpilot diese Dienste beim Start abschaltet
(`--disable-background-networking` und Verwandte). Sonst spricht der Browser mit
Dritten, obwohl die Allowlist nur localhost enthaelt.

Verglichen wird ausschliesslich der Hostname: **der Port spielt keine Rolle**
(`localhost` deckt jeden Port ab) und `http` und `https` sind gleichermassen
erlaubt. Nicht-HTTP(S)-Schemata (`file:`, `data:`, `javascript:`) sind nie
erlaubt.

**Die Allowlist greift nur auf Navigationen des Hauptframes.** Subframes bleiben
frei — sonst brechen Logins mit eingebettetem OAuth oder Captcha.

Durchgesetzt wird sie in zwei Schichten:

1. **Vorab im Route-Handler.** Ist die Ziel-URL nicht erlaubt, wird der Request
   abgebrochen, bevor er das Geraet verlaesst. Im Log steht dann
   `Navigation blockiert: <url>`, die aktuelle Seite bleibt unveraendert stehen.
2. **Reissleine.** Committet der Hauptframe trotzdem eine nicht erlaubte URL,
   wird die Seite sofort verlassen und der Vorgang als `ERROR` protokolliert.
   Geprueft wird bei jedem `framenavigated` **und** sofort, wenn eine neue Seite
   auftaucht: bei einem Popup ist die Erstnavigation bereits abgeschlossen, wenn
   Playwright davon berichtet, ein `framenavigated` kommt dazu nicht mehr. Ein
   Popup auf einer nicht gelisteten Domain wird geschlossen (`goto` liefe dort
   ins Leere, solange die Erstnavigation noch laeuft), eine normale Seite
   wechselt auf `about:blank`.

Die zweite Schicht ist noetig, weil Playwright den Route-Handler bei einem
**Server-Redirect nicht erneut aufruft**: eine erlaubte URL, die per 302 auf
eine nicht gelistete Domain zeigt, laeuft an Schicht 1 vorbei (nachgemessen,
Test in `test/e2e.mjs`). Die Grenze ehrlich benannt: in diesem Fall ist der GET
auf das Redirect-Ziel bereits gelaufen, wenn die Reissleine greift. Der Inhalt
wird verworfen und nie angezeigt oder bedient, aber die Anfrage hat
stattgefunden. Wer das ausschliessen muss, gehoert hinter einen echten
Egress-Proxy — ein Browser-internes Interception-API kann das nicht leisten.

---

## CLI

```bash
webpilot open   --profile <name> [--url <url>] [--headless]
webpilot record <flow>  --profile <name> [--url <url>]
webpilot replay <flow>  --profile <name> [--timeout <ms>]
webpilot mcp            [--profile <name>]
```

Ueber die npm-Skripte (bauen jeweils vorher):

```bash
npm run open   -- --profile privat --url https://example.com
npm run record -- login --profile privat --url https://example.com/login
npm run replay -- login --profile privat
npm run build && npm run --silent mcp
```

Optionen:

| Option            | Bedeutung                                                  |
| ----------------- | ---------------------------------------------------------- |
| `--profile <name>`| Profilverzeichnis unter `profiles/` (Default `default`)     |
| `--url <url>`     | Startseite, muss in der Allowlist stehen                    |
| `--headless`      | Browser unsichtbar starten (sonst sichtbar)                 |
| `--config <pfad>` | alternative `config.json`                                   |
| `--timeout <ms>`  | Zeitbudget je Aktion beim Replay (Default 10000)            |

Umgebungsvariablen: `WEBPILOT_HEADLESS=1` erzwingt headless,
`WEBPILOT_LOG_LEVEL=debug|info|warn|error` steuert die Ausgabe auf stderr.

Auf einem Rechner ohne Bildschirm (Container, CI) laeuft der sichtbare Modus
unter `xvfb-run`:

```bash
xvfb-run -a node dist/cli.js open --profile privat --url http://localhost:3000
```

---

## Aufnehmen und Abspielen

```bash
# 1. Einmalig manuell einloggen; das Profil merkt sich die Sitzung.
npm run open -- --profile privat --url https://example.com/login

# 2. Ablauf aufzeichnen.
npm run record -- login --profile privat --url https://example.com/login
#    ... im Browser klicken und tippen, danach Fenster schliessen oder Strg+C

# 3. Passwort in die Umgebung legen und abspielen.
export WEBPILOT_SECRET_PASSWORD='...'
npm run replay -- login --profile privat
```

### Secrets

Ein Feld mit `type=password` oder `autocomplete=current-password` /
`new-password` wird **in der Seite** maskiert. Der Klartext verlaesst den
Browser nie — auch nicht in einen Zwischenpuffer. Im JSONL steht:

```json
{"kind":"fill","value":"{{secret:password}}","secret":true, ...}
```

Beim Abspielen wird `{{secret:<feld>}}` aus `WEBPILOT_SECRET_<FELD>` aufgeloest
(Grossbuchstaben, alles Nicht-Alphanumerische zu `_`). Also:
`{{secret:password}}` → `WEBPILOT_SECRET_PASSWORD`.

Der Praefix ist Absicht und nicht optional: ein Rueckfall auf den blanken
Feldnamen waere bequem, wuerde aber bei einem Feld namens `path`, `home` oder
`user` den Inhalt von `$PATH`, `$HOME` oder `$USER` in ein Webformular tippen.

Fehlt der Wert, bricht der Replay ab und nennt die erwartete Variable. Der
Platzhalter wird niemals als Text in ein Formular getippt.

### Flow-Format

Eine JSON-Zeile pro Ereignis in `flows/<name>.jsonl`. Gemeinsame Felder:
`index`, `id`, `ts`, `url`, `frame`. Ereignisarten:

| `kind`     | zusaetzliche Felder                    |
| ---------- | -------------------------------------- |
| `navigate` | —                                      |
| `click`    | `target`, `causedBy`, `causeKind`      |
| `fill`     | `target`, `value`, `secret`            |
| `select`   | `target`, `values`                     |
| `press`    | `target`, `key`                        |
| `submit`   | `target`, `causedBy`, `causeKind`      |

`target.selectors` enthaelt `primary` plus genau zwei `fallbacks`.
`frame.path` ist die Kette der iframe-Element-Selektoren vom Hauptframe bis zum
Zielframe (leer = Hauptframe).

Ein Ereignis mit `causedBy` ist die **Folge** eines frueheren Ereignisses und
wird beim Abspielen uebersprungen — sonst wuerde die Aktion doppelt ausgefuehrt.
`causeKind` sagt, woher die Zuordnung stammt:

| `causeKind`           | Bedeutung                                                             |
| --------------------- | --------------------------------------------------------------------- |
| `submitter`           | Das `submit`-Event nennt den Button, dessen Klick aufgezeichnet wurde  |
| `implicit-activation` | Die Aktivierung, die Enter selbst ausgeloest hat (Default-Button eines Formulars, oder der fokussierte Link) |
| `sequence`            | Davor Klick/Enter im selben Formular, keine weitere Aktion dazwischen  | Ebenso wird nur die **erste** Navigation aktiv als `goto`
ausgefuehrt; spaetere sind Folgen einer Aktion und wuerden POST-basierte Logins
zerlegen.

Schlaegt ein Selektor fehl, versucht der Replay der Reihe nach die beiden
Fallbacks. Greift keiner, bricht er ab und schreibt einen Screenshot:

```
Replay "login" abgebrochen bei Ereignis #4 (fill).
  Grund:            Kein Selektor hat gegriffen:
  data-testid=user: locator.waitFor: Timeout 10000ms exceeded.
  #user: locator.waitFor: Timeout 3000ms exceeded.
  css=#login-form input[name="user"]: locator.waitFor: Timeout 3000ms exceeded.
  Aufgezeichnete URL: https://example.com/login
  Aktuelle URL:       https://example.com/session-abgelaufen
  Screenshot:         /pfad/screenshots/login-004-fill-2026-09-01T03-00-56-453Z.png
```

---

## MCP-Server

```bash
npm run build && npm run --silent mcp
```

Der Server spricht JSON-RPC ueber **stdout**; jede Logzeile geht auf **stderr**.

| Tool                | Eingabe                              | Wirkung |
| ------------------- | ------------------------------------ | ------- |
| `browser_open`      | `profile?`, `url?`                   | Browser mit persistentem Profil oeffnen, optional navigieren |
| `browser_snapshot`  | —                                    | ARIA-Snapshot mit stabilen Referenzen `[ref=e12]` |
| `browser_click`     | `ref`                                | Element aus dem letzten Snapshot anklicken |
| `browser_type`      | `ref`, `text`                        | Text in ein Element aus dem letzten Snapshot schreiben |
| `browser_screenshot`| `fullPage?`                          | PNG der aktuellen Seite |
| `record_start`      | `name`                               | Aufzeichnung nach `flows/<name>.jsonl` starten |
| `record_stop`       | —                                    | Aufzeichnung beenden |
| `flow_list`         | —                                    | vorhandene Flows mit Anzahl Ereignisse |
| `flow_run`          | `name`                               | Flow abspielen |
| `log_tail`          | `n`                                  | letzte n Logzeilen |

Alle Eingaben sind mit zod validiert. Fehler kommen als **Tool-Error**
(`isError: true`) zurueck, nicht als Protokollfehler.

Referenzen aus `browser_snapshot` gelten genau fuer diesen einen Snapshot. Bei
einem neuen Dokument beginnt Playwright die Nummerierung wieder bei `e1` — ein
altes `e11` zeigt danach nicht ins Leere, sondern womoeglich auf ein voellig
anderes Element. webpilot zaehlt deshalb pro Seite die Navigationen mit und
lehnt `browser_click` und `browser_type` mit einer klaren Meldung ab, sobald
sich der Stand seit dem Snapshot geaendert hat.

Ein paar Eigenschaften, die man kennen sollte:

- **`browser_snapshot` schwaerzt Passwoerter.** Der ARIA-Snapshot enthaelt
  Feldwerte im Klartext, auch die von Passwortfeldern. Auf einer Seite mit
  gespeichertem oder automatisch gefuelltem Login waere jeder Snapshot sonst
  ein Passwort-Leak ins Transkript. webpilot ersetzt solche Werte vor der
  Rueckgabe durch `{{secret:<feld>}}` — auch in offenen Shadow-Roots, und auch
  dann, wenn der Snapshot den Wert normalisiert oder YAML-escaped darstellt
  (dafuer wird die Zeile ueber den Feldnamen gefunden, nicht ueber den Wert).
- **Referenzen ueberleben `pushState`.** Entwertet wird nur bei einem echten
  Dokumentwechsel; erkannt wird der ueber eine Markierung im Dokument, nicht
  ueber einen Navigationszaehler. Eine SPA, die die URL periodisch umschreibt,
  wuerde sonst jeden Snapshot sofort entwerten.
- **`browser_open` prueft den Profilnamen zuerst.** Ein Tippfehler kostet nicht
  die laufende Sitzung samt manuell durchgefuehrtem Login.
- **Aufrufe werden serialisiert.** Das SDK laesst Tool-Aufrufe parallel laufen;
  auf einer geteilten Seite entwertet ein navigierender `browser_click` genau
  die Referenzen, die ein gleichzeitiger `browser_snapshot` gerade ausgibt.
  Alles, was den Browser anfasst, laeuft deshalb nacheinander.
- **`browser_type` benutzt `fill()`** — ein Rutsch, richtig fuer Formularfelder.
  Nur wenn das Ziel nicht fuellbar ist, wird echt getippt (`pressSequentially`),
  damit Typeahead und Validierung der Seite laufen.
- **`browser_screenshot`** liefert ein PNG des sichtbaren Bereichs. Ab 2 MB wird
  das Bild nicht eingebettet, sondern nach `screenshots/` geschrieben und nur
  der Pfad gemeldet — sonst sprengt es das Kontextfenster.
- **Der Server beendet sich, wenn der Host verschwindet.** Auf `SIGINT`,
  `SIGTERM` und auf ein Ende von stdin; sonst bliebe ein sichtbares
  Browserfenster stehen und der Prozess liefe weiter.
- **`record_stop` holt den zuletzt eingegebenen Wert ab.** Ein gerade getippter
  Feldwert wartet noch auf sein ausloesendes Ereignis (Klick, Enter,
  Fokuswechsel). Endet die Aufnahme direkt nach der Eingabe, kommt das nie —
  `record_stop` stoesst deshalb in jedem Frame einen Flush an und wartet ab, bis
  die Meldung angekommen ist.
- **`log_tail` sieht nur diesen Prozess.** Der Ringpuffer gehoert dem laufenden
  MCP-Server; Zeilen aus einem separaten `webpilot record`-Lauf stehen nicht
  darin.

### Einbinden in Claude Code

`.mcp.json` im Projektverzeichnis (projektweit geteilt):

```json
{
  "mcpServers": {
    "webpilot": {
      "command": "node",
      "args": ["/absoluter/pfad/zu/webpilot/dist/cli.js", "mcp", "--profile", "default"],
      "env": {
        "WEBPILOT_SECRET_PASSWORD": "hier-das-passwort"
      }
    }
  }
}
```

Oder direkt auf der Kommandozeile:

```bash
claude mcp add webpilot -- node /absoluter/pfad/zu/webpilot/dist/cli.js mcp --profile default
```

Danach `/mcp` in Claude Code aufrufen, um den Status zu pruefen. Wichtig:
`npm run build` muss gelaufen sein, `dist/cli.js` muss existieren, und der Pfad
muss absolut sein.

Auf einem Rechner ohne Bildschirm zusaetzlich `"WEBPILOT_HEADLESS": "1"` in
`env` setzen — oder `command: "xvfb-run"` mit `args: ["-a", "node", ...]`.

Als `command` gehoert hier `node` hin, nicht `npm`: `npm run mcp` schreibt
seinen eigenen Banner auf **stdout**, und dort laeuft das JSON-RPC-Protokoll.
Der SDK-Client verkraftet die zwei Zeilen zwar (nicht parsebare Zeilen werden
gemeldet und uebersprungen), aber sauber ist es nicht. Das Skript `mcp` startet
deshalb nur noch `node dist/cli.js mcp` ohne vorgeschalteten Build — `npm run
build` gehoert davor. Wer es trotzdem ueber npm starten will: `npm run --silent
mcp` unterdrueckt den Banner.

Der Standard-Timeout des SDK-Clients liegt bei 60 s. Der allererste Aufruf von
`browser_open` startet einen Chromium und kann bei kaltem Cache laenger
brauchen.

---

## Tests

```bash
npm test          # e2e gegen echten Chromium + MCP-Sprechtest
npm run test:e2e  # nur Browser/Recorder/Replay
npm run test:mcp  # nur MCP ueber stdio mit dem SDK-Client
npm run testpage  # nur die Testseite auf http://127.0.0.1:8787
```

`test/server.mjs` liefert eine deterministische Login-Testseite (`demo` /
`s3cr3t`), inklusive einer Variante, deren iframe-URL bei jedem Aufruf eine
neue Nonce traegt. Beide Testlaeufe starten diesen Server selbst.

Die e2e-Artefakte landen unter `.tmp-test/`, `profiles/` und `flows/` bleiben
unberuehrt. Auf Rechnern ohne Bildschirm laufen die Tests headless.

---

## Verzeichnisse und Sicherheit

```
src/browser.ts    persistenter Kontext, Domain-Allowlist
src/recorder.ts   Injektion und Ereignis-Erfassung, JSONL-Ausgabe
src/selector.ts   Selektor-Generierung (in-page) und -Aufloesung (Node)
src/replay.ts     Flow-Interpreter
src/mcp.ts        MCP-Server ueber stdio
src/cli.ts        open, record, replay, mcp
src/config.ts     config.json und Allowlist-Auswertung
src/log.ts        stderr-Logger mit Ringpuffer fuer log_tail
flows/            aufgezeichnete Ablaeufe
profiles/         Browser-Profile        (gitignored)
screenshots/      Fehler-Screenshots     (gitignored)
```

`profiles/` enthaelt Session-Cookies und damit den Login-Zustand, `screenshots/`
kann Seiteninhalte samt eingeblendeter Daten zeigen. Beide stehen in
`.gitignore` und gehoeren nicht in ein Repository.

---

## Umgesetzte Entscheidungen

Ein paar Stellen sind bewusst anders geloest, als man es zunaechst erwarten
wuerde. Die Gruende, kurz:

**Injizierter Code als Quelltext statt als Funktion.** `addInitScript`
serialisiert bei einer Funktion nur den Rumpf; Modulreferenzen aus dem Build
existieren im Browser nicht. webpilot setzt den In-Page-Teil deshalb aus
`Function.prototype.toString()` zu **einem** Quelltext zusammen und injiziert
ihn ueber `addInitScript({ content })`. `assertSelfContained()` prueft das
Ergebnis bei jedem Start auf `require(`, `import`, tslib-Helfer und
`<modul>_js_N.`-Referenzen und bricht sonst ab.

**submit-Heuristik ohne Zeitfenster.** Statt „gab es kurz vorher einen Klick“
nutzt webpilot zwei kausale Signale: `SubmitEvent.submitter` nennt den
ausloesenden Button direkt, und der Klick, den der Browser bei Enter selbst auf
den Default-Button erzeugt, wird ueber ein Flag erkannt, das nur waehrend der
Task des `keydown` gesetzt ist. Beides ist Kausalitaet, kein Zeitraten. Nur als
letzter Ausweg (kein `submitter`, kein Enter) greift eine Sequenz-Pruefung
„unmittelbar davor, nichts dazwischen“ mit grosszuegiger Obergrenze.

**Frames ueber die iframe-Element-Kette statt ueber die Frame-URL.** Beim
Aufzeichnen wird zu jedem Ereignis die Kette der `<iframe>`-Elemente vom
Hauptframe bis zum Zielframe abgelegt — jeweils mit Primaerselektor und zwei
Fallbacks. Beim Abspielen wird daraus eine Kette aus
`locator(...).contentFrame()`. Damit ist eine wechselnde Nonce in der Frame-URL
komplett egal; der Test deckt genau diesen Fall ab. Die Frame-URL wird nur noch
zur Diagnose mitgeschrieben.

**Kein isTrusted-Filter auf `input` und `change`.** Klicks und Tastendruecke
werden weiterhin nur erfasst, wenn sie vom Nutzer kommen — das filtert
JS-synthetisierte Klicks und den Label-auf-Input-Doppelklick weg. Bei `input`
und `change` waere derselbe Filter aber schaedlich: Passwortmanager, Autofill
und React-gesteuerte Felder setzen Werte ueber synthetische Events. Filtert man
die weg, lernt der Koaleszierer den Feldinhalt nie und der Login wird mit
leerem Passwortfeld aufgezeichnet. Beide Handler melden fuer sich ohnehin
nichts — sie merken sich nur den Wert bzw. schreiben ihn heraus; ausgeloest wird
das Herausschreiben von einer echten Nutzeraktion.

**`change` und `submit` in Shadow-Roots.** Beide Events sind `composed: false`
und erreichen einen Listener am `document` nicht, wenn sie in einer Shadow-Root
entstehen — bei Formularen aus Komponentenbibliotheken faellt damit die Haelfte
der Ereignisse weg. webpilot versorgt deshalb jede Shadow-Root, die ueber
`composedPath()` eines composed-Events sichtbar wird, mit denselben beiden
Listenern. Bedarfsgesteuert statt `attachShadow` zu patchen: so werden auch
deklarative Shadow-Roots (`<template shadowrootmode>`) erfasst. Der CSS-Pfad
ueberbrueckt Shadow-Grenzen mit einem Descendant-Kombinator, weil Playwrights
css-Engine offene Shadow-Roots durchdringt.

**Rolle von `input[type=password]`.** Laut ARIA hat ein Passwortfeld keine
Rolle. Playwright 1.56 bildet es ueber den Default-Zweig seiner Tabelle
trotzdem auf `textbox` ab — `getByRole('textbox', { name })` greift dort also.
webpilot erzeugt den Rollen-Selektor deshalb auch fuer Passwortfelder, sorgt
aber dafuer, dass immer mindestens ein rollenfreier Fallback (id oder
CSS-Attribut-Selektor) daneben steht, falls sich das in einer spaeteren
Playwright-Version wieder aendert.

**Snapshot-Referenzen.** Playwright 1.56 hat keine oeffentliche API fuer einen
ARIA-Snapshot mit refs: `locator.ariaSnapshot()` nimmt nur `{ timeout }`. Die
refs liefert `page._snapshotForAI()` — dieselbe interne Methode, die auch
Playwrights eigener MCP-Server verwendet. Aufgeloest wird ueber die
Selektor-Engine `aria-ref=`. Fehlt die Methode einmal, sagt das Tool das
deutlich, statt einen Snapshot ohne refs auszuliefern.

**`record_start` haelt den Startpunkt fest.** Wird die Aufnahme auf einer
bereits geoeffneten Seite gestartet — genau so laeuft es ueber das MCP-Tool —,
schreibt webpilot als erstes Ereignis eine `navigate`-Zeile mit der aktuellen
URL. Sonst haette der Flow keinen Anfang und `flow_run` wuerde spaeter dort
starten, wo der Browser gerade zufaellig steht.

**Der Screenshot-Umweg ueber die Platte ist Schutz, kein Feature.** Anforderung
5 listet `browser_screenshot` ohne Parameter — entsprechend nimmt das Tool den
sichtbaren Bereich auf und hat keine Optionen. Ueberschreitet das PNG trotzdem
2 MB (sehr grosses Fenster, sehr dichte Seite), wird es nach `screenshots/`
geschrieben und nur der Pfad gemeldet: base64-codiert sprengt so ein Bild jedes
Kontextfenster, und ein Tool, das die Antwort unbrauchbar macht, hilft
niemandem. Das ist eine Schutzgrenze fuer den Normalfall, keine zusaetzliche
Faehigkeit.

**Fehler im injizierten Code werden sichtbar gemacht.** Schlaegt ein
Init-Script in der Seite fehl, meldet weder `addInitScript()` noch `goto()`
etwas — man merkt es erst am leeren JSONL. webpilot haengt deshalb an jede Seite
einen `pageerror`-Listener und protokolliert Fehler, die nach Recorder-Code
aussehen, als `ERROR`.

**Textselektoren als `<tag>:text-is("...")`.** Der naheliegende Weg,
`locator(tag).filter({ hasText: /^\s*Text\s*$/ })`, prueft gegen den ROHEN
`textContent`. Ein Button, dessen Beschriftung im Markup ueber zwei Zeilen
umbrochen ist, waere damit nie wieder zu finden — aufgezeichnet wird der Text
ja mit normalisiertem Whitespace. `:text-is()` normalisiert genauso und
vergleicht exakt. Weil `:text-is` nur auf Blattelemente greift, wird ein
Textselektor auch nur fuer solche erzeugt: bei `<li><span>Alpha</span></li>`
wuerde ein Textselektor fuer das `li` die Aktion sonst still eine Ebene tiefer
umlenken.

**Der Accessible Name wird berechnet wie bei Playwright, nicht wie textContent.**
`aria-hidden`- und unsichtbare Teilbaeume zaehlen nicht mit, und aus dem
Inhalt wird ein Name nur fuer die Rollen gebildet, die das duerfen (Button,
Link, Heading, Option …), nicht fuer `list`, `listitem`, `table` oder `dialog`.
Das ist kein Detail: bei

```html
<button>Weiter <span aria-hidden="true">jetzt</span></button>
<button><span aria-hidden="true">Schritt</span>Weiter jetzt</button>
```

liefert schlichtes `textContent` fuer beide Knoepfe verschiedene Namen — der
Rollen-Selektor gilt dann als eindeutig und trifft beim Replay den **zweiten**
Button. Ein stiller Fehlgriff ist schlimmer als ein Fehlschlag.

**Selektor-Kandidaten werden in der Seite verifiziert.** Jeder Kandidat wird vor
dem Aufschreiben gezaehlt (CSS ueber `querySelectorAll`, Rolle und Text ueber
einen Durchlauf durch die Wurzel mit derselben Rollen- und Namensberechnung).
Bekannte Grenze: Playwrights css-Engine durchdringt offene Shadow-Roots,
`querySelectorAll` nicht. Enthaelt die Seite Shadow-Roots ausserhalb des
Zielelements, kann ein Selektor deshalb als eindeutig gelten und beim Replay
zwei Elemente treffen. Der Replay verlangt genau einen Treffer und greift dann
zum naechsten Fallback — es wird also nie das Falsche angeklickt, nur ein
Fallback verbraucht.
Eindeutige Kandidaten haben Vorrang, und die beiden Fallbacks stammen aus
anderen Strategie-Familien — sonst waeren sie im Fehlerfall genauso kaputt wie
der Primaerselektor.
