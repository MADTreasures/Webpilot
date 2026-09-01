/**
 * Flow-Interpreter.
 *
 * Kernentscheidungen:
 *  - Selektoren werden ueber Playwright-Locators aufgeloest, also mit Auto-Wait.
 *    Erst wenn der Primaerselektor scheitert, kommen die beiden Fallbacks dran.
 *    Aufgeloest wird VOR der Aktion; dadurch kann ein Fallback-Versuch keine
 *    bereits ausgefuehrte Aktion wiederholen.
 *  - Nur die ERSTE Navigation wird aktiv als goto ausgefuehrt. Spaetere
 *    Navigationen sind Folgen einer Aktion; wuerde man sie erneut anstossen,
 *    zerlegt das POST-basierte Logins.
 *  - Ereignisse mit `causedBy` sind Folgen (der vom Browser erzeugte Klick auf
 *    den Default-Button, das dadurch ausgeloeste submit) und werden uebersprungen.
 *  - Frames werden ueber die aufgezeichnete Kette der iframe-Elemente auf-
 *    geloest, nicht ueber die Frame-URL: iframes mit wechselnder Nonce in der
 *    URL sind sonst nicht wiederzufinden.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FrameLocator, Locator, Page } from 'playwright';
import type { ResolvedConfig } from './config.js';
import { createLogger } from './log.js';
import { FlowEventSchema, flowPath, type FlowEvent, type FrameRef } from './recorder.js';
import { describeSelector, selectorChain, toLocator, type SelectorSet, type SelectorSpec } from './selector.js';

const log = createLogger('replay');

export const SECRET_PATTERN = /\{\{secret:([^}]+)\}\}/g;

export interface ReplayOptions {
  /** Zeitbudget fuer den Primaerselektor je Aktion. */
  timeout?: number;
  /** Zeitbudget je Fallback-Selektor. */
  fallbackTimeout?: number;
  env?: NodeJS.ProcessEnv;
  screenshotsDir?: string;
}

export interface ReplayStep {
  index: number;
  kind: FlowEvent['kind'];
  status: 'ausgefuehrt' | 'uebersprungen';
  detail: string;
}

export interface ReplayResult {
  flow: string;
  total: number;
  executed: number;
  skipped: number;
  finalUrl: string;
  expectedFinalUrl: string | null;
  steps: ReplayStep[];
}

export class ReplayError extends Error {
  constructor(
    message: string,
    readonly event: FlowEvent,
    readonly screenshot: string | null,
    readonly attempts: string[],
  ) {
    super(message);
    this.name = 'ReplayError';
  }
}

/* ------------------------------------------------------------------ *
 * Flow lesen
 * ------------------------------------------------------------------ */

export function parseFlow(text: string, source: string): FlowEvent[] {
  const events: FlowEvent[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      throw new Error(`${source}:${i + 1}: keine gueltige JSON-Zeile (${(err as Error).message})`);
    }
    const parsed = FlowEventSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `${source}:${i + 1}: unbekanntes Ereignis - ` +
          parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      );
    }
    events.push(parsed.data);
  }
  return events;
}

