/**
 * Selektor-Generierung.
 *
 * Zwei Haelften:
 *  - Der IN-PAGE-Teil (alle Funktionen mit Praefix `wp`) laeuft im Browser. Er
 *    wird NICHT importiert, sondern per Function.prototype.toString zu einem
 *    einzigen Quelltext zusammengesetzt und ueber addInitScript({content})
 *    injiziert. Deshalb gilt fuer diese Funktionen: keine Imports, keine
 *    Closure-Variablen, keine TypeScript-Konstrukte, die Laufzeit-Helfer
 *    erzeugen (enum, namespace, Decorators, Downlevel-Syntax). buildInPageSource()
 *    prueft das Ergebnis, damit sich nach einem Build nichts einschleicht.
 *  - Der NODE-Teil setzt die aufgezeichneten Selektoren wieder in Playwright-
 *    Locators um.
 *
 * Prioritaet der Strategien (aus der Anforderung):
 *   data-testid > id > Rolle+Accessible Name > sichtbarer Text > CSS-Pfad
 * Pro Element werden zusaetzlich zwei Fallback-Selektoren gespeichert, die
 * bewusst aus ANDEREN Strategien stammen.
 */
import type { FrameLocator, Locator, Page } from 'playwright';
import { z } from 'zod';

/* ------------------------------------------------------------------ *
 * Typen (gemeinsam fuer JSONL, Recorder und Replay)
 * ------------------------------------------------------------------ */

export const SelectorSpecSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('testid'), value: z.string() }),
  z.object({ kind: z.literal('id'), value: z.string() }),
  z.object({ kind: z.literal('role'), role: z.string(), name: z.string(), exact: z.boolean().default(false) }),
  z.object({ kind: z.literal('text'), value: z.string(), tag: z.string().nullable().default(null) }),
  z.object({ kind: z.literal('css'), value: z.string() }),
]);
export type SelectorSpec = z.infer<typeof SelectorSpecSchema>;

export const SelectorSetSchema = z.object({
  /** Bester Selektor nach der Prioritaetsliste. */
  primary: SelectorSpecSchema,
  /** Genau die zwei naechstbesten Selektoren aus moeglichst anderen Strategien. */
  fallbacks: z.array(SelectorSpecSchema).max(4).default([]),
  /** Diagnose: war der Selektor bei der Aufnahme im Dokument eindeutig? */
  unique: z.boolean().default(true),
});
export type SelectorSet = z.infer<typeof SelectorSetSchema>;

export const ElementInfoSchema = z.object({
  selectors: SelectorSetSchema,
  tag: z.string(),
  role: z.string().nullable().default(null),
  accessibleName: z.string().default(''),
  text: z.string().default(''),
  /** Feldname fuer die Secret-Ersetzung (name > id > data-testid > accname). */
  fieldName: z.string().default(''),
  isPassword: z.boolean().default(false),
  inputType: z.string().nullable().default(null),
});
export type ElementInfo = z.infer<typeof ElementInfoSchema>;

/* ------------------------------------------------------------------ *
 * IN-PAGE-Teil
 * ------------------------------------------------------------------ */

