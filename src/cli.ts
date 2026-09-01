#!/usr/bin/env node
/**
 * webpilot CLI: open, record, replay, mcp.
 *
 * Alle Ausgaben gehen auf stderr, ausser bei Kommandos, deren Ergebnis
 * weiterverarbeitet wird. `mcp` schreibt ueberhaupt nichts auf stdout ausser
 * dem JSON-RPC-Protokoll.
 */
import { createSession } from './browser.js';
import { loadConfig } from './config.js';
import { configureLog, createLogger } from './log.js';

const log = createLogger('cli');

interface Args {
  command: string | undefined;
  positional: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === undefined) continue;
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq !== -1) {
        flags.set(token.slice(2, eq), token.slice(eq + 1));
      } else {
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags.set(token.slice(2), next);
          i++;
        } else {
          flags.set(token.slice(2), true);
        }
      }
    } else {
      positional.push(token);
    }
  }
  return { command, positional, flags };
}

function str(args: Args, name: string): string | undefined {
  const v = args.flags.get(name);
  return typeof v === 'string' ? v : undefined;
}

function bool(args: Args, name: string): boolean {
  return args.flags.get(name) === true || args.flags.get(name) === 'true';
}

const USAGE = `webpilot - steuerbarer Browser mit Aktions-Recorder und MCP-Anbindung

  webpilot open   --profile <name> [--url <url>] [--headless]
  webpilot record <name> --profile <name> [--url <url>] [--headless]
  webpilot replay <name> --profile <name> [--headless] [--timeout <ms>]
  webpilot mcp    [--profile <name>]

Optionen:
  --profile <name>   Profilverzeichnis unter profiles/ (Default: default)
  --url <url>        Startseite; muss in der Allowlist von config.json stehen
  --headless         Browser unsichtbar starten (sonst sichtbar)
  --config <pfad>    Alternative config.json
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(str(args, 'config'));
  configureLog({ capacity: config.logBufferSize });

  const profile = str(args, 'profile') ?? 'default';
  const headless = bool(args, 'headless') ? true : undefined;

  switch (args.command) {
    case 'open': {
      const session = await createSession({
        profile,
        config,
        ...(headless === undefined ? {} : { headless }),
      });
      const url = str(args, 'url');
      if (url) await session.goto(url);
      log.info('Browser laeuft. Zum Beenden das Fenster schliessen oder Strg+C druecken.');
      const onSigint = () => {
        void session.close();
      };
      process.once('SIGINT', onSigint);
      await session.closed();
      process.off('SIGINT', onSigint);
      return 0;
    }
    case 'record':
    case 'replay':
    case 'mcp':
      process.stderr.write(`Kommando "${args.command}" ist noch nicht implementiert.\n`);
      return 2;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stderr.write(USAGE);
      return args.command === undefined ? 1 : 0;
    default:
      process.stderr.write(`Unbekanntes Kommando "${args.command}".\n\n${USAGE}`);
      return 1;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Fehler: ${message}\n`);
    if (process.env['WEBPILOT_LOG_LEVEL'] === 'debug' && err instanceof Error && err.stack) {
      process.stderr.write(`${err.stack}\n`);
    }
    process.exitCode = 1;
  },
);