export function readFlow(config: ResolvedConfig, name: string): FlowEvent[] {
  const path = flowPath(config, name);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Flow "${name}" nicht gefunden (${path}). Verfuegbare Flows zeigt flow_list.`);
    }
    throw err;
  }
  return parseFlow(text, path);
}

/* ------------------------------------------------------------------ *
 * Secrets
 * ------------------------------------------------------------------ */

/** {{secret:passwort}} -> WEBPILOT_SECRET_PASSWORT (oder PASSWORT). */
export function secretEnvNames(fieldName: string): string[] {
  const normalized = fieldName
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return [`WEBPILOT_SECRET_${normalized}`, normalized];
}

/**
 * Ersetzt alle {{secret:...}}-Platzhalter durch Werte aus der Umgebung.
 * Fehlt einer, bricht der Replay ab - der Platzhalter darf nie als Text in
 * ein Formular getippt werden.
 */
export function resolveSecrets(value: string, env: NodeJS.ProcessEnv): string {
  const missing: string[] = [];
  const result = value.replace(SECRET_PATTERN, (_match, rawName: string) => {
    const names = secretEnvNames(rawName);
    for (const name of names) {
      const found = env[name];
      if (found !== undefined && found !== '') return found;
    }
    missing.push(rawName);
    return '';
  });
  if (missing.length > 0) {
    const details = missing
      .map((field) => `{{secret:${field}}} erwartet ${secretEnvNames(field).join(' oder ')}`)
      .join('; ');
    const example = secretEnvNames(missing[0] ?? 'feld')[0];
    throw new Error(
      `Secret fehlt in der Umgebung: ${details}. Vor dem Replay setzen, z. B. export ${example}=...`,
    );
  }
  return result;
}

/** Nur zur Anzeige: Secrets werden in Logs nie aufgeloest. */
export function maskForLog(value: string): string {
  return value.replace(SECRET_PATTERN, '{{secret:$1}}').replace(/^(.{40}).+$/, '$1...');
}

/* ------------------------------------------------------------------ *
 * Selektor-Aufloesung
 * ------------------------------------------------------------------ */

export type Scope = Page | FrameLocator;

interface Resolution {
  locator: Locator;
  spec: SelectorSpec;
  attempts: string[];
}

async function probe(
  scope: Scope,
  spec: SelectorSpec,
  timeout: number,
): Promise<{ locator: Locator; count: number } | { error: string }> {
  const locator = toLocator(scope, spec);
  try {
    await locator.first().waitFor({ state: 'attached', timeout });
  } catch (err) {
    return { error: `${describeSelector(spec)}: ${firstLine(err)}` };
  }
  try {
    const count = await locator.count();
    if (count !== 1) {
      return { error: `${describeSelector(spec)}: ${count} Treffer, erwartet genau einen` };
    }
    return { locator, count };
  } catch (err) {
    return { error: `${describeSelector(spec)}: ${firstLine(err)}` };
  }
}

/**
 * Primaerselektor mit vollem Zeitbudget (das ist der Auto-Wait), danach die
 * Fallbacks mit kurzem Budget - zu diesem Zeitpunkt ist die Seite ohnehin da.
 */
export async function resolveSelector(
  scope: Scope,
  set: SelectorSet,
  timeout: number,
  fallbackTimeout: number,
): Promise<Resolution> {
  const chain = selectorChain(set);
  const attempts: string[] = [];
  for (let i = 0; i < chain.length; i++) {
    const spec = chain[i];
    if (!spec) continue;
    const budget = i === 0 ? timeout : fallbackTimeout;
    const result = await probe(scope, spec, budget);
    if ('error' in result) {
      attempts.push(result.error);
      continue;
    }
    if (i > 0) log.warn(`Primaerselektor scheiterte, Fallback ${i} greift: ${describeSelector(spec)}`);
    return { locator: result.locator, spec, attempts };
  }
  const error = new Error(
    `Kein Selektor hat gegriffen:\n  ${attempts.join('\n  ')}`,
  ) as Error & { attempts: string[] };
  error.attempts = attempts;
  throw error;
}

/** Frame ueber die aufgezeichnete iframe-Kette aufloesen. */
export async function resolveScope(
  page: Page,
  frame: FrameRef,
  timeout: number,
  fallbackTimeout: number,
): Promise<Scope> {
  let scope: Scope = page;
  for (let depth = 0; depth < frame.path.length; depth++) {
    const step = frame.path[depth];
    if (!step) continue;
    try {
      const resolved = await resolveSelector(scope, step, timeout, fallbackTimeout);
      scope = resolved.locator.contentFrame();
    } catch (err) {
      throw new Error(
        `iframe auf Ebene ${depth + 1} nicht gefunden (aufgezeichnete Frame-URL: ${frame.url || '?'}).\n` +
          `${(err as Error).message}`,
      );
    }
  }
  return scope;
}

/* ------------------------------------------------------------------ *
 * Interpreter
 * ------------------------------------------------------------------ */

export interface ReplayTarget {
  page(): Page;
  goto(url: string, options?: { timeout?: number }): Promise<void>;
}

function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split('\n')[0] ?? message;
}

function screenshotName(flow: string, event: FlowEvent): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${flow}-${String(event.index).padStart(3, '0')}-${event.kind}-${stamp}.png`;
}