/** Whitespace normalisieren und auf `max` Zeichen kuerzen. */
export function wpNorm(value: unknown, max: number): string {
  const s = String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

export function wpCssEscape(value: string): string {
  const g = globalThis as unknown as { CSS?: { escape?: (s: string) => string } };
  if (g.CSS && typeof g.CSS.escape === 'function') return g.CSS.escape(value);
  return value.replace(/["\\]/g, '\\$&');
}

/** Attributwert fuer einen CSS-Attributselektor in doppelte Anfuehrungszeichen setzen. */
export function wpQuoteAttr(value: string): string {
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** Erkennt generierte ids (React `:r0:`, Ember, UUIDs, lange Zahlenketten). */
export function wpIsStableId(id: unknown): boolean {
  if (typeof id !== 'string') return false;
  const v = id.trim();
  if (v === '' || v.length > 64) return false;
  if (/\s/.test(v)) return false;
  if (/^[:.]/.test(v)) return false;
  if (/\d{4,}/.test(v)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v)) return false;
  if (/^(ember|react-aria|radix-|mui-|headlessui-|:r)/i.test(v)) return false;
  return /^[A-Za-z_][A-Za-z0-9_:.-]*$/.test(v);
}

export function wpIsVisible(el: unknown): boolean {
  const node = el as { getClientRects?: () => { length: number } };
  if (!node || typeof node.getClientRects !== 'function') return false;
  if (node.getClientRects().length === 0) return false;
  const view = (el as { ownerDocument?: { defaultView?: unknown } }).ownerDocument?.defaultView as
    | { getComputedStyle?: (e: unknown) => { visibility: string } }
    | undefined;
  if (view && typeof view.getComputedStyle === 'function') {
    if (view.getComputedStyle(el).visibility === 'hidden') return false;
  }
  return true;
}

/**
 * Implizite ARIA-Rolle. Die Tabelle spiegelt bewusst das Verhalten von
 * Playwright 1.56 (packages/injected roleUtils), damit ein hier erzeugter
 * role-Selektor beim Replay auch wirklich greift.
 *
 * Hinweis: input[type=password] hat laut ARIA-Spezifikation keine Rolle,
 * Playwright bildet es aber ueber den Default-Zweig auf `textbox` ab. Der
 * Selektor funktioniert also - siehe Kommentar in wpCandidates(), warum wir
 * fuer Passwortfelder trotzdem immer einen rollenfreien Fallback erzwingen.
 */
export function wpRole(el: unknown): string | null {
  const e = el as {
    localName: string;
    getAttribute: (n: string) => string | null;
    hasAttribute: (n: string) => boolean;
    size?: number;
    ownerDocument?: { getElementById?: (id: string) => unknown };
  };
  const explicit = e.getAttribute('role');
  if (explicit) {
    const first = explicit.trim().split(/\s+/)[0];
    if (first) return first;
  }
  const tag = e.localName;
  if (tag === 'a' || tag === 'area') return e.hasAttribute('href') ? 'link' : null;
  if (tag === 'button') return 'button';
  if (tag === 'summary') return 'button';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'select') return e.hasAttribute('multiple') || (e.size ?? 0) > 1 ? 'listbox' : 'combobox';
  if (tag === 'option') return 'option';
  if (tag === 'img') return e.getAttribute('alt') === '' ? 'presentation' : 'img';
  if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') return 'heading';
  if (tag === 'nav') return 'navigation';
  if (tag === 'main') return 'main';
  if (tag === 'table') return 'table';
  if (tag === 'ul' || tag === 'ol') return 'list';
  if (tag === 'li') return 'listitem';
  if (tag === 'dialog') return 'dialog';
  if (tag === 'input') {
    const type = (e.getAttribute('type') || '').toLowerCase();
    if (type === 'search') return e.hasAttribute('list') ? 'combobox' : 'searchbox';
    if (type === '' || type === 'text' || type === 'email' || type === 'tel' || type === 'url') {
      const listId = e.getAttribute('list');
      const list = listId && e.ownerDocument?.getElementById ? e.ownerDocument.getElementById(listId) : null;
      return list && (list as { localName?: string }).localName === 'datalist' ? 'combobox' : 'textbox';
    }
    if (type === 'hidden') return null;
    if (type === 'file') return 'button';
    if (type === 'button' || type === 'image' || type === 'reset' || type === 'submit') return 'button';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'number') return 'spinbutton';
    if (type === 'range') return 'slider';
    return 'textbox';
  }
  return null;
}

/**
 * Accessible Name, praktikable Teilmenge von accname:
 * aria-labelledby > aria-label > <label> > value (Buttons) > alt/title >
 * placeholder > Textinhalt.
 */
export function wpAccName(el: unknown): string {
  const e = el as {
    localName: string;
    getAttribute: (n: string) => string | null;
    labels?: ArrayLike<{ textContent: string | null }>;
    textContent: string | null;
    value?: string;
    getRootNode?: () => { getElementById?: (id: string) => { textContent: string | null } | null };
  };

  const labelledBy = e.getAttribute('aria-labelledby');
  if (labelledBy) {
    const root = e.getRootNode ? e.getRootNode() : null;
    const parts: string[] = [];
    const ids = labelledBy.trim().split(/\s+/);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (!id) continue;
      const ref = root && root.getElementById ? root.getElementById(id) : null;
      if (ref) parts.push(wpNorm(ref.textContent, 200));
    }
    const joined = wpNorm(parts.join(' '), 200);
    if (joined) return joined;
  }

  const ariaLabel = e.getAttribute('aria-label');
  if (ariaLabel && wpNorm(ariaLabel, 200)) return wpNorm(ariaLabel, 200);

  const tag = e.localName;
  if (tag === 'input' || tag === 'select' || tag === 'textarea') {
    const labels = e.labels;
    if (labels && labels.length > 0) {
      const parts: string[] = [];
      for (let i = 0; i < labels.length; i++) {
        const l = labels[i];
        if (l) parts.push(wpNorm(l.textContent, 200));
      }
      const joined = wpNorm(parts.join(' '), 200);
      if (joined) return joined;
    }
    if (tag === 'input') {
      const type = (e.getAttribute('type') || '').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset') {
        const v = wpNorm(e.value, 200);
        if (v) return v;
      }
    }
    const title = wpNorm(e.getAttribute('title'), 200);
    if (title) return title;
    const placeholder = wpNorm(e.getAttribute('placeholder'), 200);
    if (placeholder) return placeholder;
    return '';
  }

  if (tag === 'img' || tag === 'area') {
    const alt = wpNorm(e.getAttribute('alt'), 200);
    if (alt) return alt;
  }

  const content = wpNorm(e.textContent, 200);
  if (content) return content;
  return wpNorm(e.getAttribute('title'), 200);
}

