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
 * Umgesetzt ueber context.route: nur Requests, die eine Navigation des
 * Hauptframes sind, werden geprueft. Alles andere faellt sofort durch
 * (route.fallback fuehrt den Request unveraendert aus, ohne ihn neu zu stellen).
 * Redirects erzeugen jeweils einen neuen Navigations-Request und werden dadurch
 * ebenfalls geprueft.
 */
export async function installAllowlistGuard(
  context: BrowserContext,
  allowedDomains: readonly string[],
): Promise<void> {
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (!request.isNavigationRequest()) return route.fallback();

    const frame = request.frame();
    // Nur der Hauptframe hat keinen Elternframe. Subframes bleiben unangetastet.
    if (frame.parentFrame() !== null) return route.fallback();

    const url = request.url();
    if (isAllowedUrl(url, allowedDomains)) return route.fallback();

    log.warn(`Navigation blockiert: ${url}`);
    await route.abort('blockedbyclient');
  });
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
    args: ['--no-first-run', '--no-default-browser-check'],
  });

  await installAllowlistGuard(context, config.allowedDomains);
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
