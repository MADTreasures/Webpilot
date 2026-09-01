/**
 * Sprechtest fuer den MCP-Server: startet `node dist/cli.js mcp` als
 * Kindprozess und redet mit ihm ueber stdio - mit dem echten SDK-Client.
 * Geprueft werden tools/list, ein Happy Path und eine Reihe Fehlerfaelle.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { startTestServer } from './server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PORT = Number(process.env.PORT ?? 8801);

let fails = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) fails++;
};
const textOf = (res) => (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

const { server: httpServer, origin } = await startTestServer(PORT);
const TMP = resolve(ROOT, '.tmp-test');
rmSync(resolve(TMP, 'profiles/mcptest'), { recursive: true, force: true });
rmSync(resolve(TMP, 'flows/mcp-login.jsonl'), { force: true });

const transport = new StdioClientTransport({
  command: process.execPath,
  // Eigene Konfiguration: profiles/, flows/ und screenshots/ des Projekts
  // bleiben unberuehrt, die Allowlist deckt genau die Testseite ab.
  args: ['dist/cli.js', 'mcp', '--profile', 'mcptest', '--config', '.tmp-test/config.json'],
  cwd: ROOT,
  stderr: 'pipe',
  env: {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? '',
    DISPLAY: process.env.DISPLAY ?? '',
    WEBPILOT_HEADLESS: process.env.WEBPILOT_HEADLESS ?? '1',
    WEBPILOT_SECRET_PASSWORD: 's3cr3t',
  },
});
const serverLog = [];
transport.stderr?.on('data', (chunk) => serverLog.push(String(chunk)));

const client = new Client({ name: 'webpilot-test', version: '0.1.0' }, { capabilities: {} });
await client.connect(transport);

try {
  /* ---------- tools/list ---------- */
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  const expected = [
    'browser_click', 'browser_open', 'browser_screenshot', 'browser_snapshot', 'browser_type',
    'flow_list', 'flow_run', 'log_tail', 'record_start', 'record_stop',
  ];
  check('tools/list liefert genau die geforderten Tools', JSON.stringify(names) === JSON.stringify(expected), names.join(','));
  check('jedes Tool hat ein JSON-Schema fuer die Eingabe', tools.every((t) => t.inputSchema?.type === 'object'));
  const clickTool = tools.find((t) => t.name === 'browser_click');
  check('browser_click verlangt ref', clickTool?.inputSchema?.required?.includes('ref') === true,
    JSON.stringify(clickTool?.inputSchema?.required));

  /* ---------- Fehlerfaelle ohne Browser ---------- */
  const noBrowser = await client.callTool({ name: 'browser_snapshot', arguments: {} });
  check('browser_snapshot ohne offenen Browser -> Tool-Error', noBrowser.isError === true && textOf(noBrowser).includes('browser_open'), textOf(noBrowser));

  const badName = await client.callTool({ name: 'record_start', arguments: { name: '../boese' } });
  check('record_start mit Pfad im Namen -> Tool-Error', badName.isError === true, textOf(badName).split('\n')[0]);

  const missingArg = await client.callTool({ name: 'browser_click', arguments: {} });
  check('fehlender Pflichtparameter -> Tool-Error (zod)', missingArg.isError === true, textOf(missingArg).split('\n')[0]);

  const wrongType = await client.callTool({ name: 'log_tail', arguments: { n: 'viele' } });
  check('falscher Parametertyp -> Tool-Error (zod)', wrongType.isError === true, textOf(wrongType).split('\n')[0]);

  const outOfRange = await client.callTool({ name: 'log_tail', arguments: { n: 0 } });
  check('Wert ausserhalb des erlaubten Bereichs -> Tool-Error', outOfRange.isError === true, textOf(outOfRange).split('\n')[0]);

  const blocked = await client.callTool({ name: 'browser_open', arguments: { url: 'https://example.com/' } });
  check('browser_open auf nicht gelistete Domain -> Tool-Error', blocked.isError === true && textOf(blocked).includes('Allowlist'), textOf(blocked).split('\n')[0]);

  const unknownFlow = await client.callTool({ name: 'flow_run', arguments: { name: 'gibt-es-nicht' } });
  check('flow_run mit unbekanntem Flow -> Tool-Error', unknownFlow.isError === true && textOf(unknownFlow).includes('nicht gefunden'), textOf(unknownFlow).split('\n')[0]);

  /* ---------- Happy Path ---------- */
  const opened = await client.callTool({ name: 'browser_open', arguments: { url: `${origin}/` } });
  check('browser_open oeffnet die erlaubte Seite', !opened.isError && textOf(opened).includes(`${origin}/`), textOf(opened).split('\n')[1]);

  const stopWithout = await client.callTool({ name: 'record_stop', arguments: {} });
  check('record_stop ohne laufende Aufnahme -> Tool-Error', stopWithout.isError === true, textOf(stopWithout).split('\n')[0]);

  const started = await client.callTool({ name: 'record_start', arguments: { name: 'mcp-login' } });
  check('record_start startet die Aufnahme', !started.isError, textOf(started).split('\n')[0]);

  const twice = await client.callTool({ name: 'record_start', arguments: { name: 'mcp-login2' } });
  check('zweites record_start -> Tool-Error statt exposeBinding-Absturz', twice.isError === true, textOf(twice).split('\n')[0]);

  const snap1 = await client.callTool({ name: 'browser_snapshot', arguments: {} });
  const snapText = textOf(snap1);
  check('browser_snapshot liefert refs', !snap1.isError && /\[ref=e\d+\]/.test(snapText));
  const refFor = (re) => (snapText.match(re) ?? [])[1];
  const userRef = refFor(/textbox "Benutzername"[^\n]*\[ref=(\S+?)\]/);
  const passRef = refFor(/textbox "Passwort"[^\n]*\[ref=(\S+?)\]/);
  const btnRef = refFor(/button "Anmelden[^"]*"[^\n]*\[ref=(\S+?)\]/);
  check('Snapshot benennt die Formularelemente', !!userRef && !!passRef && !!btnRef, `${userRef}/${passRef}/${btnRef}`);

  const badRef = await client.callTool({ name: 'browser_click', arguments: { ref: 'nicht-echt' } });
  check('ungueltiges ref-Format -> Tool-Error', badRef.isError === true && textOf(badRef).includes('browser_snapshot'), textOf(badRef).split('\n')[0]);

  const t1 = await client.callTool({ name: 'browser_type', arguments: { ref: userRef, text: 'demo' } });
  check('browser_type schreibt in das Benutzerfeld', !t1.isError, textOf(t1));
  const t2 = await client.callTool({ name: 'browser_type', arguments: { ref: passRef, text: 's3cr3t' } });
  check('browser_type schreibt in das Passwortfeld', !t2.isError, textOf(t2));

  const shot = await client.callTool({ name: 'browser_screenshot', arguments: {} });
  const image = (shot.content ?? []).find((c) => c.type === 'image');
  check('browser_screenshot liefert ein PNG', !shot.isError && image?.mimeType === 'image/png' && image.data.length > 1000,
    `${image?.mimeType} ${image?.data?.length ?? 0} b64-Zeichen`);
  check('Screenshot ist echtes PNG (Magic Bytes)', Buffer.from(image?.data ?? '', 'base64').subarray(0, 4).toString('hex') === '89504e47');

  const clicked = await client.callTool({ name: 'browser_click', arguments: { ref: btnRef } });
  check('browser_click sendet das Formular ab', !clicked.isError && textOf(clicked).includes('/welcome'), textOf(clicked).split('\n')[1]);

  const staleRef = await client.callTool({ name: 'browser_click', arguments: { ref: btnRef } });
  check('ref nach Navigation -> Tool-Error mit Hinweis auf neuen Snapshot',
    staleRef.isError === true && textOf(staleRef).includes('browser_snapshot'), textOf(staleRef).split('\n')[0]);
  check('der Fehler nennt den Grund (Referenzen werden pro Dokument neu vergeben)',
    textOf(staleRef).includes('neues Dokument'), textOf(staleRef).slice(0, 90));

  const stopped = await client.callTool({ name: 'record_stop', arguments: {} });
  check('record_stop schreibt den Flow', !stopped.isError && textOf(stopped).includes('mcp-login.jsonl'), textOf(stopped));

  const flowLines = readFileSync(resolve(TMP, 'flows/mcp-login.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  check('auf offener Seite gestartete Aufnahme haelt den Startpunkt fest',
    flowLines[0]?.kind === 'navigate' && flowLines[0].url === `${origin}/`, JSON.stringify(flowLines[0]?.kind));
  check('Passwort steht auch im MCP-Mitschnitt nicht im Klartext',
    !JSON.stringify(flowLines).includes('s3cr3t') && JSON.stringify(flowLines).includes('{{secret:password}}'));

  const list = await client.callTool({ name: 'flow_list', arguments: {} });
  check('flow_list zeigt den frisch aufgezeichneten Flow', !list.isError && textOf(list).includes('mcp-login'), textOf(list).split('\n').slice(0,3).join(' | '));

  /* ---------- Definition of Done: aufgezeichneter Login per flow_run ---------- */
  await client.callTool({ name: 'browser_open', arguments: { url: `${origin}/about` } });
  const run = await client.callTool({ name: 'flow_run', arguments: { name: 'mcp-login' } });
  const runText = textOf(run);
  check('flow_run wiederholt den aufgezeichneten Login fehlerfrei', !run.isError && runText.includes('/welcome'), runText.split('\n').slice(0, 2).join(' | '));

  const verify = await client.callTool({ name: 'browser_snapshot', arguments: {} });
  check('nach flow_run steht der eingeloggte Zustand auf dem Schirm',
    !verify.isError && textOf(verify).includes('Willkommen, demo'), textOf(verify).split('\n')[0]);

  /* ---------- Passwoerter duerfen nicht im Snapshot stehen ---------- */
  await client.callTool({ name: 'browser_open', arguments: { url: `${origin}/` } });
  const s1 = await client.callTool({ name: 'browser_snapshot', arguments: {} });
  const r1 = (textOf(s1).match(/textbox "Benutzername"[^\n]*\[ref=(\S+?)\]/) ?? [])[1];
  const r2 = (textOf(s1).match(/textbox "Passwort"[^\n]*\[ref=(\S+?)\]/) ?? [])[1];
  await client.callTool({ name: 'browser_type', arguments: { ref: r1, text: 'demo' } });
  await client.callTool({ name: 'browser_type', arguments: { ref: r2, text: 'streng-geheim-42' } });
  const s2 = await client.callTool({ name: 'browser_snapshot', arguments: {} });
  const filled = textOf(s2);
  check('Snapshot zeigt den Wert eines normalen Feldes', filled.includes('demo'));
  check('Snapshot zeigt das Passwort NICHT im Klartext', !filled.includes('streng-geheim-42'),
    filled.split('\n').filter((l) => l.includes('Passwort')).join(' | '));
  check('Snapshot schwaerzt das Passwort mit {{secret:...}}', filled.includes('{{secret:password}}'),
    filled.split('\n').filter((l) => l.includes('secret')).join(' | '));

  /* ---------- Passwort in einer Shadow-Root und mit Sonderzeichen ---------- */
  await client.callTool({ name: 'browser_open', arguments: { url: `${origin}/shadow` } });
  const sh1 = await client.callTool({ name: 'browser_snapshot', arguments: {} });
  const shPw = (textOf(sh1).match(/textbox "Passwort"[^\n]*\[ref=(\S+?)\]/) ?? [])[1];
  await client.callTool({ name: 'browser_type', arguments: { ref: shPw, text: 'schatten  wert\\99' } });
  const sh2 = textOf(await client.callTool({ name: 'browser_snapshot', arguments: {} }));
  check('Passwort in einer offenen Shadow-Root wird geschwaerzt',
    !sh2.includes('schatten') && sh2.includes('{{secret:'),
    sh2.split('\n').filter((l) => l.includes('Passwort')).join(' | '));

  /* ---------- autocomplete als Tokenliste ---------- */
  await client.callTool({ name: 'browser_open', arguments: { url: `${origin}/tricky` } });
  const tk1 = await client.callTool({ name: 'browser_snapshot', arguments: {} });
  const tkRef = (textOf(tk1).match(/textbox "Tokenpasswort"[^\n]*\[ref=(\S+?)\]/) ?? [])[1];
  await client.callTool({ name: 'browser_type', arguments: { ref: tkRef, text: 'tokengeheim77' } });
  const tk2 = textOf(await client.callTool({ name: 'browser_snapshot', arguments: {} }));
  check('autocomplete-Tokenliste zaehlt als Passwortfeld',
    !tk2.includes('tokengeheim77'), tk2.split('\n').filter((l) => l.includes('Tokenpasswort')).join(' | '));

  /* ---------- pushState entwertet die Referenzen nicht ---------- */
  const ps1 = await client.callTool({ name: 'browser_snapshot', arguments: {} });
  const psRef = (textOf(ps1).match(/button "URL umschreiben"[^\n]*\[ref=(\S+?)\]/) ?? [])[1];
  const psClick = await client.callTool({ name: 'browser_click', arguments: { ref: psRef } });
  check('Klick auf den pushState-Button geht durch', !psClick.isError, textOf(psClick).split('\n')[0]);
  const psAgain = await client.callTool({ name: 'browser_click', arguments: { ref: psRef } });
  check('pushState entwertet die Referenzen NICHT (gleiches Dokument)',
    !psAgain.isError, textOf(psAgain).split('\n')[0]);

  /* ---------- ungueltiger Profilname kostet nicht die laufende Sitzung ---------- */
  const badProfile = await client.callTool({ name: 'browser_open', arguments: { profile: '../ausbruch' } });
  check('browser_open mit ungueltigem Profilnamen -> Tool-Error', badProfile.isError === true,
    textOf(badProfile).split('\n')[0]);
  const stillThere = await client.callTool({ name: 'browser_snapshot', arguments: {} });
  check('die laufende Sitzung ueberlebt den ungueltigen Profilnamen',
    !stillThere.isError, textOf(stillThere).split('\n')[0]);

  /* ---------- Aufnahme ohne abschliessende Aktion verliert nichts ---------- */
  await client.callTool({ name: 'browser_open', arguments: { url: `${origin}/` } });
  await client.callTool({ name: 'record_start', arguments: { name: 'ohne-abschluss' } });
  const os1 = await client.callTool({ name: 'browser_snapshot', arguments: {} });
  const osUser = (textOf(os1).match(/textbox "Benutzername"[^\n]*\[ref=(\S+?)\]/) ?? [])[1];
  const osPass = (textOf(os1).match(/textbox "Passwort"[^\n]*\[ref=(\S+?)\]/) ?? [])[1];
  await client.callTool({ name: 'browser_type', arguments: { ref: osUser, text: 'demo' } });
  await client.callTool({ name: 'browser_type', arguments: { ref: osPass, text: 'letzter-wert-99' } });
  await client.callTool({ name: 'record_stop', arguments: {} });
  const osLines = readFileSync(resolve(TMP, 'flows/ohne-abschluss.jsonl'), 'utf8')
    .trim().split('\n').map(JSON.parse);
  check('zuletzt eingegebener Wert geht beim Stoppen nicht verloren',
    osLines.filter((e) => e.kind === 'fill').length === 2,
    JSON.stringify(osLines.map((e) => e.kind)));
  check('auch dieser letzte Wert ist maskiert',
    !JSON.stringify(osLines).includes('letzter-wert-99') &&
      osLines.some((e) => e.kind === 'fill' && e.value === '{{secret:password}}'));

  const tail = await client.callTool({ name: 'log_tail', arguments: { n: 5 } });
  const tailText = textOf(tail);
  check('log_tail liefert die letzten Logzeilen', !tail.isError && /\d{4}-\d\d-\d\dT.*\[(replay|mcp|browser|recorder)\]/.test(tailText),
    tailText.split('\n').pop());

  /* ---------- stdout-Disziplin ---------- */
  check('Server-Log lief auf stderr, nicht auf stdout', serverLog.join('').includes('[mcp]'),
    `${serverLog.join('').length} Zeichen stderr`);
} finally {
  await client.close();
}