/** Ein Pfadsegment: Tagname plus :nth-of-type, falls noetig. */
export function wpCssSegment(el: unknown): string {
  const e = el as { localName: string; parentElement: unknown };
  const tag = e.localName;
  const parent = e.parentElement as { children?: ArrayLike<{ localName: string }> } | null;
  if (!parent || !parent.children) return tag;
  let index = 0;
  let total = 0;
  for (let i = 0; i < parent.children.length; i++) {
    const child = parent.children[i];
    if (!child || child.localName !== tag) continue;
    total++;
    if (child === (el as unknown)) index = total;
  }
  return total > 1 ? tag + ':nth-of-type(' + index + ')' : tag;
}

/**
 * CSS-Pfad.
 *
 * `anchorAtAncestorId` bricht beim naechsten Vorfahren mit stabiler id ab -
 * aber NIE bei der id des Elements selbst. Sonst waeren Primaerselektor (#id)
 * und CSS-Fallback identisch und Elemente mit id haetten gar keinen Fallback.
 * Shadow-Grenzen werden mit einem Descendant-Kombinator ueberbrueckt, weil
 * Playwrights css-Engine offene Shadow-Roots durchdringt.
 */
export function wpCssPath(el: unknown, anchorAtAncestorId: boolean): string {
  type Step = { sel: string; sep: string };
  const chain: Step[] = [];
  let node = el as { nodeType: number; id?: string; parentElement: unknown; getRootNode?: () => { host?: unknown } } | null;
  // `sep` verbindet den aktuellen Knoten mit dem zuletzt abgelegten Kindknoten.
  let sep = '';
  let guard = 0;
  while (node && node.nodeType === 1 && guard < 60) {
    guard++;
    if (anchorAtAncestorId && node !== el && wpIsStableId(node.id)) {
      chain.push({ sel: '#' + wpCssEscape(String(node.id)), sep: sep });
      break;
    }
    chain.push({ sel: wpCssSegment(node), sep: sep });
    const parent = node.parentElement as typeof node;
    if (parent) {
      sep = ' > ';
      node = parent;
      continue;
    }
    const root = node.getRootNode ? node.getRootNode() : null;
    const host = root && root.host ? root.host : null;
    if (!host) break;
    // Shadow-Grenze: Descendant statt Child, damit Playwrights css-Engine
    // die offene Shadow-Root durchdringen kann.
    sep = ' ';
    node = host as typeof node;
  }
  if (chain.length === 0) return '';
  const last = chain[chain.length - 1];
  let out = last ? last.sel : '';
  for (let i = chain.length - 2; i >= 0; i--) {
    const step = chain[i];
    const link = chain[i + 1];
    if (!step || !link) continue;
    out = out + link.sep + step.sel;
  }
  return out;
}

