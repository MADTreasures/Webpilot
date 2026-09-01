/**
 * MCP-Server ueber stdio.
 *
 * Zwei Dinge sind hier nicht verhandelbar:
 *  - stdout gehoert dem JSON-RPC-Protokoll. Jede Logzeile geht ueber src/log.ts
 *    auf stderr; ein console.log wuerde den Transport zerstoeren.
 *  - Jeder Tool-Input wird mit zod validiert. Fehler kommen als Tool-Error
 *    zurueck (content + isError), nicht als Protokollfehler: der SDK wandelt
 *    eine im Callback geworfene Exception genau dazu um.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Page } from 'playwright';
import { z } from 'zod';
import { createSession, profileDirFor, type Session } from './browser.js';
import { isAllowedUrl, loadConfig, type ResolvedConfig } from './config.js';
import { createLogger, formatEntry, logTail } from './log.js';
import { isValidFlowName } from './recorder.js';
import { replayFlow } from './replay.js';

const log = createLogger('mcp');

/**
 * Playwright 1.56 hat keine oeffentliche API fuer einen ARIA-Snapshot MIT refs:
 * locator.ariaSnapshot() nimmt nur { timeout }. Die refs liefert die interne
 * Methode page._snapshotForAI(); genau die benutzt auch Playwrights eigener
 * MCP-Server. Aufgeloest wird danach ueber die Selektor-Engine aria-ref=.
 */
type PageWithSnapshotForAI = Page & {
  _snapshotForAI?: (options?: { timeout?: number }) => Promise<string>;
};

export const REF_PATTERN = /^(f\d+)*e\d+$/;

/** Ab dieser Groesse wird ein Screenshot nicht mehr ins Ergebnis eingebettet. */
export const MAX_SCREENSHOT_BYTES = 2_000_000;

export interface SecretValue {
  field: string;
  /** Nur zum Schwaerzen. Dieser Wert wird nie geloggt und nie zurueckgegeben. */
  value: string;
  /** Accessible Name des Feldes - damit laesst sich die Snapshot-Zeile finden. */
  name: string;
}

/**
 * Werte aller Passwortfelder einsammeln - ueber alle Frames.
 *
 * Klingt paradox, ist aber genau der Punkt: der ARIA-Snapshot enthaelt den
 * Feldinhalt im KLARTEXT (`textbox "Passwort" [ref=e4]: hunter2`). Ohne diesen
 * Schritt waere jeder browser_snapshot auf einer Seite mit ausgefuelltem oder
 * automatisch gefuelltem Loginformular ein Passwort-Leak ins Transkript.
 * Die Werte bleiben im Prozess und dienen nur dem Schwaerzen.
 */
export async function collectSecretValues(page: Page): Promise<SecretValue[]> {
  const out: SecretValue[] = [];
  for (const frame of page.frames()) {
    try {
      const found = await frame.evaluate(() => {
        const list: Array<{ field: string; value: string; name: string }> = [];
        // Auch durch offene Shadow-Roots laufen: der Snapshot zeigt deren
        // Inhalt, querySelectorAll allein sieht ihn nicht.
        const roots: Array<Document | ShadowRoot> = [document];
        for (let r = 0; r < roots.length && r < 200; r++) {
          const root = roots[r];
          if (!root) continue;
          const all = root.querySelectorAll('*');
          for (let i = 0; i < all.length; i++) {
            const el = all[i] as (Element & { shadowRoot?: ShadowRoot | null }) | undefined;
            if (el?.shadowRoot) roots.push(el.shadowRoot);
          }
          const inputs = root.querySelectorAll('input');
          for (let i = 0; i < inputs.length; i++) {
            const el = inputs[i] as HTMLInputElement | undefined;
            if (!el) continue;
            const type = (el.getAttribute('type') ?? '').toLowerCase();
            // autocomplete ist eine TOKENLISTE: "section-blau current-password"
            // ist voellig regulaer.
            const tokens = (el.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/);
            const isSecret =
              type === 'password' ||
              tokens.indexOf('current-password') !== -1 ||
              tokens.indexOf('new-password') !== -1;
            if (!isSecret || !el.value) continue;
            const label = el.labels && el.labels.length > 0 ? (el.labels[0]?.textContent ?? '') : '';
            const accName = (el.getAttribute('aria-label') || label || el.getAttribute('placeholder') || '')
              .replace(/\s+/g, ' ')
              .trim();
            list.push({
              field: el.getAttribute('name') || el.id || 'passwort',
              value: el.value,
              name: accName,
            });
          }
        }
        return list;
      });
      out.push(...found);
    } catch {
      // Frame abgeloest oder nicht erreichbar - dann gibt es dort auch nichts zu schwaerzen.
    }
  }
  return out;
}

