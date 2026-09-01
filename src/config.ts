/**
 * config.json laden und die Domain-Allowlist auswerten.
 *
 * Die Allowlist wird bewusst nur auf Hauptframe-Navigationen angewendet
 * (siehe browser.ts): blockiert man auch Subframes, brechen Logins mit
 * eingebettetem OAuth oder Captcha.
 */
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const ConfigSchema = z.object({
  allowedDomains: z.array(z.string().min(1)).default(['localhost', '127.0.0.1']),
  profilesDir: z.string().default('profiles'),
  flowsDir: z.string().default('flows'),
  screenshotsDir: z.string().default('screenshots'),
  logBufferSize: z.number().int().positive().default(500),
});

export type Config = z.infer<typeof ConfigSchema>;

export interface ResolvedConfig extends Config {
  /** Wurzelverzeichnis, auf das die relativen Pfade oben bezogen sind. */
  rootDir: string;
  configPath: string;
  profilesDirAbs: string;
  flowsDirAbs: string;
  screenshotsDirAbs: string;
}

/** Projektwurzel: eine Ebene ueber dist/ bzw. src/. */
export function projectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

export function loadConfig(configPath?: string): ResolvedConfig {
  const root = projectRoot();
  const path = configPath
    ? isAbsolute(configPath)
      ? configPath
      : resolve(process.cwd(), configPath)
    : join(root, 'config.json');

  let raw: unknown = {};
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw new Error(`config.json konnte nicht gelesen werden (${path}): ${(err as Error).message}`);
    }
    // Ohne config.json gelten die Defaults aus dem Schema.
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`config.json ist ungueltig (${path}): ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }

  const base = dirname(path);
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(base, p));
  return {
    ...parsed.data,
    rootDir: base,
    configPath: path,
    profilesDirAbs: abs(parsed.data.profilesDir),
    flowsDirAbs: abs(parsed.data.flowsDir),
    screenshotsDirAbs: abs(parsed.data.screenshotsDir),
  };
}

/**
 * Prueft eine URL gegen die Allowlist.
 *
 * Regeln:
 *  - Eintrag `example.com` erlaubt `example.com` und jede Subdomain davon.
 *  - Eintrag `*.example.com` erlaubt nur Subdomains, nicht die Apex-Domain.
 *  - Eintrag `*` erlaubt alles (bewusst explizit).
 *  - `about:blank`, `about:srcdoc` und `chrome-error://` sind immer erlaubt:
 *    das sind interne Zustaende, keine echten Navigationen.
 *  - Nicht-HTTP(S)-Schemata (file:, data:, javascript:) sind nie erlaubt.
 */
export function isAllowedUrl(url: string, allowedDomains: readonly string[]): boolean {
  if (url === '' || url === 'about:blank' || url === 'about:srcdoc') return true;
  if (url.startsWith('chrome-error://')) return true;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  return allowedDomains.some((entry) => matchesDomain(host, entry));
}

function matchesDomain(host: string, entry: string): boolean {
  const pattern = entry.trim().toLowerCase().replace(/\.$/, '');
  if (pattern === '') return false;
  if (pattern === '*') return true;
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    return suffix !== '' && host.endsWith(`.${suffix}`);
  }
  return host === pattern || host.endsWith(`.${pattern}`);
}