/** CSS-Selektor aus stabilen Attributen, verankert am naechsten sinnvollen Vorfahren. */
export function wpAttrCss(el: unknown): string | null {
  const e = el as {
    localName: string;
    getAttribute: (n: string) => string | null;
    parentElement: unknown;
    id?: string;
  };
  const tag = e.localName;
  const bits: string[] = [tag];
  const name = e.getAttribute('name');
  const type = e.getAttribute('type');
  const placeholder = e.getAttribute('placeholder');
  const ariaLabel = e.getAttribute('aria-label');
  if (name) bits.push('[name=' + wpQuoteAttr(name) + ']');
  else if (ariaLabel) bits.push('[aria-label=' + wpQuoteAttr(ariaLabel) + ']');
  else if (placeholder) bits.push('[placeholder=' + wpQuoteAttr(placeholder) + ']');
  else return null;
  if (type && tag === 'input') bits.push('[type=' + wpQuoteAttr(type) + ']');
  const self = bits.join('');

  // Verankerung: naechster Vorfahr mit stabiler id, sonst ein benanntes <form>.
  let anchor = e.parentElement as { localName?: string; id?: string; getAttribute?: (n: string) => string | null; parentElement?: unknown } | null;
  let guard = 0;
  while (anchor && guard < 30) {
    guard++;
    if (wpIsStableId(anchor.id)) return '#' + wpCssEscape(String(anchor.id)) + ' ' + self;
    if (anchor.localName === 'form' && anchor.getAttribute) {
      const formName = anchor.getAttribute('name');
      if (formName) return 'form[name=' + wpQuoteAttr(formName) + '] ' + self;
    }
    anchor = (anchor.parentElement ?? null) as typeof anchor;
  }
  return self;
}

/** Zaehlt Treffer eines CSS-Selektors in der Wurzel des Elements. */
export function wpCountCss(el: unknown, selector: string): number {
  const e = el as { getRootNode?: () => { querySelectorAll?: (s: string) => ArrayLike<unknown> } };
  const root = e.getRootNode ? e.getRootNode() : null;
  const scope = root && root.querySelectorAll ? root : null;
  if (!scope || !scope.querySelectorAll) return -1;
  try {
    const found = scope.querySelectorAll(selector);
    return found.length;
  } catch {
    return -1;
  }
}

/** Alle Elemente der Wurzel, gedeckelt, damit riesige Seiten nicht blockieren. */
export function wpAllElements(el: unknown): unknown[] {
  const e = el as { getRootNode?: () => { querySelectorAll?: (s: string) => ArrayLike<unknown> } };
  const root = e.getRootNode ? e.getRootNode() : null;
  if (!root || !root.querySelectorAll) return [];
  const all = root.querySelectorAll('*');
  const out: unknown[] = [];
  const max = all.length > 4000 ? 4000 : all.length;
  for (let i = 0; i < max; i++) out.push(all[i]);
  return out;
}

/**
 * Zaehlt Elemente mit gleicher Rolle und gleichem Accessible Name.
 * Playwright vergleicht den Namen bei exact=false ohne Beruecksichtigung von
 * Gross-/Kleinschreibung ueber den ganzen String - genau so wird hier gezaehlt.
 */
export function wpCountRole(el: unknown, role: string, name: string): number {
  const list = wpAllElements(el);
  if (list.length === 0) return -1;
  const needle = name.toLowerCase();
  let count = 0;
  for (let i = 0; i < list.length; i++) {
    const candidate = list[i];
    if (wpRole(candidate) !== role) continue;
    if (wpAccName(candidate).toLowerCase() !== needle) continue;
    count++;
    if (count > 1) return count;
  }
  return count;
}

/** Zaehlt sichtbare Elemente, deren normalisierter Text exakt uebereinstimmt. */
export function wpCountText(el: unknown, text: string, tag: string | null): number {
  const list = wpAllElements(el);
  if (list.length === 0) return -1;
  let count = 0;
  for (let i = 0; i < list.length; i++) {
    const candidate = list[i] as { localName: string; textContent: string | null };
    if (tag && candidate.localName !== tag) continue;
    if (wpNorm(candidate.textContent, 400) !== text) continue;
    if (!wpIsVisible(candidate)) continue;
    count++;
    if (count > 1) return count;
  }
  return count;
}

