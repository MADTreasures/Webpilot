/**
 * Recorder.
 *
 * Aufbau:
 *  - Der IN-PAGE-Teil (Funktionen mit Praefix `wpr`) haengt sich in der
 *    Capture-Phase an document und meldet Ereignisse ueber das Binding
 *    window.__webpilotEmit nach Node. Er wird zusammen mit den
 *    Selektor-Funktionen aus selector.ts zu EINEM Quelltext zusammengesetzt
 *    und per addInitScript({content}) injiziert - dadurch gibt es keine
 *    Serialisierungs-Falle mit Closures oder Modulreferenzen. Zusaetzlich
 *    prueft assertSelfContained() den fertigen Quelltext.
 *  - Der NODE-Teil registriert Binding und Init-Script GENAU EINMAL beim
 *    Kontext-Setup. record_start/record_stop schalten nur die Senke um; sonst
 *    wuerde der zweite record_start an exposeBinding scheitern.
 *  - Navigationen kommen nicht aus der Seite, sondern aus page.on('framenavigated').
 */
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Frame, Page } from 'playwright';
import { z } from 'zod';
import type { ResolvedConfig } from './config.js';
import { createLogger } from './log.js';
import {
  ElementInfoSchema,
  SELECTOR_INPAGE_FUNCTIONS,
  SelectorSetSchema,
  wpDescribe,
} from './selector.js';

const log = createLogger('recorder');

export const BINDING_NAME = '__webpilotEmit';

/* ------------------------------------------------------------------ *
 * Flow-Format
 * ------------------------------------------------------------------ */

export const FrameRefSchema = z.object({
  /**
   * Kette der iframe-ELEMENTE vom Hauptframe bis zum Zielframe. Leer = Hauptframe.
   * Bewusst Element-Selektoren statt Frame-URLs: iframes mit wechselnder Nonce
   * in der URL sind sonst beim Replay nicht wiederzufinden.
   */
  path: z.array(SelectorSetSchema).default([]),
  /** Nur Diagnose. */
  url: z.string().default(''),
  name: z.string().default(''),
});
export type FrameRef = z.infer<typeof FrameRefSchema>;

const base = {
  index: z.number().int().nonnegative(),
  id: z.string().default(''),
  ts: z.string(),
  url: z.string().default(''),
  frame: FrameRefSchema.default({ path: [], url: '', name: '' }),
};

/**
 * Ein Ereignis mit `causedBy` ist die FOLGE eines frueheren Ereignisses: der
 * Browser hat es selbst ausgeloest. Beim Replay wird es uebersprungen, sonst
 * wird das Formular zweimal abgeschickt.
 *   submitter       - das submit-Event nennt den Button, dessen Klick wir kennen
 *   sequence        - unmittelbar davor Klick/Enter im selben Formular, nichts dazwischen
 *   implicit-submit - der Klick auf den Default-Button, den Enter selbst erzeugt
 */
export const CauseKindSchema = z.enum(['submitter', 'sequence', 'implicit-submit']);

const cause = {
  causedBy: z.string().nullable().default(null),
  causeKind: CauseKindSchema.nullable().default(null),
};

export const FlowEventSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('navigate') }),
  z.object({ ...base, ...cause, kind: z.literal('click'), target: ElementInfoSchema }),
  z.object({
    ...base,
    kind: z.literal('fill'),
    target: ElementInfoSchema,
    value: z.string(),
    /** true => `value` ist ein {{secret:...}}-Platzhalter, kein Klartext. */
    secret: z.boolean().default(false),
  }),
  z.object({ ...base, kind: z.literal('select'), target: ElementInfoSchema, values: z.array(z.string()) }),
  z.object({ ...base, kind: z.literal('press'), target: ElementInfoSchema, key: z.string() }),
  z.object({ ...base, ...cause, kind: z.literal('submit'), target: ElementInfoSchema }),
]);
export type FlowEvent = z.infer<typeof FlowEventSchema>;

/* ------------------------------------------------------------------ *
 * IN-PAGE-Teil
 * ------------------------------------------------------------------ */

