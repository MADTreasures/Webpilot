/**
 * End-to-End-Test gegen einen echten Chromium.
 *
 * Geprueft wird das, was sich nur im Browser pruefen laesst: Profil-Persistenz,
 * die Allowlist auf Haupt- und Subframes, der Recorder gegen die lokale
 * Login-Seite und der Replay - inklusive Fallback-Selektoren, fehlender
 * Secrets und iframes mit wechselnder Nonce in der URL.
 *
 * Alle Artefakte landen unter .tmp-test/, damit profiles/ und flows/ des
 * Projekts unberuehrt bleiben.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSession } from '../dist/browser.js';
import { loadConfig } from '../dist/config.js';
import { ReplayError, replayFlow } from '../dist/replay.js';
import { startTestServer } from './server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const TMP = resolve(ROOT, '.tmp-test');
const config = loadConfig(resolve(TMP, 'config.json'));
const PORT = Number(process.env.PORT ?? 8795);

let fails = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) fails++;
};
const section = (title) => console.log(`\n--- ${title} ---`);

rmSync(config.profilesDirAbs, { recursive: true, force: true });
rmSync(config.flowsDirAbs, { recursive: true, force: true });
rmSync(config.screenshotsDirAbs, { recursive: true, force: true });

const { server, origin } = await startTestServer(PORT);
const open = (profile) => createSession({ profile, config, headless: true });

try {
  /* ================= Browser-Kern ================= */
  section('Browser-Kern: Profil und Allowlist');
  {
    let s = await open('kern');
    await s.goto(`${origin}/`);
    check('goto auf erlaubte Domain', s.page().url() === `${origin}/`, s.page().url());

    await s.page().evaluate(() => {
      localStorage.setItem('webpilot-probe', 'bleibt');
      document.cookie = 'wpsession=abc123; path=/; max-age=3600';
    });

    let blocked = false;
    try {
      await s.goto(`http://localhost:${PORT}/about`);
    } catch (err) {
      blocked = err.name === 'NavigationBlockedError';
    }
    check('goto auf nicht gelistete Domain wirft NavigationBlockedError', blocked);

    await s.page().evaluate((u) => {
      location.href = u;
    }, `http://localhost:${PORT}/about`);
    await s.page().waitForTimeout(1500);
    check('In-Page-Navigation auf nicht gelistete Domain wird geblockt',
      !s.page().url().includes(`localhost:${PORT}`), s.page().url());

    // Geblockte Navigation darf die aktuelle Seite nicht zerstoeren.
    await s.goto(`${origin}/about`);
    const before = s.page().url();
    await s.page().evaluate((u) => { location.href = u; }, `http://localhost:${PORT}/about`);
    await s.page().waitForTimeout(1200);
    check('geblockte Navigation laesst die aktuelle Seite stehen',
      s.page().url() === before, `${before} -> ${s.page().url()}`);

    // Server-Redirect von einer erlaubten auf eine nicht gelistete Domain:
    // der Route-Handler sieht den Folge-Request nicht, der Backstop schon.
    await s.goto(`${origin}/`);
    await s.page()
      .goto(`${origin}/redirect?to=${encodeURIComponent(`http://localhost:${PORT}/about`)}`, { waitUntil: 'domcontentloaded' })
      .catch(() => undefined);
    await s.page().waitForTimeout(2000);
    check('Redirect auf eine nicht gelistete Domain wird nicht gehalten',
      !s.page().url().startsWith(`http://localhost:${PORT}`), s.page().url());

    await s.goto(`${origin}/embed?src=${encodeURIComponent(`http://localhost:${PORT}/about`)}`);
    await s.page().waitForTimeout(1200);
    const subText = await s.page().frameLocator('#embedded').locator('h1').textContent().catch((e) => `ERR ${e}`);
    check('iframe auf nicht gelistete Domain laedt trotzdem (OAuth/Captcha)',
      String(subText).includes('Über'), JSON.stringify(subText));
    await s.close();

    s = await open('kern');
    await s.goto(`${origin}/`);
    const probe = await s.page().evaluate(() => localStorage.getItem('webpilot-probe'));
    const cookies = await s.context.cookies();
    check('localStorage ueberlebt den Neustart', probe === 'bleibt', String(probe));
    check('Cookie ueberlebt den Neustart',
      cookies.some((c) => c.name === 'wpsession' && c.value === 'abc123'));
    await s.close();
  }

  /* ================= Recorder ================= */
  section('Recorder: Klick-Login');
  let clickFlow = '';
  {
    const s = await open('rec');
    await s.recorder.start('login-klick');
    await s.goto(`${origin}/`);
    const p = s.page();
    await p.locator('#user').click();
    await p.keyboard.type('demo', { delay: 10 });
    await p.locator('#password').click();
    await p.keyboard.type('s3cr3t', { delay: 10 });
    await p.locator('#remember').click();
    await p.getByTestId('login-submit').click();
    await p.waitForURL('**/welcome*', { timeout: 15000 });
    await p.waitForTimeout(400);
    const res = await s.recorder.stop();
    await s.close();

    clickFlow = readFileSync(res.path, 'utf8');
    const lines = clickFlow.trim().split('\n').map((l) => JSON.parse(l));
    check('Passwort steht nirgends im Klartext', !clickFlow.includes('s3cr3t'));
    const pw = lines.find((e) => e.kind === 'fill' && e.target?.isPassword);
    check('Passwortwert ist {{secret:password}}', pw?.value === '{{secret:password}}' && pw.secret === true, String(pw?.value));
    check('input-Events koaleszieren: genau ein fill je Feld',
      lines.filter((e) => e.kind === 'fill').length === 2, String(lines.filter((e) => e.kind === 'fill').length));
    check('ein kompletter Login bleibt unter 12 JSONL-Zeilen', lines.length < 12, `${lines.length} Zeilen`);
    check('jedes Element traegt genau zwei Fallback-Selektoren',
      lines.filter((e) => e.target).every((e) => e.target.selectors.fallbacks.length === 2));
    check('Selektor-Prioritaet: data-testid schlaegt id',
      lines.find((e) => e.kind === 'click' && e.target?.tag === 'button')?.target.selectors.primary.kind === 'testid');
    check('Fallbacks kommen aus anderen Strategien als der Primaerselektor',
      lines.filter((e) => e.target).every((e) => {
        const kinds = [e.target.selectors.primary, ...e.target.selectors.fallbacks].map((sel) =>
          sel.kind === 'css' ? `css:${sel.value}` : sel.kind);
        return new Set(kinds).size === kinds.length;
      }));
    const submit = lines.find((e) => e.kind === 'submit');
    check('submit ist ueber SubmitEvent.submitter kausal zugeordnet',
      submit?.causeKind === 'submitter' && lines.some((e) => e.id === submit.causedBy && e.kind === 'click'));
    // Der Buttontext im Markup ist umbrochen. Aufgezeichnet wird er mit
    // normalisiertem Whitespace - der Textselektor muss trotzdem greifen.
    const btn = lines.find((e) => e.kind === 'click' && e.target?.tag === 'button');
    const textSel = [btn?.target.selectors.primary, ...(btn?.target.selectors.fallbacks ?? [])]
      .find((sel) => sel?.kind === 'text');
    check('mehrzeiliger Buttontext wird normalisiert aufgezeichnet',
      textSel?.value === 'Anmelden und weiter', JSON.stringify(textSel));
  }

  section('Recorder: Enter im iframe mit wechselnder Nonce');
  let recordedFrameUrl = '';
  {
    const s = await open('recframe');
    await s.recorder.start('login-frame');
    await s.goto(`${origin}/framed`);
    const p = s.page();
    const f = p.frameLocator('#login-frame');
    await f.locator('#user').click();
    await p.keyboard.type('demo', { delay: 10 });
    await f.locator('#password').click();
    await p.keyboard.type('s3cr3t', { delay: 10 });
    await p.keyboard.press('Enter');
    await p.waitForTimeout(900);
    const res = await s.recorder.stop();
    await s.close();

    const lines = readFileSync(res.path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const inFrame = lines.filter((e) => e.frame.path.length === 1);
    recordedFrameUrl = inFrame[0]?.frame.url ?? '';
    check('Ereignisse im iframe tragen eine Frame-Kette', inFrame.length >= 4, `${inFrame.length}`);
    check('die Kette benennt das iframe-ELEMENT, nicht die Frame-URL',
      inFrame[0]?.frame.path[0]?.primary.kind === 'id' && !JSON.stringify(inFrame[0].frame.path).includes('/frame/'),
      JSON.stringify(inFrame[0]?.frame.path[0]?.primary));
    const press = lines.find((e) => e.kind === 'press');
    check('Enter-Keydown aufgezeichnet', press?.key === 'Enter');
    check('der vom Browser erzeugte Default-Button-Klick ist als Folge markiert',
      lines.some((e) => e.kind === 'click' && e.causeKind === 'implicit-activation' && e.causedBy === press?.id));
    check('kein doppeltes fill fuer dasselbe Feld',
      lines.filter((e) => e.kind === 'fill' && e.target?.isPassword).length === 1);
  }

  section('Recorder: Formular in einer offenen Shadow-Root');
  {
    const s = await open('recshadow');
    await s.recorder.start('login-shadow');
    await s.goto(`${origin}/shadow`);
    const p = s.page();
    // change und submit sind composed:false und erreichen document nicht -
    // der Recorder muss die Shadow-Root selbst mit Listenern versorgen.
    await p.locator('shadow-login #u').click();
    await p.keyboard.type('demo', { delay: 10 });
    await p.locator('shadow-login #p').click();
    await p.keyboard.type('s3cr3t', { delay: 10 });
    await p.locator('shadow-login [data-testid="shadow-submit"]').click();
    await p.waitForURL('**/welcome*', { timeout: 15000 });
    await p.waitForTimeout(400);
    const res = await s.recorder.stop();
    await s.close();

    const lines = readFileSync(res.path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    check('Eingaben in der Shadow-Root werden erfasst',
      lines.filter((e) => e.kind === 'fill').length === 2, String(lines.filter((e) => e.kind === 'fill').length));
    check('Passwort in der Shadow-Root ist maskiert',
      lines.some((e) => e.kind === 'fill' && e.value === '{{secret:password}}') && !JSON.stringify(lines).includes('s3cr3t'));
    check('submit aus der Shadow-Root wird trotz composed:false erfasst',
      lines.some((e) => e.kind === 'submit' && e.causeKind === 'submitter'),
      JSON.stringify(lines.filter((e) => e.kind === 'submit').map((e) => e.causeKind)));
    check('Selektor durchdringt die Shadow-Grenze',
      lines.some((e) => e.target?.selectors && JSON.stringify(e.target.selectors).includes('shadow-login')) ||
        lines.some((e) => e.target?.selectors.primary.kind === 'testid'),
      JSON.stringify(lines.find((e) => e.kind === 'fill')?.target.selectors));
  }

  {
    const s = await open('playshadow');
    await replayFlow(s, config, 'login-shadow', { env: { WEBPILOT_SECRET_PASSWORD: 's3cr3t' } });
    const who = await s.page().locator('[data-testid="who"]').textContent().catch(() => null);
    await s.close();
    check('Shadow-DOM-Login laesst sich wiederholen', who === 'demo', String(who));
  }

  section('Sonderfaelle: aria-hidden, :text-is, Enter auf einem Link, Autofill');
  {
    const s = await open('tricky');
    await s.recorder.start('tricky');
    await s.goto(`${origin}/tricky`);
    const p = s.page();

    await p.locator('#ariah-1').click();
    await p.locator('.karte').first().click();

    // Zwei Felder per Skript fuellen, wie es ein Passwortmanager tut:
    // synthetische input-Events, kein change, kein Klick dazwischen.
    await p.evaluate(() => {
      const u = document.getElementById('auto-user');
      const pw = document.getElementById('auto-pass');
      u.value = 'autodemo';
      u.dispatchEvent(new Event('input', { bubbles: true }));
      pw.value = 'autogeheim';
      pw.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await p.getByTestId('auto-submit').click();
    await p.waitForURL('**/denied', { timeout: 15000 });
    await p.goBack();
    await p.waitForTimeout(300);

    // Enter auf einem fokussierten Link: EINE Nutzeraktion.
    await p.locator('#enter-link').focus();
    await p.keyboard.press('Enter');
    await p.waitForURL('**/about', { timeout: 15000 });
    await p.waitForTimeout(300);

    const res = await s.recorder.stop();
    await s.close();
    const lines = readFileSync(res.path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

    const ariaClick = lines.find((e) => e.kind === 'click' && e.target?.tag === 'button' && e.target.accessibleName.startsWith('Weiter'));
    check('aria-hidden zaehlt nicht zum Accessible Name',
      ariaClick?.target.accessibleName === 'Weiter', JSON.stringify(ariaClick?.target.accessibleName));

    const karteClick = lines.find((e) => e.kind === 'click' && e.target?.tag === 'div');
    const karteChain = karteClick ? [karteClick.target.selectors.primary, ...karteClick.target.selectors.fallbacks] : [];
    check('mehrdeutiger Textselektor wird nicht Primaerselektor',
      karteClick && karteClick.target.selectors.primary.kind !== 'text', JSON.stringify(karteChain[0]));

    const autoFills = lines.filter((e) => e.kind === 'fill' && ['user', 'password'].includes(e.target?.fieldName));
    check('Autofill: BEIDE Feldwerte werden erfasst, keiner verdraengt den anderen',
      autoFills.length === 2 && autoFills[0].value === 'autodemo' && autoFills[1].value === '{{secret:password}}',
      JSON.stringify(autoFills.map((e) => e.value)));
    check('per Skript gefuelltes Passwort steht nicht im Klartext',
      !JSON.stringify(lines).includes('autogeheim'));

    const linkPress = lines.find((e) => e.kind === 'press' && e.target?.tag === 'a');
    const linkClick = lines.find((e) => e.kind === 'click' && e.target?.tag === 'a');
    check('Enter auf einem Link wird als press aufgezeichnet', !!linkPress, String(linkPress?.key));
    check('der vom Browser erzeugte Aktivierungs-Klick auf den Link ist als Folge markiert',
      !!linkClick && linkClick.causedBy === linkPress?.id && linkClick.causeKind === 'implicit-activation',
      JSON.stringify({ c: linkClick?.causedBy, k: linkClick?.causeKind }));
  }

  section('Verzoegerte Navigation');
  {
    const s = await open('slowrec');
    await s.recorder.start('slow');
    await s.goto(`${origin}/tricky`);
    await s.page().getByTestId('slow-go').click();
    await s.page().waitForURL('**/welcome*', { timeout: 15000 });
    await s.page().waitForTimeout(300);
    await s.recorder.stop();
    await s.close();

    const s2 = await open('slowplay');
    await replayFlow(s2, config, 'slow', { env: {} });
    const url = s2.page().url();
    const who = await s2.page().locator('[data-testid="who"]').textContent().catch(() => null);
    await s2.close();
    check('Replay wartet auf eine erst verzoegert ausgeloeste Navigation',
      url.includes('/welcome') && who === 'langsam', `${url} / ${who}`);
  }

  /* ================= Replay ================= */
  section('Replay');
  {
    const s = await open('play');
    const result = await replayFlow(s, config, 'login-klick', { env: { WEBPILOT_SECRET_PASSWORD: 's3cr3t' } });
    const who = await s.page().locator('[data-testid="who"]').textContent().catch(() => null);
    await s.close();
    check('Replay laeuft durch und der Server akzeptiert die Zugangsdaten', who === 'demo', String(who));
    check('Folge-Navigation wurde uebersprungen statt erneut ausgefuehrt',
      result.steps.filter((x) => x.kind === 'navigate' && x.status === 'uebersprungen').length >= 1);
    check('submit wurde uebersprungen - kein Doppel-Absenden',
      result.steps.some((x) => x.kind === 'submit' && x.status === 'uebersprungen'));
  }

  {
    const s = await open('nosecret');
    let err = null;
    try {
      await replayFlow(s, config, 'login-klick', { env: {} });
    } catch (e) {
      err = e;
    }
    const typed = await s.page().locator('#password').inputValue().catch(() => '<weg>');
    await s.close();
    check('fehlendes Secret bricht ab', err instanceof ReplayError);
    check('Fehlermeldung nennt die erwartete Umgebungsvariable',
      String(err?.message).includes('WEBPILOT_SECRET_PASSWORD'));
    check('der Platzhalter wird nicht ins Formular getippt', typed !== '{{secret:password}}', JSON.stringify(typed));
    check('Screenshot wurde geschrieben', !!err?.screenshot && existsSync(err.screenshot));
  }

  {
    const lines = clickFlow.trim().split('\n').map((l) => JSON.parse(l));
    for (const e of lines) {
      if (e.target) e.target.selectors.primary = { kind: 'testid', value: `weg-${e.index}` };
    }
    writeFileSync(`${config.flowsDirAbs}/login-fallback.jsonl`, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    const s = await open('fallback');
    await replayFlow(s, config, 'login-fallback', {
      env: { WEBPILOT_SECRET_PASSWORD: 's3cr3t' },
      timeout: 2000,
      fallbackTimeout: 2000,
    });
    const who = await s.page().locator('[data-testid="who"]').textContent().catch(() => null);
    await s.close();
    check('kaputte Primaerselektoren werden von den Fallbacks aufgefangen', who === 'demo', String(who));
  }

  {
    // Nur der Textselektor bleibt uebrig: greift er trotz umbrochenem Markup?
    const lines = clickFlow.trim().split('\n').map((l) => JSON.parse(l));
    let usedText = false;
    for (const e of lines) {
      if (e.kind !== 'click' || e.target?.tag !== 'button') continue;
      const all = [e.target.selectors.primary, ...e.target.selectors.fallbacks];
      const textSel = all.find((sel) => sel.kind === 'text');
      if (!textSel) continue;
      e.target.selectors = { primary: textSel, fallbacks: [], unique: true };
      usedText = true;
    }
    writeFileSync(`${config.flowsDirAbs}/login-text.jsonl`, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    const s = await open('textsel');
    await replayFlow(s, config, 'login-text', { env: { WEBPILOT_SECRET_PASSWORD: 's3cr3t' } });
    const who = await s.page().locator('[data-testid="who"]').textContent().catch(() => null);
    await s.close();
    check('Textselektor auf mehrzeiligem Buttontext trifft beim Replay', usedText && who === 'demo', String(who));
  }

  {
    const lines = clickFlow.trim().split('\n').map((l) => JSON.parse(l));
    for (const e of lines) {
      if (e.target) {
        e.target.selectors = {
          primary: { kind: 'testid', value: 'weg-1' },
          fallbacks: [{ kind: 'id', value: 'weg-2' }, { kind: 'css', value: 'div.weg-3' }],
          unique: true,
        };
      }
    }
    writeFileSync(`${config.flowsDirAbs}/login-kaputt.jsonl`, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    const s = await open('kaputt');
    let err = null;
    try {
      await replayFlow(s, config, 'login-kaputt', {
        env: { WEBPILOT_SECRET_PASSWORD: 's3cr3t' },
        timeout: 1500,
        fallbackTimeout: 1000,
      });
    } catch (e) {
      err = e;
    }
    await s.close();
    check('alle Selektoren kaputt -> ReplayError', err instanceof ReplayError);
    check('die Meldung listet alle drei Versuche einzeln', (err?.attempts ?? []).length === 3);
    check('die Meldung nennt Ereignis-Index, beide URLs und den Screenshot',
      /Ereignis #\d+/.test(err?.message ?? '') &&
        (err?.message ?? '').includes('Aktuelle URL') &&
        !!err?.screenshot && existsSync(err.screenshot));
  }

  {
    const s = await open('playframe');
    await replayFlow(s, config, 'login-frame', { env: { WEBPILOT_SECRET_PASSWORD: 's3cr3t' } });
    const p = s.page();
    await p.waitForTimeout(600);
    const inner = await p.frameLocator('#login-frame').locator('[data-testid="who"]').textContent().catch(() => null);
    await s.close();
    check('aufgezeichnete Frame-URL trug eine Nonce', /\/frame\/\w+/.test(recordedFrameUrl), recordedFrameUrl);
    check('Login im iframe laesst sich trotz neuer Nonce wiederholen', inner === 'demo', String(inner));
  }
} finally {
  server.close();
}

console.log(fails === 0 ? '\nALLE E2E-CHECKS BESTANDEN' : `\n${fails} E2E-CHECK(S) FEHLGESCHLAGEN`);
process.exit(fails === 0 ? 0 : 1);