/** Feldname fuer {{secret:<name>}} und fuer die Diagnose. */
export function wpFieldName(el: unknown): string {
  const e = el as { getAttribute: (n: string) => string | null; id?: string };
  const name = e.getAttribute('name');
  if (name && wpNorm(name, 64)) return wpNorm(name, 64);
  if (wpIsStableId(e.id)) return wpNorm(e.id, 64);
  const testid = e.getAttribute('data-testid');
  if (testid) return wpNorm(testid, 64);
  const accname = wpAccName(el);
  if (accname) return wpNorm(accname.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), 64);
  return 'feld';
}

export function wpIsPassword(el: unknown): boolean {
  const e = el as { localName: string; getAttribute: (n: string) => string | null };
  if (e.localName !== 'input') return false;
  const type = (e.getAttribute('type') || '').toLowerCase();
  if (type === 'password') return true;
  const autocomplete = (e.getAttribute('autocomplete') || '').toLowerCase();
  // new-password gehoert genauso wenig ins Log wie current-password.
  return autocomplete === 'current-password' || autocomplete === 'new-password';
}

/**
 * Baut die Kandidatenliste in der geforderten Prioritaet und verifiziert jede
 * Variante direkt im Dokument auf Eindeutigkeit.
 */
export function wpCandidates(el: unknown): Array<{ spec: unknown; unique: boolean; family: string }> {
  const e = el as { localName: string; getAttribute: (n: string) => string | null; id?: string; textContent: string | null };
  const out: Array<{ spec: unknown; unique: boolean; family: string }> = [];
  const push = (spec: unknown, unique: boolean, family: string) => {
    out.push({ spec: spec, unique: unique, family: family });
  };

  // 1. data-testid
  const testid = e.getAttribute('data-testid');
  if (testid && wpNorm(testid, 200)) {
    const count = wpCountCss(el, '[data-testid=' + wpQuoteAttr(testid) + ']');
    push({ kind: 'testid', value: testid }, count === 1, 'testid');
  }

  // 2. id
  if (wpIsStableId(e.id)) {
    const id = String(e.id);
    const count = wpCountCss(el, '[id=' + wpQuoteAttr(id) + ']');
    push({ kind: 'id', value: id }, count === 1, 'id');
  }

  // 3. Rolle + Accessible Name
  const role = wpRole(el);
  const accName = wpAccName(el);
  if (role && accName) {
    const count = wpCountRole(el, role, accName);
    push({ kind: 'role', role: role, name: accName, exact: false }, count === 1, 'role');
  }

  // 4. Sichtbarer Text (nur fuer Elemente, die ihren Namen aus dem Text ziehen)
  const ownText = wpNorm(e.textContent, 120);
  if (ownText && ownText.length <= 80 && e.localName !== 'input' && e.localName !== 'textarea') {
    const count = wpCountText(el, ownText, e.localName);
    push({ kind: 'text', value: ownText, tag: e.localName }, count === 1, 'text');
  }

  // 5. CSS - drei bewusst unterschiedliche Varianten
  const attrCss = wpAttrCss(el);
  if (attrCss) push({ kind: 'css', value: attrCss }, wpCountCss(el, attrCss) === 1, 'css-attr');

  const anchored = wpCssPath(el, true);
  if (anchored) push({ kind: 'css', value: anchored }, wpCountCss(el, anchored) === 1, 'css-anchored');

  const full = wpCssPath(el, false);
  if (full && full !== anchored) push({ kind: 'css', value: full }, wpCountCss(el, full) === 1, 'css-full');

  return out;
}

/**
 * Waehlt Primaerselektor und zwei Fallbacks. Bevorzugt werden eindeutige
 * Kandidaten; unter diesen wird die Prioritaetsreihenfolge eingehalten und
 * darauf geachtet, dass die Fallbacks aus anderen Strategie-Familien stammen.
 */
