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
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Page } from 'playwright';
import { z } from 'zod';
import { createSession, type Session } from './browser.js';
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

  const resolveRef = (page: Page, ref: string) => {
    if (!REF_PATTERN.test(ref)) {
      throw new Error(
        `"${ref}" ist keine gueltige Referenz. Refs stammen aus browser_snapshot und sehen aus wie e12 oder f1e3.`,
      );
    }
    return page.locator(`aria-ref=${ref}`);
  };

  const withRefError = async <T>(ref: string, action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/aria-ref|Timeout|strict mode/i.test(message)) {
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
      if (url !== undefined && !isAllowedUrl(url, config.allowedDomains)) {
        throw new Error(
          `Navigation nach ${url} abgelehnt: Domain steht nicht in der Allowlist ` +
            `(erlaubt: ${config.allowedDomains.join(', ')}).`,
        );
      }
      const opened = await openSession(target);
      if (url !== undefined) await opened.goto(url);
      return text(
        `Browser offen (Profil "${opened.profile}", ${opened.profileDir}).\nAktuelle URL: ${opened.page().url()}`,
      );
    },
  );

  server.registerTool(
    'browser_snapshot',
    {
      title: 'ARIA-Snapshot',
      description:
        'Liefert einen ARIA-Snapshot der aktuellen Seite mit stabilen Referenzen ([ref=e12]). ' +
        'Diese Referenzen sind die Eingabe fuer browser_click und browser_type und werden durch ' +
        'Navigation ungueltig.',
      inputSchema: {},
    },
    async () => {
      const page = requireSession().page();
      const withAi = page as PageWithSnapshotForAI;
      if (typeof withAi._snapshotForAI !== 'function') {
        throw new Error(
          'Diese Playwright-Version liefert keinen Snapshot mit Referenzen ' +
            '(page._snapshotForAI fehlt). Erwartet wird Playwright 1.56.',
        );
      }
      const snapshot = await withAi._snapshotForAI();
      return text(`URL: ${page.url()}\nTitel: ${await page.title()}\n\n${snapshot}`);
    },
  );

  server.registerTool(
    'browser_click',
    {
      title: 'Element anklicken',
      description: 'Klickt das Element mit der angegebenen Referenz aus dem letzten browser_snapshot.',
      inputSchema: { ref: z.string().min(1).describe('Referenz aus browser_snapshot, z. B. e12 oder f1e3') },
    },
    async ({ ref }) => {
      const page = requireSession().page();
      await withRefError(ref, async () => {
        await resolveRef(page, ref).click();
      });
      return text(`Geklickt: ${ref}\nAktuelle URL: ${page.url()}`);
    },
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
    async ({ ref, text: value }) => {
      const page = requireSession().page();
      await withRefError(ref, async () => {
        await resolveRef(page, ref).fill(value);
      });
      return text(`Eingegeben in ${ref} (${value.length} Zeichen).`);
    },
  );

  server.registerTool(
    'browser_screenshot',
    {
      title: 'Screenshot',
      description: 'Erstellt einen PNG-Screenshot der aktuellen Seite und liefert ihn als Bild zurueck.',
      inputSchema: { fullPage: z.boolean().default(false).describe('Ganze Seite statt nur des sichtbaren Bereichs') },
    },
    async ({ fullPage }) => {
      const page = requireSession().page();
      const buffer = await page.screenshot({ fullPage, type: 'png' });
      return {
        content: [
          { type: 'text' as const, text: `Screenshot von ${page.url()} (${buffer.length} Bytes).` },
          { type: 'image' as const, data: buffer.toString('base64'), mimeType: 'image/png' },
        ],
      };
    },
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
    async ({ name }) => {
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
    },
  );

  /* ---------------- Logs ---------------- */

  server.registerTool(
    'log_tail',
    {
      title: 'Log-Ende',
      description: 'Liefert die letzten n Zeilen des webpilot-Logs (dasselbe, was auf stderr laeuft).',
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
  await webpilot.server.connect(transport);
  log.info('MCP-Server laeuft ueber stdio.');

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      void webpilot.close().finally(resolve);
    };
    transport.onclose = shutdown;
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}