/* ---------- Sauberes Herunterfahren: Signal und stdin-Ende ---------- */
async function shutdownProbe(label, stop) {
  const child = spawn(process.execPath, ['dist/cli.js', 'mcp', '--profile', 'shutdown', '--config', '.tmp-test/config.json'], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, WEBPILOT_HEADLESS: '1' },
  });
  let err = '';
  child.stderr.on('data', (c) => { err += String(c); });
  await new Promise((r) => setTimeout(r, 1200));
  stop(child);
  const code = await Promise.race([
    new Promise((r) => child.once('exit', (c, sig) => r({ c, sig }))),
    new Promise((r) => setTimeout(() => r({ c: 'TIMEOUT', sig: null }), 8000)),
  ]);
  if (code.c === 'TIMEOUT') child.kill('SIGKILL');
  check(label, code.c === 0, `exit=${JSON.stringify(code)} ${err.includes('Maximum call stack') ? 'STACK-OVERFLOW!' : ''}`);
}

await shutdownProbe('SIGTERM beendet den Server sauber (Exit 0)', (c) => c.kill('SIGTERM'));
await shutdownProbe('stdin-Ende beendet den Server sauber (Exit 0)', (c) => c.stdin.end());

httpServer.close();

console.log(fails === 0 ? '\nALLE MCP-CHECKS BESTANDEN' : `\n${fails} MCP-CHECK(S) FEHLGESCHLAGEN`);
process.exit(fails === 0 ? 0 : 1);