export function wpDescribe(el: unknown): unknown {
  const e = el as { localName: string; getAttribute: (n: string) => string | null; textContent: string | null };
  const candidates = wpCandidates(el);
  const unique: Array<{ spec: unknown; unique: boolean; family: string }> = [];
  const rest: Array<{ spec: unknown; unique: boolean; family: string }> = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!c) continue;
    if (c.unique) unique.push(c);
    else rest.push(c);
  }
  const ordered = unique.concat(rest);
  const chosen: Array<{ spec: unknown; unique: boolean; family: string }> = [];
  const usedFamilies: string[] = [];
  // Erst je Familie den besten Kandidaten, dann auffuellen.
  for (let i = 0; i < ordered.length && chosen.length < 3; i++) {
    const c = ordered[i];
    if (!c) continue;
    if (usedFamilies.indexOf(c.family) !== -1) continue;
    usedFamilies.push(c.family);
    chosen.push(c);
  }
  for (let i = 0; i < ordered.length && chosen.length < 3; i++) {
    const c = ordered[i];
    if (!c) continue;
    if (chosen.indexOf(c) !== -1) continue;
    chosen.push(c);
  }

  const primary = chosen[0];
  const fallbacks: unknown[] = [];
  for (let i = 1; i < chosen.length; i++) {
    const c = chosen[i];
    if (c) fallbacks.push(c.spec);
  }

  const isPassword = wpIsPassword(el);
  return {
    selectors: {
      primary: primary ? primary.spec : { kind: 'css', value: wpCssPath(el, false) || e.localName },
      fallbacks: fallbacks,
      unique: primary ? primary.unique : false,
    },
    tag: e.localName,
    role: wpRole(el),
    accessibleName: wpAccName(el),
    // Bei Passwortfeldern nie Text mitschleppen - der koennte den Wert enthalten.
    text: isPassword ? '' : wpNorm(e.textContent, 120),
    fieldName: wpFieldName(el),
    isPassword: isPassword,
    inputType: e.localName === 'input' ? (e.getAttribute('type') || 'text').toLowerCase() : null,
  };
}

/**
 * Alle in-page-Funktionen dieses Moduls in Injektions-Reihenfolge.
 * Reihenfolge ist egal (Funktionsdeklarationen werden gehoisted), die Liste
 * dient der Vollstaendigkeit.
 */
export const SELECTOR_INPAGE_FUNCTIONS = [
  wpNorm,
  wpCssEscape,
  wpQuoteAttr,
  wpIsStableId,
  wpIsVisible,
  wpRole,
  wpAccName,
  wpCssSegment,
  wpCssPath,
  wpAttrCss,
  wpCountCss,
  wpAllElements,
  wpCountRole,
  wpCountText,
  wpFieldName,
  wpIsPassword,
  wpCandidates,
  wpDescribe,
];

/* ------------------------------------------------------------------ *
 * NODE-Teil: Selektor -> Playwright-Locator
 * ------------------------------------------------------------------ */

export type LocatorScope = Page | FrameLocator | Locator;

export function toLocator(scope: LocatorScope, spec: SelectorSpec): Locator {
  switch (spec.kind) {
    case 'testid':
      // getByTestId haengt am konfigurierten Attribut; wir wollen explizit data-testid.
      return scope.locator(`[data-testid=${quoteAttr(spec.value)}]`);
    case 'id':
      return scope.locator(`[id=${quoteAttr(spec.value)}]`);
    case 'role':
      return scope.getByRole(spec.role as Parameters<Page['getByRole']>[0], {
        name: spec.name,
        exact: spec.exact,
      });
    case 'text':
      return spec.tag
        ? scope.locator(spec.tag).filter({ hasText: exactText(spec.value) })
        : scope.getByText(spec.value, { exact: true });
    case 'css':
      return scope.locator(spec.value);
  }
}

function exactText(value: string): RegExp {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*${escaped}\\s*$`);
}

function quoteAttr(value: string): string {
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** Lesbare Form fuer Logs und Fehlermeldungen. */
export function describeSelector(spec: SelectorSpec): string {
  switch (spec.kind) {
    case 'testid':
      return `data-testid=${spec.value}`;
    case 'id':
      return `#${spec.value}`;
    case 'role':
      return `role=${spec.role}[name=${JSON.stringify(spec.name)}${spec.exact ? ' exact' : ''}]`;
    case 'text':
      return `text=${JSON.stringify(spec.value)}${spec.tag ? ` (<${spec.tag}>)` : ''}`;
    case 'css':
      return `css=${spec.value}`;
  }
}

/** Primaerselektor gefolgt von den Fallbacks, in Versuchsreihenfolge. */
export function selectorChain(set: SelectorSet): SelectorSpec[] {
  return [set.primary, ...set.fallbacks];
}