/** Globaler Zustand pro Dokument. */
export function wprState(): Record<string, unknown> {
  const w = globalThis as unknown as Record<string, unknown>;
  let st = w['__webpilotState'] as Record<string, unknown> | undefined;
  if (!st) {
    st = {
      seq: 0,
      token: Math.random().toString(36).slice(2, 10),
      queue: [] as unknown[],
      timer: null as unknown,
      pending: null as unknown,
      activation: null as unknown,
      /** Letzter bereits gemeldeter Wert je Element - verhindert doppelte fills. */
      lastValues: new WeakMap<object, string>(),
      /** Gesetzt waehrend der Task, in der Enter verarbeitet wird. */
      enterPending: null as unknown,
      installed: false,
    };
    w['__webpilotState'] = st;
  }
  return st;
}

export function wprFlush(): void {
  const st = wprState();
  const w = globalThis as unknown as Record<string, unknown>;
  const sink = w['__webpilotEmit'];
  const queue = st['queue'] as unknown[];
  if (typeof sink !== 'function') {
    // Binding noch nicht da: puffern und gleich noch einmal versuchen.
    if (!st['timer']) {
      st['timer'] = setInterval(wprFlush, 50);
    }
    return;
  }
  if (st['timer']) {
    clearInterval(st['timer'] as ReturnType<typeof setInterval>);
    st['timer'] = null;
  }
  while (queue.length > 0) {
    const item = queue.shift();
    try {
      (sink as (v: unknown) => void)(item);
    } catch {
      // Kontext im Umbau (Navigation): das Ereignis ist verloren, nicht kritisch.
    }
  }
}

export function wprEmit(event: Record<string, unknown>): Record<string, unknown> {
  const st = wprState();
  const seq = (st['seq'] as number) + 1;
  st['seq'] = seq;
  event['seq'] = seq;
  event['id'] = String(st['token']) + ':' + String(seq);
  event['pageTs'] = Date.now();
  event['pageUrl'] = location.href;
  (st['queue'] as unknown[]).push(event);
  wprFlush();
  return event;
}

