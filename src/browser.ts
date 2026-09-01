/**
 * Browser-Kern: persistenter Chromium-Kontext plus Domain-Allowlist.
 *
 * Wichtig:
 *  - launchPersistentContext mit userDataDir profiles/<profile>. Damit ueberlebt
 *    ein manueller Login den Neustart, weil Cookies und LocalStorage im Profil
 *    liegen und nicht in einem Wegwerf-Kontext.
 *  - Die Allowlist greift ausschliesslich auf Hauptframe-Navigationen. Wuerde man
 *    auch Subframes blockieren, brechen Logins mit eingebettetem OAuth oder Captcha.
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { isAllowedUrl, loadConfig, type ResolvedConfig } from './config.js';
import { createLogger } from './log.js';
import { attachRecorder, type RecorderHandle } from './recorder.js';

const log = createLogger('browser');

export interface SessionOptions {
  profile: string;
  config?: ResolvedConfig;
  /** Sichtbar ist der Normalfall; headless nur fuer automatisierte Tests. */
  headless?: boolean;
  /** Wird nach dem Erstellen des Kontexts aufgerufen, bevor die erste Navigation laeuft. */
  onContextCreated?: (context: BrowserContext) => Promise<void> | void;
}

export interface Session {
  readonly context: BrowserContext;
  readonly config: ResolvedConfig;
  /**
   * Recorder. Binding und Init-Script sind bereits registriert; start/stop
   * schalten nur die Senke um.
   */
  readonly recorder: RecorderHandle;
  readonly profile: string;
  readonly profileDir: string;
  /** Die aktuell aktive Seite. Wechselt, wenn die Seite geschlossen oder eine neue geoeffnet wird. */
  page(): Page;
  goto(url: string, options?: { timeout?: number }): Promise<void>;
  close(): Promise<void>;
  /** Promise, das aufloest, wenn der Nutzer den Browser schliesst. */
  closed(): Promise<void>;
}

export class NavigationBlockedError extends Error {
  constructor(
    readonly url: string,
    readonly allowedDomains: readonly string[],
  ) {
    super(
      `Navigation nach ${url} abgelehnt: Domain steht nicht in der Allowlist ` +
        `(erlaubt: ${allowedDomains.join(', ') || '<leer>'}). ` +
        `Ergaenze die Domain in config.json unter "allowedDomains".`,
    );
    this.name = 'NavigationBlockedError';
  }
}

/** Wahr, wenn der Wert wie ein Profilname aussieht (keine Pfadtrenner, kein ..). */
export function isValidProfileName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && name !== '.' && name !== '..';
}

export function profileDirFor(config: ResolvedConfig, profile: string): string {
  if (!isValidProfileName(profile)) {
    throw new Error(
      `Ungueltiger Profilname "${profile}". Erlaubt sind Buchstaben, Ziffern, Punkt, Minus und Unterstrich.`,
    );
  }
  return resolve(join(config.profilesDirAbs, profile));
}

function envHeadless(): boolean | undefined {
  const raw = process.env['WEBPILOT_HEADLESS'];
  if (raw === undefined || raw === '') return undefined;
  return raw !== '0' && raw.toLowerCase() !== 'false';
}

/**
 * Haengt den Allowlist-Guard an den Kontext.
 *
 * ERSTE SCHICHT. Geprueft wird ein Request nur, wenn er eine Navigation ist und
 * keinen Elternframe hat. Alles andere faellt sofort durch (route.fallback
 * fuehrt den Request unveraendert aus, ohne ihn neu zu stellen). Subframes
 * bleiben unangetastet, sonst brechen Logins mit eingebettetem OAuth oder
 * Captcha.
 *
 * Diese Schicht allein reicht NICHT: Playwright setzt den Route-Handler bei
 * einem Server-Redirect nicht erneut an, der Folge-Request laeuft am Handler
 * vorbei (nachgemessen: 302 von einer erlaubten auf eine nicht gelistete Domain
 * kommt durch). Deshalb gibt es zusaetzlich installNavigationBackstop().
 */
export async function installAllowlistGuard(
  context: BrowserContext,
  allowedDomains: readonly string[],
): Promise<void> {
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (!request.isNavigationRequest()) return route.fallback();

    // request.frame() wirft bei Popup-Navigationen ("the request was issued
    // before the frame is created"). Ein solcher Request IST top-level.
    let isTopLevel = true;
    try {
      isTopLevel = request.frame().parentFrame() === null;
    } catch {
      isTopLevel = true;
    }
    if (!isTopLevel) return route.fallback();

    const url = request.url();
    if (isAllowedUrl(url, allowedDomains)) return route.fallback();

    log.warn(`Navigation blockiert: ${url}`);
    // 'aborted' statt 'blockedbyclient': letzteres laesst Chromium eine
    // Fehlerseite committen, die aktuelle Seite geht dabei verloren.
    await route.abort('aborted');
  });
}