/**
 * Ersetzt Passwortwerte im Snapshot durch {{secret:<feld>}}.
 *
 * Zwei Wege, weil einer allein nicht reicht:
 *
 * 1. STRUKTURELL. Eine Snapshot-Zeile sieht aus wie
 *      - textbox "Passwort" [ref=e4]: geheim
 *    Steht in den Anfuehrungszeichen der Name eines bekannten Passwortfeldes,
 *    wird alles hinter `]: ` ersetzt - egal, wie der Wert dargestellt wird.
 *    Das ist der verlaessliche Weg: der Snapshot normalisiert Whitespace und
 *    escaped Backslashes und Anfuehrungszeichen im YAML-Stil, ein Vergleich
 *    mit dem Rohwert geht dabei ins Leere.
 * 2. UEBER DEN WERT, in mehreren Darstellungen, falls die Seite ihn anderswo
 *    wiederholt oder das Feld keinen brauchbaren Namen hat. Bei sehr kurzen
 *    Passwoertern schwaerzt das mehr als noetig - das ist die richtige
 *    Richtung, in die ein solcher Filter irren darf.
 */
export function redactSecrets(snapshot: string, secrets: readonly SecretValue[]): string {
  if (secrets.length === 0) return snapshot;

  const byName = new Map<string, string>();
  for (const secret of secrets) {
    if (secret.name) byName.set(secret.name, `{{secret:${secret.field}}}`);
  }

  const valueLine = /^(\s*-\s.*?\[ref=[^\]]+\]\s*:\s*)(.+)$/;
  const namedNode = /"((?:[^"\\]|\\.)*)"/;

  let result = snapshot
    .split('\n')
    .map((line) => {
      const parts = valueLine.exec(line);
      if (!parts) return line;
      const head = parts[1] ?? '';
      const nameMatch = namedNode.exec(head);
      const nodeName = nameMatch?.[1];
      if (nodeName === undefined) return line;
      const placeholder = byName.get(nodeName.replace(/\\(.)/g, '$1'));
      return placeholder === undefined ? line : `${head}${placeholder}`;
    })
    .join('\n');

  for (const secret of secrets) {
    if (!secret.value) continue;
    const placeholder = `{{secret:${secret.field}}}`;
    const normalized = secret.value.replace(/\s+/g, ' ').trim();
    const yamlEscaped = secret.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const normalizedYaml = normalized.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    for (const variant of [secret.value, normalized, yamlEscaped, normalizedYaml]) {
      if (!variant) continue;
      result = result.split(variant).join(placeholder);
    }
  }
  return result;
}

export interface McpOptions {
  config?: ResolvedConfig;
  profile?: string;
  headless?: boolean;
}

export interface WebpilotMcp {
  server: McpServer;
  close(): Promise<void>;
}

