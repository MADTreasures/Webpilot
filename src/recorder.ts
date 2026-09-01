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
import { isAllowedUrl, type ResolvedConfig } from './config.js';
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
 *   submitter           - das submit-Event nennt den Button, dessen Klick wir kennen
 *   sequence            - davor Klick/Enter im selben Formular, keine Aktion dazwischen
 *   implicit-activation - die Aktivierung, die Enter selbst ausgeloest hat: der
 *                         Klick auf den Default-Button eines Formulars oder der
 *                         Klick auf den fokussierten Link bzw. Button
 */
export const CauseKindSchema = z.enum([
  'submitter',
  'sequence',
  'implicit-activation',
  /** Alter Name von implicit-activation - aeltere Flows bleiben lesbar. */
  'implicit-submit',
]);

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
      /** Element -> vorgemerkter Feldwert. Map, nicht ein einzelner Platz:
       *  ein Autofill fuellt mehrere Felder nacheinander, der zweite Wert
       *  wuerde sonst den ersten spurlos verdraengen. */
      pending: new Map<object, unknown>(),
      activation: null as unknown,
      /** Zaehlt nur Aktionen (click, press, submit), keine Feldwerte. */
      actionSeq: 0,
      /** Bereits verarbeitete Event-Objekte - siehe ensureRoot. */
      seenEvents: new WeakSet<object>(),
      /** Letzter bereits gemeldeter Wert je Element - verhindert doppelte fills. */
      lastValues: new WeakMap<object, string>(),
      /** Gesetzt waehrend der Task, in der Enter verarbeitet wird. */
      enterPending: null as unknown,
      /** Shadow-Roots, die bereits change/submit-Listener tragen. */
      shadowRoots: new WeakSet<object>(),
      /**
       * Elemente, die jemals ein Passwortfeld waren. Ein "Passwort anzeigen"-
       * Schalter setzt type=password auf type=text um - ohne dieses Gedaechtnis
       * stuende der Klartext beim naechsten Herausschreiben im Log.
       */
      secrets: new WeakSet<object>(),
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
      // Das Binding liefert ein Promise, das beim Seitenwechsel abgelehnt wird.
      // Ohne catch entstuende in der aufgezeichneten Seite ein
      // unhandledrejection - ausgerechnet dort, wo wir nichts kaputtmachen wollen.
      const result = (sink as (v: unknown) => unknown)(item);
      if (result && typeof (result as { catch?: unknown }).catch === 'function') {
        (result as { catch: (fn: () => void) => void }).catch(() => {});
      }
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
  const knownSecrets = st['secrets'] as WeakSet<object>;
  // Einmal Passwortfeld, immer Passwortfeld: ein "Passwort anzeigen"-Schalter
  // macht aus type=password ein type=text, der Inhalt bleibt aber geheim.
  const isSecret = info['isPassword'] === true || knownSecrets.has(el as object);
  if (isSecret) {
    knownSecrets.add(el as object);
    info['isPassword'] = true;
    info['text'] = '';
  }
  const value = isSecret ? '{{secret:' + String(info['fieldName']) + '}}' : wprValueOf(el);
  const pending = st['pending'] as Map<object, unknown>;
  // Schon gemeldeter Wert: nichts vormerken. Sonst erzeugt das change-Event,
  // das beim Absenden nachtraeglich feuert, eine zweite identische Zeile.
  const seen = st['lastValues'] as WeakMap<object, string>;
  if (seen.get(el as object) === value) {
    pending.delete(el as object);
    return;
  }
  pending.set(el as object, { el: el, info: info, value: value, secret: isSecret });
}

/**
 * Schreibt aufgestaute fill-Ereignisse heraus, in der Reihenfolge, in der die
 * Felder angefasst wurden. `only` begrenzt auf ein Element, null nimmt alle.
 */