export async function replayFlow(
  target: ReplayTarget,
  config: ResolvedConfig,
  name: string,
  options: ReplayOptions = {},
): Promise<ReplayResult> {
  const events = readFlow(config, name);
  const timeout = options.timeout ?? 10_000;
  const fallbackTimeout = options.fallbackTimeout ?? 3_000;
  const env = options.env ?? process.env;
  const screenshotsDir = options.screenshotsDir ?? config.screenshotsDirAbs;

  const steps: ReplayStep[] = [];
  let executed = 0;
  let skipped = 0;
  let firstNavigationDone = false;

  const navigations = events.filter((e) => e.kind === 'navigate');
  const expectedFinalUrl = navigations.length > 0 ? (navigations[navigations.length - 1]?.url ?? null) : null;

  const skip = (event: FlowEvent, detail: string): void => {
    skipped++;
    steps.push({ index: event.index, kind: event.kind, status: 'uebersprungen', detail });
    log.debug(`#${event.index} ${event.kind} uebersprungen: ${detail}`);
  };

  const done = (event: FlowEvent, detail: string): void => {
    executed++;
    steps.push({ index: event.index, kind: event.kind, status: 'ausgefuehrt', detail });
    log.info(`#${event.index} ${event.kind}: ${detail}`);
  };

  log.info(`Replay "${name}" mit ${events.length} Ereignissen`);

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (!event) continue;
    try {
      if (event.kind === 'navigate') {
        if (firstNavigationDone) {
          // Spaetere Navigationen sind Folgen der vorherigen Aktion.
          skip(event, `Folge-Navigation nach ${event.url}`);
          continue;
        }
        firstNavigationDone = true;
        await target.goto(event.url, { timeout });
        done(event, `goto ${event.url}`);
        continue;
      }

      // Nur click und submit tragen eine Ursache; beide sind dann Folgen.
      const caused = event.kind === 'click' || event.kind === 'submit' ? event : null;
      if (caused && caused.causedBy !== null) {
        skip(event, `Folge von ${caused.causedBy} (${caused.causeKind ?? 'unbekannt'})`);
        continue;
      }

      const page = target.page();
      const scope = await resolveScope(page, event.frame, timeout, fallbackTimeout);

      if (event.kind === 'submit') {
        // Ein submit ohne erkennbare Ursache war ein Seitenskript-Aufruf.
        // requestSubmit() bildet genau das nach - inklusive Validierung.
        const resolved = await resolveSelector(scope, event.target.selectors, timeout, fallbackTimeout);
        await resolved.locator.evaluate((form) => {
          (form as HTMLFormElement).requestSubmit();
        });
        done(event, `requestSubmit auf ${describeSelector(resolved.spec)}`);
      } else {
        const resolved = await resolveSelector(scope, event.target.selectors, timeout, fallbackTimeout);
        switch (event.kind) {
          case 'click':
            await resolved.locator.click({ timeout });
            done(event, `click auf ${describeSelector(resolved.spec)}`);
            break;
          case 'fill': {
            const value = resolveSecrets(event.value, env);
            await resolved.locator.fill(value, { timeout });
            done(event, `fill ${describeSelector(resolved.spec)} = ${maskForLog(event.value)}`);
            break;
          }
          case 'select':
            await resolved.locator.selectOption(event.values, { timeout });
            done(event, `selectOption ${JSON.stringify(event.values)}`);
            break;
          case 'press':
            await resolved.locator.press(event.key, { timeout });
            done(event, `press ${event.key} auf ${describeSelector(resolved.spec)}`);
            break;
        }
      }

      // Wenn im Mitschnitt direkt danach eine Navigation kam, hier auf das
      // Laden warten. Sonst laeuft der naechste Selektor gegen die alte Seite.
      const next = events[i + 1];
      if (next && next.kind === 'navigate') {
        await target
          .page()
          .waitForLoadState('domcontentloaded', { timeout })
          .catch(() => undefined);
      }
    } catch (err) {
      const attempts = (err as { attempts?: string[] }).attempts ?? [];
      let screenshot: string | null = null;
      try {
        mkdirSync(screenshotsDir, { recursive: true });
        screenshot = join(screenshotsDir, screenshotName(name, event));
        await target.page().screenshot({ path: screenshot, fullPage: true });
      } catch (shotErr) {
        log.warn(`Screenshot fehlgeschlagen: ${(shotErr as Error).message}`);
        screenshot = null;
      }
      const currentUrl = (() => {
        try {
          return target.page().url();
        } catch {
          return '?';
        }
      })();
      const message =
        `Replay "${name}" abgebrochen bei Ereignis #${event.index} (${event.kind}).\n` +
        `  Grund:            ${(err as Error).message}\n` +
        (attempts.length > 0 ? `  Versuchte Selektoren:\n    ${attempts.join('\n    ')}\n` : '') +
        `  Aufgezeichnete URL: ${event.url}\n` +
        `  Aktuelle URL:       ${currentUrl}\n` +
        (screenshot ? `  Screenshot:         ${screenshot}\n` : '  Screenshot:         nicht moeglich\n');
      log.error(message);
      throw new ReplayError(message, event, screenshot, attempts);
    }
  }

  const finalUrl = (() => {
    try {
      return target.page().url();
    } catch {
      return '';
    }
  })();
  if (expectedFinalUrl && finalUrl !== expectedFinalUrl) {
    log.warn(`Endzustand weicht ab: erwartet ${expectedFinalUrl}, tatsaechlich ${finalUrl}`);
  }
  log.info(`Replay "${name}" fertig: ${executed} ausgefuehrt, ${skipped} uebersprungen`);
  return { flow: name, total: events.length, executed, skipped, finalUrl, expectedFinalUrl, steps };
}
