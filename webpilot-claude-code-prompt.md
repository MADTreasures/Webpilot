Projekt: "webpilot" — ein steuerbarer Browser mit Aktions-Recorder und MCP-Anbindung.

Stack: Node 22, TypeScript (ESM, strict), Playwright, @modelcontextprotocol/sdk, zod.
Keine weiteren Dependencies ohne Rückfrage.

Struktur:
  src/browser.ts   Playwright launchPersistentContext (chromium, headed), userDataDir profiles/<profile>
  src/recorder.ts  addInitScript-Injection + Event-Erfassung
  src/selector.ts  Selektor-Generierung
  src/replay.ts    Flow-Interpreter
  src/mcp.ts       MCP-Server (stdio)
  src/cli.ts       Kommandos: open, record, replay, mcp
  flows/           <name>.jsonl

Anforderungen:

1. Persistentes Profil: manueller Login bleibt über Neustarts erhalten. CLI
   `open --profile <name> --url <url>` öffnet den Browser sichtbar.

2. Recorder: erfasst click, input/change, submit, Enter-Keydown, Navigation, jeweils
   mit Timestamp, URL, Frame, Element-Selektor, Text/Wert. Selektor-Priorität:
   data-testid > id > Rolle+Accessible Name > sichtbarer Text > CSS-Pfad; zusätzlich
   2 Fallback-Selektoren pro Event speichern. Ausgabe als JSONL, ein Event pro Zeile.

3. Passwortfelder (type=password oder autocomplete=current-password) werden nie im
   Klartext geloggt: Wert ersetzen durch {{secret:<feldname>}}, Auflösung beim Replay
   aus process.env.

4. Replay: `replay <flow>` spielt das JSONL ab, nutzt Playwright-Locators mit
   Auto-Wait, versucht bei Fehlschlag die Fallback-Selektoren, bricht mit klarer
   Fehlermeldung samt Screenshot ab.

5. MCP-Server über stdio mit den Tools: browser_open, browser_snapshot (ARIA-Snapshot
   mit stabilen refs), browser_click(ref), browser_type(ref, text), browser_screenshot,
   record_start(name), record_stop, flow_list, flow_run(name), log_tail(n). Alle Inputs
   mit zod validiert, Fehler als Tool-Error zurück.

6. Domain-Allowlist in config.json; Navigation auf nicht gelistete Domains wird
   abgelehnt.

Definition of Done: `npm run mcp` läuft als MCP-Server; ein manuell aufgezeichneter
Login-Flow auf einer Testseite lässt sich fehlerfrei per flow_run wiederholen; README
mit Setup und der Claude-Code-MCP-Konfiguration.

Baue in dieser Reihenfolge und halte nach jedem Schritt kurz an: Browser-Kern →
Recorder → Replay → MCP-Server. Keine Zusatzfeatures über die Liste hinaus.


## Verifikation

Prüfe jeden Schritt echt, nicht nur per Typecheck. Du hast einen Browser — nutz ihn.

- Schreib dir eine minimale lokale Login-Testseite (Formular mit user/password, Submit,
  Weiterleitung auf eine zweite Seite) und serviere sie auf localhost. Damit ist der
  Test deterministisch, und localhost gehört ohnehin auf die Allowlist.
- Nach Schritt 3: record gegen diese Seite, dann replay. Das JSONL muss
  {{secret:...}} statt des Passworts enthalten, und der Replay muss durchlaufen.
- Nach Schritt 4: MCP-Server mit einem SDK-Client über stdio ansprechen — tools/list,
  ein Happy-Path-Tool und ein paar Fehlerfälle.


## Erfahrungswerte aus einem parallelen Durchlauf

Das sind Beobachtungen, keine Vorgaben. Wenn du eine Stelle anders löst und es
begründen kannst, ist das ein Ergebnis, kein Fehler.

- addInitScript serialisiert nur den Funktionsrumpf. Alles Injizierte muss ohne Imports
  und ohne äussere Variablen auskommen — nach dem Build mit fn.toString() gegenprüfen,
  ob sich Modul-Referenzen eingeschlichen haben.
- exposeBinding einmal beim Kontext-Setup registrieren; start/stop schalten nur die
  Senke um. Sonst wirft record_start beim zweiten Aufruf.
- Der CSS-Pfad darf nur bei der id eines Vorfahren abbrechen, nicht bei der eigenen.
  Sonst sind Primärselektor und Fallback identisch, und Elemente mit id haben null
  Fallbacks.
- input-Events koaleszieren (fertiger Wert bei change/blur/vor Klick/vor Enter), sonst
  hat ein Login 40 Zeilen JSONL.
- submit markieren, wenn kurz vorher im selben Formular geklickt oder Enter gedrückt
  wurde, und beim Replay überspringen. Sonst wird doppelt abgeschickt.
- Nur isTrusted-Events erfassen (ausser submit). Filtert JS-synthetisierte Klicks und
  den Label-auf-Input-Doppelklick weg.
- input[type=password] hat keine ARIA-Rolle; getByRole('textbox') greift dort nicht.
  Kein role=-Selektor für Passwortfelder erzeugen.
- Beim Replay nur die erste Navigation aktiv als goto ausführen. Spätere sind Folgen
  einer Aktion und würden POST-basierte Logins zerlegen.
- Snapshot-Refs kommen von Playwright selbst: locator.ariaSnapshot({mode:"ai"}) liefert
  [ref=eN], Zugriff über die Selektor-Engine aria-ref=eN.
- Bei stdio gehört stdout dem Protokoll. Jede Logzeile auf stderr.
- Die Allowlist nur auf Hauptframe-Navigationen anwenden. Blockst du auch iframes,
  brechen Logins mit eingebettetem OAuth oder Captcha.
- Screenshots und Profile gehören in .gitignore — die Profile enthalten
  Session-Cookies.

Die zwei Stellen mit der grössten Unsicherheit: die submit-Heuristik (Zeitfenster) und
die Frame-Auflösung im Replay bei iframes mit wechselnden Nonce-URLs. Wenn du dort
etwas Besseres findest, sag es.