export function wprFlushPending(only: unknown): void {
  const st = wprState();
  const pending = st['pending'] as Map<object, { el: unknown; info: Record<string, unknown>; value: string; secret: boolean }>;
  if (pending.size === 0) return;
  const lastValues = st['lastValues'] as WeakMap<object, string>;
  const emit = (entry: { el: unknown; info: Record<string, unknown>; value: string; secret: boolean }): void => {
    lastValues.set(entry.el as object, entry.value);
    wprEmit({ kind: 'fill', target: entry.info, value: entry.value, secret: entry.secret });
  };
  if (only !== null && only !== undefined) {
    const entry = pending.get(only as object);
    if (!entry) return;
    pending.delete(only as object);
    emit(entry);
    return;
  }
  const entries: Array<{ el: unknown; info: Record<string, unknown>; value: string; secret: boolean }> = [];
  pending.forEach((entry) => entries.push(entry));
  pending.clear();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry) emit(entry);
  }
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

  // change und submit sind composed:false - sie erreichen einen Listener am
  // document NICHT, wenn sie in einer Shadow-Root entstehen. Deshalb bekommt
  // jede Shadow-Root, die uns ueber composedPath eines composed-Events unter
  // die Augen kommt, dieselben beiden Listener. Bedarfsgesteuert statt
  // attachShadow zu patchen: das erwischt auch deklarative Shadow-Roots.
  const rootsWithListeners = st['shadowRoots'] as WeakSet<object>;
  const ensureRoot = (root: unknown): void => {
    const target = root as { addEventListener?: (t: string, l: (e: Event) => void, c: boolean) => void };
    if (!target || typeof target.addEventListener !== 'function') return;
    if (rootsWithListeners.has(root as object)) return;
    rootsWithListeners.add(root as object);
    target.addEventListener('change', (e: Event) => onChange(e), true);
    target.addEventListener('submit', (e: Event) => onSubmit(e), true);
  };

  const realTarget = (event: Event): unknown => {
    const path = (event as unknown as { composedPath?: () => unknown[] }).composedPath;
    let result: unknown = event.target;
    if (typeof path === 'function') {
      const list = path.call(event);
      if (list && list.length > 0) {
        const first = list[0] as { nodeType?: number };
        if (first && first.nodeType === 1) result = first;
        for (let i = 0; i < list.length; i++) {
          const node = list[i] as { nodeType?: number; host?: unknown };
          // DOCUMENT_FRAGMENT_NODE mit host === Shadow-Root
          if (node && node.nodeType === 11 && node.host) ensureRoot(node);
        }
      }
    }
    return result;
  };

  const closestForm = (el: unknown): unknown => {
    const e = el as { closest?: (s: string) => unknown; form?: unknown };
    if (e && e.form) return e.form;
    if (e && typeof e.closest === 'function') return e.closest('form');
    return null;
  };

  // input und change bewusst OHNE isTrusted-Filter: Passwortmanager,
  // Autofill und React-gesteuerte Felder setzen Werte per synthetischem
  // input-Event. Filtert man die weg, lernt der Koaleszierer den Wert nie und
  // der Login wird mit leerem Feld aufgezeichnet. Beide Handler melden fuer
  // sich nichts - sie merken sich nur den Feldinhalt bzw. schreiben ihn
  // heraus; die Filterung gegen JS-synthetisierte Aktionen sitzt dort, wo sie
  // hingehoert: bei click und keydown.
  document.addEventListener(
    'input',
    (event: Event) => {
      const target = realTarget(event);
      if (!wprIsFillable(target)) return;
      wprNotePending(target);
    },
    true,
  );

  // Ein change/submit aus geslottetem Light-DOM-Inhalt laeuft ueber den
  // flachen Baum und erreicht damit BEIDE Listener - den an der Shadow-Root
  // und den am document. Ohne diese Sperre stuende jedes solche Ereignis
  // zweimal im JSONL.
  const alreadyHandled = (event: Event): boolean => {
    const seen = wprState()['seenEvents'] as WeakSet<object>;
    if (seen.has(event as unknown as object)) return true;
    seen.add(event as unknown as object);
    return false;
  };

  function onChange(event: Event): void {
      if (alreadyHandled(event)) return;
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
  }
  document.addEventListener('change', onChange, true);

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
      const enter = st['enterPending'] as { id: string; form: unknown; el: unknown } | null;
      // Enter aktiviert das fokussierte Element: bei einem Link oder Button
      // erzeugt der Browser dafuer selbst einen Klick, bei einem Formularfeld
      // einen Klick auf den Default-Button. Beides ist eine Folge, keine
      // eigene Nutzeraktion - und beides passiert in derselben Task wie das
      // keydown, ein echter Nutzerklick kann dort nicht dazwischen.
      const implicit =
        enter !== null && (enter.el === target || (enter.form === form && wprIsSubmitButton(target, form)));
      const info = describe(target);
      const emitted = wprEmit({
        kind: 'click',
        target: info,
        causedBy: implicit && enter ? enter.id : null,
        causeKind: implicit ? 'implicit-activation' : null,
      });
      st['actionSeq'] = (st['actionSeq'] as number) + 1;
      st['activation'] = {
        id: emitted['id'],
        actionSeq: st['actionSeq'],
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
      st['actionSeq'] = (st['actionSeq'] as number) + 1;
      st['activation'] = {
        id: emitted['id'],
        actionSeq: st['actionSeq'],
        ts: Date.now(),
        el: target,
        form: form,
        implicit: false,
      };
      // Nur fuer die Dauer dieser Task: der implizite Klick des Browsers kommt
      // synchron in der Default-Action des keydown. Kein Zeitfenster noetig.
      st['enterPending'] = { id: emitted['id'], form: form, el: target };
      setTimeout(() => {
        wprState()['enterPending'] = null;
      }, 0);
    },
    true,
  );

  function onSubmit(event: Event): void {
      if (alreadyHandled(event)) return;
      // submit bewusst OHNE isTrusted-Filter: requestSubmit() aus Seitenskripten
      // erzeugt untrusted submit-Events, die trotzdem zum Ablauf gehoeren.
      const form = event.target;
      const st = wprState();
      const activation = st['activation'] as
        | { id: string; actionSeq: number; ts: number; el: unknown; form: unknown; implicit: boolean }
        | null;
      const submitter = (event as unknown as { submitter?: unknown }).submitter ?? null;
      let causedBy: string | null = null;
      let causeKind: string | null = null;
      const enter = st['enterPending'] as { id: string; form: unknown; el: unknown } | null;
      if (enter && enter.form === form) {
        // Enter hat abgeschickt. Der eventuelle Default-Button-Klick dazwischen
        // ist selbst nur eine Folge; Ursache ist der Enter-Druck.
        causedBy = enter.id;
        causeKind = 'implicit-activation';
      } else if (activation && activation.form === form) {
        if (submitter !== null && activation.el === submitter) {
          // Kausal und ohne Zeitfenster: der Browser nennt den Ausloeser selbst.
          causedBy = activation.id;
          causeKind = 'submitter';
        } else if (activation.actionSeq === st['actionSeq'] && Date.now() - activation.ts < 5000) {
          // Seit dem Klick/Enter gab es keine weitere AKTION. Bewusst nur
          // Aktionen zaehlen: ein change-Ereignis zwischen Klick und submit ist
          // ueblich (Seitenskript setzt ein Feld) und darf die Kausalitaet
          // nicht zerreissen - sonst wird beim Replay doppelt abgeschickt.
          causedBy = activation.id;
          causeKind = 'sequence';
        }
      }
      wprFlushPending(null);
      st['actionSeq'] = (st['actionSeq'] as number) + 1;
      wprEmit({ kind: 'submit', target: describe(form), causedBy: causedBy, causeKind: causeKind });
  }
  document.addEventListener('submit', onSubmit, true);

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

  /**
   * Ereignisse kommen aus zwei Quellen (Binding und framenavigated) und die
   * Binding-Verarbeitung ist asynchron (die Frame-Kette muss aus der Seite
   * geholt werden). Ohne Serialisierung koennte ein spaeteres Ereignis, dessen
   * Frame-Aufloesung schneller fertig ist, VOR einem frueheren in der Datei
   * landen. Deshalb: index synchron vergeben, Schreiben ueber eine Kette.
   */
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (task: () => Promise<void>): Promise<void> => {
    queue = queue.then(task, () => undefined).catch(() => undefined);
    return queue;
  };

  const write = (event: FlowEvent): void => {
    if (!sink) return;
    sink(event);
  };

  const nextIndex = (): number => index++;

  // GENAU EINMAL: sonst wirft der zweite record_start.
  await context.exposeBinding(BINDING_NAME, (source, payload: unknown) => {
    if (!sink) return undefined;
    // Synchron, noch vor jedem await: die Reihenfolge steht damit fest.
    const eventIndex = nextIndex();
    const raw = payload as Record<string, unknown>;
    return enqueue(async () => {
      if (!sink) return;
      let frame: FrameRef = { path: [], url: '', name: '' };
      try {
        frame = await describeFrame(source.frame);
      } catch (err) {
        log.warn(`Frame-Beschreibung fehlgeschlagen: ${(err as Error).message}`);
      }
      const candidate: Record<string, unknown> = {
        ...raw,
        index: eventIndex,
        ts: new Date().toISOString(),
        url: String(raw['pageUrl'] ?? source.frame.url()),
        frame,
      };
      delete candidate['pageUrl'];
      delete candidate['pageTs'];
      delete candidate['seq'];
      const parsed = FlowEventSchema.safeParse(candidate);
      if (!parsed.success) {
        log.warn(
          `Ereignis #${eventIndex} verworfen: ` +
            parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        );
        return;
      }
      count++;
      write(parsed.data);
    });
  });

  await context.addInitScript({ content: buildInPageSource() });

  const attachPage = (page: Page): void => {
    // addInitScript-Fehler sind still: das Script wirft in der Seite, aber
    // weder addInitScript noch goto melden etwas. Ohne diesen Listener merkt
    // man erst am leeren JSONL, dass der Recorder gar nicht laeuft.
    page.on('pageerror', (err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (/__webpilot|wpr[A-Z]|wp[A-Z]/.test(message) || /is not defined/.test(message)) {
        log.error(`Fehler im injizierten Recorder-Code: ${message}`);
      } else {
        log.debug(`Seitenfehler: ${message}`);
      }
    });
    page.on('framenavigated', (frame) => {
      if (!sink) return;
      if (frame !== page.mainFrame()) return; // Subframe-Navigationen sind Folgen, keine Aktionen.
      const url = frame.url();
      if (!url || url === 'about:blank') return;
      // Eine geblockte Domain gehoert nicht in den Flow: der Backstop in
      // browser.ts verlaesst sie ohnehin sofort wieder.
      if (!isAllowedUrl(url, config.allowedDomains)) return;
      if (lastNavigation.get(page) === url) return;
      lastNavigation.set(page, url);
      const eventIndex = nextIndex();
      const event = FlowEventSchema.safeParse({
        kind: 'navigate',
        index: eventIndex,
        id: `nav:${eventIndex}`,
        ts: new Date().toISOString(),
        url,
        frame: { path: [], url, name: frame.name() },
      });
      if (!event.success) return;
      void enqueue(async () => {
        if (!sink) return;
        count++;
        write(event.data);
      });
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
      // Ohne diesen Listener beendet ein Schreibfehler (Verzeichnis statt
      // Datei, volle Platte) den ganzen Prozess - beim MCP-Server waere das
      // der Serverabsturz mitten in einer Aufnahme.
      out.on('error', (err) => {
        log.error(`Schreibfehler in ${target}: ${err.message}. Aufnahme wird beendet.`);
        sink = null;
      });
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
      if (page && startUrl && startUrl !== 'about:blank' && isAllowedUrl(startUrl, config.allowedDomains)) {
        lastNavigation.set(page, startUrl);
        const start = FlowEventSchema.safeParse({
          kind: 'navigate',
          index: nextIndex(),
          id: 'nav:start',
          ts: new Date().toISOString(),
          url: startUrl,
          frame: { path: [], url: startUrl, name: page.mainFrame().name() },
        });
        if (start.success) {
          count++;
          write(start.data);
        }
      }

      log.info(`Aufnahme gestartet: ${target}`);
    },
    async stop() {
      if (!sink || !stream || !name) throw new Error('Es laeuft keine Aufnahme.');
      const finishedName = name;
      const target = flowPath(config, finishedName);
      const out = stream;
      // Erst alles Angestaute wegschreiben, dann die Senke schliessen.
      await queue;
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