export function createMcpServer(options: McpOptions = {}): WebpilotMcp {
  const config = options.config ?? loadConfig();
  const defaultProfile = options.profile ?? 'default';

  let session: Session | null = null;

  /**
   * Snapshot-Referenzen sind NUR innerhalb eines Dokuments stabil. Bei einem
   * neuen Dokument beginnt Playwright die Nummerierung wieder bei e1 - ein
   * altes e11 zeigt danach nicht ins Leere, sondern moeglicherweise auf ein
   * ganz anderes Element.
   *
   * Erkannt wird das ueber eine Markierung IM Dokument, nicht ueber einen
   * Navigationszaehler: framenavigated feuert auch bei pushState, replaceState
   * und Hash-Wechseln. Dabei bleibt das Dokument dasselbe und die Referenzen
   * gueltig - eine SPA, die die URL periodisch umschreibt, wuerde sonst jeden
   * Snapshot sofort entwerten.
   */
  const documentToken = async (page: Page): Promise<string> =>
    page.evaluate(() => {
      const w = window as unknown as { __webpilotDoc?: string };
      if (!w.__webpilotDoc) w.__webpilotDoc = Math.random().toString(36).slice(2);
      return w.__webpilotDoc;
    });

  let lastSnapshot: { page: Page; token: string } | null = null;

  const requireSession = (): Session => {
    if (!session) {
      throw new Error('Es ist kein Browser offen. Zuerst browser_open aufrufen.');
    }
    return session;
  };

  const openSession = async (profile: string): Promise<Session> => {
    if (session && session.profile !== profile) {
      if (session.recorder.isRecording()) {
        throw new Error(
          `Profilwechsel nach "${profile}" nicht moeglich: es laeuft eine Aufnahme ` +
            `("${session.recorder.currentName()}"). Erst record_stop aufrufen.`,
        );
      }
      log.info(`Profilwechsel ${session.profile} -> ${profile}, Browser wird neu gestartet.`);
      await session.close();
      session = null;
    }
    if (!session) {
      const created = await createSession({
        profile,
        config,
        ...(options.headless === undefined ? {} : { headless: options.headless }),
      });
      created.context.on('close', () => {
        if (session === created) session = null;
      });
      session = created;
    }
    return session;
  };

  const resolveRef = async (page: Page, ref: string) => {
    if (!REF_PATTERN.test(ref)) {
      throw new Error(
        `"${ref}" ist keine gueltige Referenz. Refs stammen aus browser_snapshot und sehen aus wie e12 oder f1e3.`,
      );
    }
    if (!lastSnapshot) {
      throw new Error('Es gibt noch keinen Snapshot. Zuerst browser_snapshot aufrufen.');
    }
    const token = await documentToken(page).catch(() => '');
    if (lastSnapshot.page !== page || token !== lastSnapshot.token) {
      throw new Error(
        `Die Seite hat seit dem letzten browser_snapshot ein neues Dokument geladen. Referenzen werden ` +
          `pro Dokument neu vergeben, "${ref}" wuerde jetzt auf ein anderes Element zeigen - bitte ` +
          `browser_snapshot erneut aufrufen und mit den neuen Referenzen arbeiten.`,
      );
    }
    return page.locator(`aria-ref=${ref}`);
  };

  const withRefError = async <T>(ref: string, action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/aria-ref|Timeout|strict mode|Invalid frame|InvalidSelector/i.test(message)) {
        throw new Error(
          `Referenz "${ref}" liess sich nicht aufloesen. Refs gelten nur fuer den zuletzt ` +
            `erstellten Snapshot und werden durch Navigation ungueltig - bitte browser_snapshot ` +
            `erneut aufrufen.\nUrsprungsfehler: ${message.split('\n')[0]}`,
        );
      }
      throw err;
    }
  };

  const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });

  /**
   * Tool-Aufrufe werden vom SDK NICHT serialisiert - zwei Aufrufe koennen sich
   * ueberlappen. Auf einer geteilten Seite ist das schaedlich: ein
   * browser_click, der navigiert, entwertet genau die Referenzen, die ein
   * parallel laufender browser_snapshot gerade herausgibt. Alles, was den
   * Browser anfasst, laeuft deshalb durch diese Schlange.
   */
  let lock: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(task: () => Promise<T>): Promise<T> => {
    const run = lock.then(task, task);
    lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const server = new McpServer({ name: 'webpilot', version: '0.1.0' }, { capabilities: { tools: {} } });

  /* ---------------- Browser ---------------- */

  server.registerTool(
    'browser_open',
    {
      title: 'Browser oeffnen',
      description:
        'Startet den sichtbaren Browser mit dem persistenten Profil und navigiert optional zu einer URL. ' +
        'Die URL muss in der Domain-Allowlist aus config.json stehen.',
      inputSchema: {
        profile: z.string().optional().describe('Profilname unter profiles/, Default: Serverstart-Profil'),
        url: z.string().optional().describe('Startseite, muss in der Allowlist stehen'),
      },
    },
    async ({ profile, url }) => {
      const target = profile ?? defaultProfile;
      // Erst pruefen, dann schliessen: ein Tippfehler im Profilnamen darf nicht
      // die laufende Sitzung samt manuell durchgefuehrtem Login kosten.
      profileDirFor(config, target);
      if (url !== undefined && !isAllowedUrl(url, config.allowedDomains)) {
        throw new Error(
          `Navigation nach ${url} abgelehnt: Domain steht nicht in der Allowlist ` +
            `(erlaubt: ${config.allowedDomains.join(', ')}).`,
        );
      }
      return exclusive(async () => {
        const opened = await openSession(target);
        if (url !== undefined) await opened.goto(url);
        return text(
          `Browser offen (Profil "${opened.profile}", ${opened.profileDir}).\nAktuelle URL: ${opened.page().url()}`,
        );
      });
    },
  );

  server.registerTool(
    'browser_snapshot',
    {
      title: 'ARIA-Snapshot',
      description:
        'Liefert einen ARIA-Snapshot der aktuellen Seite mit Referenzen ([ref=e12]). ' +
        'Diese Referenzen sind die Eingabe fuer browser_click und browser_type. Sie gelten genau ' +
        'fuer diesen Snapshot: nach jeder Navigation vergibt der Browser neue Nummern, deshalb ' +
        'danach erneut aufrufen.',
      inputSchema: {},
    },
    async () =>
      exclusive(async () => {
        const page = requireSession().page();
        const withAi = page as PageWithSnapshotForAI;
        if (typeof withAi._snapshotForAI !== 'function') {
          throw new Error(
            'Diese Playwright-Version liefert keinen Snapshot mit Referenzen ' +
              '(page._snapshotForAI fehlt). Erwartet wird Playwright 1.56.',
          );
        }
        const snapshot = await withAi._snapshotForAI();
        // Der Snapshot enthaelt Feldwerte im Klartext, auch die von
        // Passwortfeldern. Vor der Rueckgabe schwaerzen.
        const secrets = await collectSecretValues(page);
        const safe = redactSecrets(snapshot, secrets);
        if (secrets.length > 0) log.info(`${secrets.length} Passwortwert(e) im Snapshot geschwaerzt.`);
        lastSnapshot = { page, token: await documentToken(page) };
        return text(`URL: ${page.url()}\nTitel: ${await page.title()}\n\n${safe}`);
      }),
  );

  server.registerTool(
    'browser_click',
    {
      title: 'Element anklicken',
      description: 'Klickt das Element mit der angegebenen Referenz aus dem letzten browser_snapshot.',
      inputSchema: { ref: z.string().min(1).describe('Referenz aus browser_snapshot, z. B. e12 oder f1e3') },
    },
    async ({ ref }) =>
      exclusive(async () => {
        const page = requireSession().page();
        await withRefError(ref, async () => {
          await (await resolveRef(page, ref)).click();
        });
        return text(`Geklickt: ${ref}\nAktuelle URL: ${page.url()}`);
      }),
  );

  server.registerTool(
    'browser_type',
    {
      title: 'Text eingeben',
      description: 'Schreibt Text in das Element mit der angegebenen Referenz aus dem letzten browser_snapshot.',
      inputSchema: {
        ref: z.string().min(1).describe('Referenz aus browser_snapshot'),
        text: z.string().describe('Der einzugebende Text'),
      },
    },
    async ({ ref, text: value }) =>
      exclusive(async () => {
        const page = requireSession().page();
        let mode = 'fill';
        await withRefError(ref, async () => {
          const locator = await resolveRef(page, ref);
          try {
            // fill() setzt den Wert in einem Rutsch - richtig fuer Formularfelder.
            await locator.fill(value);
          } catch (err) {
            // Nicht jedes Ziel ist fuellbar (eigene Widgets, contenteditable-
            // Konstrukte). Dann echt tippen: das feuert Taste fuer Taste und
            // laesst Typeahead und Validierung der Seite laufen.
            log.warn(`fill() auf ${ref} fehlgeschlagen (${(err as Error).message.split('\n')[0]}), tippe stattdessen.`);
            await locator.click();
            await locator.pressSequentially(value);
            mode = 'pressSequentially';
          }
        });
        return text(`Eingegeben in ${ref} (${value.length} Zeichen, ${mode}).`);
      }),
  );

  server.registerTool(
    'browser_screenshot',
    {
      title: 'Screenshot',
      description: 'Erstellt einen PNG-Screenshot des sichtbaren Bereichs und liefert ihn als Bild zurueck.',
      inputSchema: {},
    },
    async () =>
      exclusive(async () => {
        const page = requireSession().page();
        const buffer = await page.screenshot({ type: 'png' });
        if (buffer.length > MAX_SCREENSHOT_BYTES) {
          // Ein ganzseitiger PNG einer echten Seite kann mehrere Megabyte gross
          // sein; base64-codiert sprengt das jedes Kontextfenster. Dann lieber
          // auf die Platte und nur den Pfad melden.
          mkdirSync(config.screenshotsDirAbs, { recursive: true });
          const file = join(config.screenshotsDirAbs, `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
          writeFileSync(file, buffer);
          return text(
            `Screenshot von ${page.url()} ist mit ${buffer.length} Bytes zu gross fuer eine Antwort ` +
              `(Grenze ${MAX_SCREENSHOT_BYTES}). Datei: ${file}`,
          );
        }
        return {
          content: [
            { type: 'text' as const, text: `Screenshot von ${page.url()} (${buffer.length} Bytes).` },
            { type: 'image' as const, data: buffer.toString('base64'), mimeType: 'image/png' },
          ],
        };
      }),
  );

  /* ---------------- Recorder ---------------- */

  server.registerTool(
    'record_start',
    {
      title: 'Aufnahme starten',
      description:
        'Beginnt die Aufzeichnung in flows/<name>.jsonl. Eine vorhandene Datei wird ueberschrieben.',
      inputSchema: {
        name: z
          .string()
          .min(1)
          .refine(isValidFlowName, 'Nur Buchstaben, Ziffern, Punkt, Minus und Unterstrich erlaubt')
          .describe('Name des Flows ohne Endung'),
      },
    },
    async ({ name }) => {
      const active = requireSession();
      await active.recorder.start(name);
      return text(`Aufnahme "${name}" laeuft. Jetzt im Browser die Schritte ausfuehren, dann record_stop.`);
    },
  );

  server.registerTool(
    'record_stop',
    {
      title: 'Aufnahme beenden',
      description: 'Beendet die laufende Aufzeichnung und schreibt das JSONL zu Ende.',
      inputSchema: {},
    },
    async () => {
      const active = requireSession();
      const result = await active.recorder.stop();
      return text(`Aufnahme "${result.name}" beendet: ${result.events} Ereignisse in ${result.path}`);
    },
  );

  /* ---------------- Flows ---------------- */

  server.registerTool(
    'flow_list',
    {
      title: 'Flows auflisten',
      description: 'Listet alle aufgezeichneten Flows aus dem flows-Verzeichnis mit Anzahl Ereignissen.',
      inputSchema: {},
    },
    async () => {
      let files: string[];
      try {
        files = readdirSync(config.flowsDirAbs).filter((f) => f.endsWith('.jsonl'));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return text(`Keine Flows vorhanden (${config.flowsDirAbs} existiert noch nicht).`);
        }
        throw err;
      }
      if (files.length === 0) return text(`Keine Flows in ${config.flowsDirAbs}.`);
      const rows = files.sort().map((file) => {
        const name = file.slice(0, -'.jsonl'.length);
        let events = 0;
        try {
          events = readFileSync(join(config.flowsDirAbs, file), 'utf8')
            .split('\n')
            .filter((line) => line.trim() !== '').length;
        } catch {
          events = -1;
        }
        return `- ${name} (${events >= 0 ? `${events} Ereignisse` : 'nicht lesbar'})`;
      });
      return text(`Flows in ${config.flowsDirAbs}:\n${rows.join('\n')}`);
    },
  );

  server.registerTool(
    'flow_run',
    {
      title: 'Flow abspielen',
      description:
        'Spielt einen aufgezeichneten Flow ab. {{secret:<feld>}} wird aus WEBPILOT_SECRET_<FELD> aufgeloest. ' +
        'Ist noch kein Browser offen, wird er mit dem Standardprofil gestartet.',
      inputSchema: {
        name: z
          .string()
          .min(1)
          .refine(isValidFlowName, 'Nur Buchstaben, Ziffern, Punkt, Minus und Unterstrich erlaubt')
          .describe('Name des Flows ohne Endung'),
      },
    },
    async ({ name }) =>
      exclusive(async () => {
      const active = session ?? (await openSession(defaultProfile));
      const result = await replayFlow(active, config, name);
      const lines = result.steps.map((step) => `  #${step.index} ${step.kind}: ${step.status} - ${step.detail}`);
      return text(
        `Flow "${result.flow}": ${result.executed} ausgefuehrt, ${result.skipped} uebersprungen.\n` +
          `Endstand: ${result.finalUrl}\n` +
          (result.expectedFinalUrl && result.expectedFinalUrl !== result.finalUrl
            ? `Hinweis: aufgezeichnet endete der Flow auf ${result.expectedFinalUrl}.\n`
            : '') +
          lines.join('\n'),
      );
      }),
  );

  /* ---------------- Logs ---------------- */

  server.registerTool(
    'log_tail',
    {
      title: 'Log-Ende',
      description:
        'Liefert die letzten n Zeilen des webpilot-Logs (dasselbe, was auf stderr laeuft). ' +
        'Der Puffer gehoert diesem Serverprozess: Zeilen aus einem separaten `webpilot record`-Lauf ' +
        'sind hier nicht sichtbar.',
      inputSchema: { n: z.number().int().min(1).max(1000).default(50).describe('Anzahl Zeilen, 1 bis 1000') },
    },
    async ({ n }) => {
      const entries = logTail(n);
      if (entries.length === 0) return text('Das Log ist leer.');
      return text(entries.map(formatEntry).join('\n'));
    },
  );

  return {
    server,
    async close() {
      if (session) {
        try {
          if (session.recorder.isRecording()) await session.recorder.stop();
        } catch (err) {
          log.warn(`Aufnahme konnte nicht sauber beendet werden: ${(err as Error).message}`);
        }
        await session.close();
        session = null;
      }
      await server.close();
    },
  };
}

export async function runMcpServer(options: McpOptions = {}): Promise<void> {
  const webpilot = createMcpServer(options);
  const transport = new StdioServerTransport();

  await new Promise<void>((resolve, reject) => {
    // Wiedereintritt sperren: close() schliesst den Transport, der ruft
    // onclose - ohne diese Sperre ruft sich der Shutdown selbst auf, bis der
    // Stack voll ist (RangeError statt sauberem Ende).
    let closing = false;
    const shutdown = (): void => {
      if (closing) return;
      closing = true;
      webpilot
        .close()
        .catch((err: unknown) => log.warn(`Fehler beim Herunterfahren: ${(err as Error).message}`))
        .finally(resolve);
    };

    transport.onclose = shutdown;
    transport.onerror = (err) => log.warn(`Transportfehler: ${err.message}`);
    // Verschwindet der Host ohne Signal (Absturz, gekappte Pipe), bleibt sonst
    // ein sichtbares Browserfenster stehen und der Prozess laeuft ewig weiter.
    process.stdin.once('end', shutdown);
    process.stdin.once('close', shutdown);
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);

    webpilot.server.connect(transport).then(
      () => log.info('MCP-Server laeuft ueber stdio.'),
      (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))),
    );
  });
}