/** Text-artige Felder, deren Wert wir zusammenfassen. Checkbox & Co. nicht. */
export function wprIsFillable(el: unknown): boolean {
  const e = el as { localName?: string; getAttribute?: (n: string) => string | null; isContentEditable?: boolean };
  if (!e || !e.localName) return false;
  if (e.isContentEditable === true) return true;
  if (e.localName === 'textarea') return true;
  if (e.localName !== 'input') return false;
  const type = ((e.getAttribute ? e.getAttribute('type') : '') || 'text').toLowerCase();
  const notFillable = ['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'range', 'color'];
  return notFillable.indexOf(type) === -1;
}

export function wprValueOf(el: unknown): string {
  const e = el as { isContentEditable?: boolean; textContent?: string | null; value?: unknown };
  if (e.isContentEditable === true) return String(e.textContent ?? '');
  return String(e.value ?? '');
}

/**
 * Merkt sich den aktuellen Wert eines Feldes, ohne ihn zu senden.
 * Passwortfelder werden hier bereits maskiert - der Klartext verlaesst die
 * Seite nie, auch nicht in einem Zwischenpuffer.
 */
export function wprNotePending(el: unknown): void {
  const st = wprState();
  const describe = (globalThis as unknown as Record<string, unknown>)['__webpilotDescribe'] as
    | ((e: unknown) => Record<string, unknown>)
    | undefined;
  if (!describe) return;
  const info = describe(el);
  const isSecret = info['isPassword'] === true;
  const value = isSecret ? '{{secret:' + String(info['fieldName']) + '}}' : wprValueOf(el);
  // Schon gemeldeter Wert: nichts vormerken. Sonst erzeugt das change-Event,
  // das beim Absenden nachtraeglich feuert, eine zweite identische Zeile.
  const seen = st['lastValues'] as WeakMap<object, string>;
  if (seen.get(el as object) === value) {
    st['pending'] = null;
    return;
  }
  st['pending'] = { el: el, info: info, value: value, secret: isSecret };
}

/** Schreibt ein aufgestautes fill-Ereignis heraus. `only` begrenzt auf ein Element. */
export function wprFlushPending(only: unknown): void {
  const st = wprState();
  const pending = st['pending'] as { el: unknown; info: Record<string, unknown>; value: string; secret: boolean } | null;
  if (!pending) return;
  if (only !== null && only !== undefined && pending.el !== only) return;
  st['pending'] = null;
  (st['lastValues'] as WeakMap<object, string>).set(pending.el as object, pending.value);
  wprEmit({ kind: 'fill', target: pending.info, value: pending.value, secret: pending.secret });
}

/** Ist `el` ein Submit-Button von `form`? Genau den klickt der Browser bei Enter. */
export function wprIsSubmitButton(el: unknown, form: unknown): boolean {
  const e = el as { localName?: string; getAttribute?: (n: string) => string | null; form?: unknown };
  if (!e || !e.localName || !form) return false;
  if (e.form !== form) return false;
  const type = ((e.getAttribute ? e.getAttribute('type') : '') || '').toLowerCase();
  if (e.localName === 'button') return type === '' || type === 'submit';
  if (e.localName === 'input') return type === 'submit' || type === 'image';
  return false;
}

export function wprInstall(): void {
  const st = wprState();
  if (st['installed'] === true) return;
  st['installed'] = true;

  const w = globalThis as unknown as Record<string, unknown>;
  w['__webpilotDescribe'] = wpDescribe;

  const describe = (el: unknown): Record<string, unknown> => wpDescribe(el) as Record<string, unknown>;

  const realTarget = (event: Event): unknown => {
    const path = (event as unknown as { composedPath?: () => unknown[] }).composedPath;
    if (typeof path === 'function') {
      const list = path.call(event);
      if (list && list.length > 0) {
        const first = list[0] as { nodeType?: number };
        if (first && first.nodeType === 1) return first;
      }
    }
    return event.target;
  };

  const closestForm = (el: unknown): unknown => {
    const e = el as { closest?: (s: string) => unknown; form?: unknown };
    if (e && e.form) return e.form;
    if (e && typeof e.closest === 'function') return e.closest('form');
    return null;
  };

  document.addEventListener(
    'input',
    (event: Event) => {
      if (!event.isTrusted) return;
      const target = realTarget(event);
      if (!wprIsFillable(target)) return;
      wprNotePending(target);
    },
    true,
  );

  document.addEventListener(
    'change',
    (event: Event) => {
      if (!event.isTrusted) return;
      const target = realTarget(event) as { localName?: string; selectedOptions?: ArrayLike<{ value: string }> };
      if (target && target.localName === 'select') {
        const values: string[] = [];
        const options = target.selectedOptions;
        if (options) {
          for (let i = 0; i < options.length; i++) {
            const option = options[i];
            if (option) values.push(String(option.value));
          }
        }
        wprEmit({ kind: 'select', target: describe(target), values: values });
        return;
      }
      if (!wprIsFillable(target)) return;
      wprNotePending(target);
      wprFlushPending(target);
    },
    true,
  );

  document.addEventListener(
    'focusout',
    (event: Event) => {
      if (!event.isTrusted) return;
      wprFlushPending(realTarget(event));
    },
    true,
  );

  document.addEventListener(
    'click',
    (event: Event) => {
      // Nur echte Nutzerklicks. Filtert JS-synthetisierte Klicks und den
      // Label-auf-Input-Doppelklick weg.
      if (!event.isTrusted) return;
      const target = realTarget(event);
      // Erst den offenen Feldwert herausschreiben, dann den Klick: sonst steht
      // der Klick auf den Submit-Button vor der Eingabe.
      wprFlushPending(null);
      const st = wprState();
      const form = closestForm(target);
      // Enter loest die implizite Formularabsendung aus und der Browser klickt
      // dabei selbst auf den Default-Button. Dieser Klick ist eine Folge, keine
      // Nutzeraktion - er wird markiert und beim Replay uebersprungen.
      const enter = st['enterPending'] as { id: string; form: unknown } | null;
      const implicit = enter !== null && enter.form === form && wprIsSubmitButton(target, form);
      const info = describe(target);
      const emitted = wprEmit({
        kind: 'click',
        target: info,
        causedBy: implicit && enter ? enter.id : null,
        causeKind: implicit ? 'implicit-submit' : null,
      });
      st['activation'] = {
        id: emitted['id'],
        seq: emitted['seq'],
        ts: Date.now(),
        el: target,
        form: form,
        implicit: implicit,
      };
    },
    true,
  );

  document.addEventListener(
    'keydown',
    (event: Event) => {
      if (!event.isTrusted) return;
      const ke = event as KeyboardEvent;
      if (ke.key !== 'Enter') return;
      const target = realTarget(event);
      wprFlushPending(null);
      const emitted = wprEmit({ kind: 'press', target: describe(target), key: 'Enter' });
      const st = wprState();
      const form = closestForm(target);
      st['activation'] = { id: emitted['id'], seq: emitted['seq'], ts: Date.now(), el: target, form: form, implicit: false };
      // Nur fuer die Dauer dieser Task: der implizite Klick des Browsers kommt
      // synchron in der Default-Action des keydown. Kein Zeitfenster noetig.
      st['enterPending'] = { id: emitted['id'], form: form };
      setTimeout(() => {
        wprState()['enterPending'] = null;
      }, 0);
    },
    true,
  );

  document.addEventListener(
    'submit',
    (event: Event) => {
      // submit bewusst OHNE isTrusted-Filter: requestSubmit() aus Seitenskripten
      // erzeugt untrusted submit-Events, die trotzdem zum Ablauf gehoeren.
      const form = event.target;
      const st = wprState();
      const activation = st['activation'] as
        | { id: string; seq: number; ts: number; el: unknown; form: unknown; implicit: boolean }
        | null;
      const submitter = (event as unknown as { submitter?: unknown }).submitter ?? null;
      let causedBy: string | null = null;
      let causeKind: string | null = null;
      const enter = st['enterPending'] as { id: string; form: unknown } | null;
      if (enter && enter.form === form) {
        // Enter hat abgeschickt. Der eventuelle Default-Button-Klick dazwischen
        // ist selbst nur eine Folge; Ursache ist der Enter-Druck.
        causedBy = enter.id;
        causeKind = 'implicit-submit';
      } else if (activation && activation.form === form) {
        if (submitter !== null && activation.el === submitter) {
          // Kausal und ohne Zeitfenster: der Browser nennt den Ausloeser selbst.
          causedBy = activation.id;
          causeKind = 'submitter';
        } else if (activation.seq === st['seq'] && Date.now() - activation.ts < 5000) {
          // Kein Ereignis dazwischen -> der Klick/Enter davor hat ausgeloest.
          causedBy = activation.id;
          causeKind = 'sequence';
        }
      }
      wprFlushPending(null);
      wprEmit({ kind: 'submit', target: describe(form), causedBy: causedBy, causeKind: causeKind });
    },
    true,
  );

  wprFlush();
}

const RECORDER_INPAGE_FUNCTIONS = [
  wprState,
  wprFlush,
  wprEmit,
  wprIsFillable,
  wprValueOf,
  wprNotePending,
  wprFlushPending,
  wprIsSubmitButton,
  wprInstall,
];

/**
 * Setzt den zu injizierenden Quelltext zusammen und prueft ihn.
 *
 * Function.prototype.toString liefert nur den Funktionsrumpf. Alles, was diese
 * Funktionen benutzen, muss deshalb selbst im Quelltext stehen. Der Check unten
 * schlaegt an, sobald der Build Modulreferenzen oder tslib-Helfer einschleust.
 */
export function buildInPageSource(): string {
  const parts = [...SELECTOR_INPAGE_FUNCTIONS, ...RECORDER_INPAGE_FUNCTIONS].map((fn) => fn.toString());
  const body = parts.join('\n\n');
  assertSelfContained(body);
  return `(() => {\n'use strict';\n${body}\n\ntry { wprInstall(); } catch (e) { /* Recorder darf die Seite nie kaputtmachen */ }\n})();\n`;
}

const FORBIDDEN: Array<[RegExp, string]> = [
  [/\brequire\s*\(/, 'require(...)'],
  [/\bimport\s*\(/, 'import(...)'],
  [/^\s*import\s/m, 'import-Anweisung'],
  [/\bexports\b/, 'exports'],
  [/\bmodule\.exports\b/, 'module.exports'],
  [/\btslib_\d/, 'tslib-Helfer'],
  [/\b__importDefault\b/, '__importDefault'],
  [/\b__awaiter\b/, '__awaiter'],
  [/\b__generator\b/, '__generator'],
  [/\bselector_js_\d/, 'Modulreferenz auf selector.js'],
  [/\b\w+_js_\d+\./, 'Modulreferenz (<modul>_js_N.)'],
];

export function assertSelfContained(source: string): void {
  for (const [pattern, label] of FORBIDDEN) {
    if (pattern.test(source)) {
      throw new Error(
        `Der injizierte Recorder-Quelltext enthaelt ${label}. addInitScript serialisiert nur den ` +
          `Funktionsrumpf; solche Referenzen existieren im Browser nicht. Betroffener Quelltext:\n` +
          source.slice(Math.max(0, source.search(pattern) - 120), source.search(pattern) + 120),
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * NODE-Teil
 * ------------------------------------------------------------------ */

export interface RecorderHandle {
  start(name: string): Promise<void>;
  stop(): Promise<{ name: string; path: string; events: number }>;
  isRecording(): boolean;
  currentName(): string | null;
  eventCount(): number;
}

export function isValidFlowName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && name !== '.' && name !== '..';
}

export function flowPath(config: ResolvedConfig, name: string): string {
  if (!isValidFlowName(name)) {
    throw new Error(
      `Ungueltiger Flow-Name "${name}". Erlaubt sind Buchstaben, Ziffern, Punkt, Minus und Unterstrich.`,
    );
  }
  return join(config.flowsDirAbs, `${name}.jsonl`);
}

/**
 * Beschreibt einen Frame ueber die Kette seiner iframe-Elemente.
 * Genau das macht den Replay unabhaengig von Frame-URLs mit wechselnder Nonce.
 */
async function describeFrame(frame: Frame): Promise<FrameRef> {
  const path: FrameRef['path'] = [];
  let current: Frame | null = frame;
  const chain: Frame[] = [];
  while (current && current.parentFrame()) {
    chain.unshift(current);
    current = current.parentFrame();
  }
  for (const child of chain) {
    try {
      const handle = await child.frameElement();
      const described = (await handle.evaluate((el) =>
        (window as unknown as { __webpilotDescribe: (e: unknown) => unknown }).__webpilotDescribe(el),
      )) as { selectors?: unknown };
      await handle.dispose();
      const parsed = SelectorSetSchema.safeParse(described?.selectors);
      if (parsed.success) {
        path.push(parsed.data);
      } else {
        path.push({ primary: { kind: 'css', value: 'iframe' }, fallbacks: [], unique: false });
      }
    } catch (err) {
      log.warn(`Frame-Element nicht beschreibbar (${child.url()}): ${(err as Error).message}`);
      path.push({ primary: { kind: 'css', value: 'iframe' }, fallbacks: [], unique: false });
    }
  }
  return { path, url: frame.url(), name: frame.name() };
}

export async function attachRecorder(
  context: BrowserContext,
  config: ResolvedConfig,
): Promise<RecorderHandle> {
  let sink: ((event: FlowEvent) => void) | null = null;
  let stream: WriteStream | null = null;
  let name: string | null = null;
  let index = 0;
  let count = 0;
  const lastNavigation = new WeakMap<Page, string>();

  const write = (event: FlowEvent): void => {
    if (!sink) return;
    sink(event);
  };

  // GENAU EINMAL: sonst wirft der zweite record_start.
  await context.exposeBinding(BINDING_NAME, async (source, payload: unknown) => {
    if (!sink) return;
    const raw = payload as Record<string, unknown>;
    let frame: FrameRef = { path: [], url: '', name: '' };
    try {
      frame = await describeFrame(source.frame);
    } catch (err) {
      log.warn(`Frame-Beschreibung fehlgeschlagen: ${(err as Error).message}`);
    }
    const candidate = {
      ...raw,
      index: index++,
      ts: new Date().toISOString(),
      url: String(raw['pageUrl'] ?? source.frame.url()),
      frame,
    };
    delete (candidate as Record<string, unknown>)['pageUrl'];
    delete (candidate as Record<string, unknown>)['pageTs'];
    delete (candidate as Record<string, unknown>)['seq'];
    const parsed = FlowEventSchema.safeParse(candidate);
    if (!parsed.success) {
      log.warn(`Ereignis verworfen: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      index--;
      return;
    }
    count++;
    write(parsed.data);
  });

  await context.addInitScript({ content: buildInPageSource() });

  const attachPage = (page: Page): void => {
    page.on('framenavigated', (frame) => {
      if (!sink) return;
      if (frame !== page.mainFrame()) return; // Subframe-Navigationen sind Folgen, keine Aktionen.
      const url = frame.url();
      if (!url || url === 'about:blank') return;
      if (lastNavigation.get(page) === url) return;
      lastNavigation.set(page, url);
      const event = FlowEventSchema.safeParse({
        kind: 'navigate',
        index: index++,
        id: `nav:${index}`,
        ts: new Date().toISOString(),
        url,
        frame: { path: [], url, name: frame.name() },
      });
      if (!event.success) {
        index--;
        return;
      }
      count++;
      write(event.data);
    });
  };

  for (const page of context.pages()) attachPage(page);
  context.on('page', attachPage);

  return {
    isRecording: () => sink !== null,
    currentName: () => name,
    eventCount: () => count,
    async start(flowName: string) {
      if (sink) throw new Error(`Es laeuft bereits eine Aufnahme ("${name}"). Erst record_stop aufrufen.`);
      const target = flowPath(config, flowName);
      mkdirSync(config.flowsDirAbs, { recursive: true });
      const out = createWriteStream(target, { flags: 'w' });
      stream = out;
      name = flowName;
      index = 0;
      count = 0;
      sink = (event) => {
        out.write(`${JSON.stringify(event)}\n`);
      };

      // Startpunkt festhalten: wird die Aufnahme auf einer bereits geoeffneten
      // Seite gestartet (so laeuft es ueber record_start im MCP-Server), fehlt
      // dem Flow sonst die erste Navigation - und flow_run beginnt spaeter
      // irgendwo. Steht der Browser noch auf about:blank, gibt es nichts zu
      // notieren; die folgende Navigation liefert den Startpunkt dann selbst.
      const page = context.pages().at(-1);
      const startUrl = page?.mainFrame().url() ?? '';
      if (page && startUrl && startUrl !== 'about:blank') {
        lastNavigation.set(page, startUrl);
        const start = FlowEventSchema.safeParse({
          kind: 'navigate',
          index: index++,
          id: 'nav:start',
          ts: new Date().toISOString(),
          url: startUrl,
          frame: { path: [], url: startUrl, name: page.mainFrame().name() },
        });
        if (start.success) {
          count++;
          write(start.data);
        } else {
          index--;
        }
      }

      log.info(`Aufnahme gestartet: ${target}`);
    },
    async stop() {
      if (!sink || !stream || !name) throw new Error('Es laeuft keine Aufnahme.');
      const finishedName = name;
      const target = flowPath(config, finishedName);
      const out = stream;
      sink = null;
      stream = null;
      name = null;
      await new Promise<void>((resolve, reject) => {
        out.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });
      log.info(`Aufnahme beendet: ${target} (${count} Ereignisse)`);
      return { name: finishedName, path: target, events: count };
    },
  };
}