/**
 * ZWEITE SCHICHT: Reissleine fuer alles, was am Route-Handler vorbeikommt -
 * Server-Redirects auf eine nicht gelistete Domain, Popups, exotische Schemata.
 * Committet der Hauptframe eine nicht erlaubte URL, wird die Seite sofort
 * verlassen und der Vorgang laut protokolliert.
 *
 * Grenze, ehrlich benannt: bei einem Redirect ist der GET auf das Ziel zu
 * diesem Zeitpunkt bereits gelaufen. Der Inhalt wird verworfen und nie
 * angezeigt oder bedient, aber die Anfrage hat stattgefunden.
 */
export function installNavigationBackstop(
  context: BrowserContext,
  allowedDomains: readonly string[],
): void {
  const leave = (page: Page, url: string, closePage: boolean): void => {
    log.error(
      `Nicht gelistete Domain erreicht: ${url} (vermutlich ueber einen Redirect). ` +
        (closePage ? 'Die Seite wird geschlossen.' : 'Die Seite wird sofort verlassen.'),
    );
    // Bei einem frisch geoeffneten Popup laeuft goto('about:blank') ins Leere -
    // die Erstnavigation ist noch in Arbeit. Ein Popup, das dort gar nicht sein
    // duerfte, wird deshalb einfach geschlossen. Das letzte Fenster bleibt
    // stehen, sonst faellt der ganze Kontext.
    const action = closePage && context.pages().length > 1 ? page.close() : page.goto('about:blank', { waitUntil: 'commit' });
    void Promise.resolve(action).catch((err: unknown) =>
      log.warn(`Verlassen der Seite fehlgeschlagen: ${(err as Error).message}`),
    );
  };

  const guard = (page: Page): void => {
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      if (isAllowedUrl(url, allowedDomains)) return;
      leave(page, url, false);
    });
    // Sofort mitpruefen: bei einem Popup ist die Erstnavigation bereits
    // committet, wenn das 'page'-Ereignis eintrifft - ein framenavigated dazu
    // kommt nicht mehr (nachgemessen). Ein target=_blank-Link auf einen
    // Redirector der erlaubten Domain landet sonst unbemerkt auf einer fremden.
    const current = page.url();
    if (current && !isAllowedUrl(current, allowedDomains)) leave(page, current, true);
  };
  for (const page of context.pages()) guard(page);
  context.on('page', guard);
}

export async function createSession(options: SessionOptions): Promise<Session> {
  const config = options.config ?? loadConfig();
  const profileDir = profileDirFor(config, options.profile);
  mkdirSync(profileDir, { recursive: true });

  const headless = options.headless ?? envHeadless() ?? false;
  log.info(`Starte Chromium (profil=${options.profile}, headless=${headless}) aus ${profileDir}`);

  const context = await chromium.launchPersistentContext(profileDir, {
    headless,
    // Im sichtbaren Modus soll die Fenstergroesse gelten, nicht ein fixer Viewport.
    viewport: headless ? { width: 1280, height: 900 } : null,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      // Die Allowlist regelt Navigationen. Chromium telefoniert daneben von
      // sich aus nach Hause (Autofill-Daten, Komponenten-Updates, Sync,
      // Domain Reliability) - das hat mit der Absicht des Nutzers nichts zu
      // tun und wird hier abgeschaltet, damit der Browser nicht hinter dem
      // Ruecken des Nutzers mit Dritten spricht.
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-domain-reliability',
      '--disable-sync',
      '--no-service-autorun',
    ],
  });

  await installAllowlistGuard(context, config.allowedDomains);
  installNavigationBackstop(context, config.allowedDomains);
  // Recorder GENAU EINMAL pro Kontext anhaengen: exposeBinding wirft beim
  // zweiten Aufruf mit demselben Namen.
  const recorder = await attachRecorder(context, config);
  await options.onContextCreated?.(context);

  // launchPersistentContext liefert normalerweise bereits eine Seite (about:blank).
  let current: Page = context.pages()[0] ?? (await context.newPage());
  context.on('page', (p) => {
    current = p;
  });
  current.on('close', () => {
    const next = context.pages().at(-1);
    if (next) current = next;
  });

  let closeResolve: () => void = () => {};
  const closedPromise = new Promise<void>((res) => {
    closeResolve = res;
  });
  context.on('close', () => {
    log.info('Browser-Kontext geschlossen');
    closeResolve();
  });

  const session: Session = {
    context,
    config,
    recorder,
    profile: options.profile,
    profileDir,
    page: () => {
      if (current.isClosed()) {
        const next = context.pages().at(-1);
        if (next) current = next;
      }
      return current;
    },
    async goto(url, gotoOptions) {
      if (!isAllowedUrl(url, config.allowedDomains)) {
        throw new NavigationBlockedError(url, config.allowedDomains);
      }
      log.info(`goto ${url}`);
      const page = session.page();
      await page.goto(url, { waitUntil: 'domcontentloaded', ...gotoOptions });
    },
    async close() {
      await context.close();
    },
    closed: () => closedPromise,
  };

  return session;
}
