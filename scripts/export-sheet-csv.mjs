#!/usr/bin/env node
// Re-exports every `cashflow YYYY` tab to data/ as CSV, straight from the live
// Sheet — the scripted equivalent of File → Download → CSV, so the exports stop
// drifting out of date by hand.
//
// Two routes are tried per tab, in order:
//   1. Drive's CSV export endpoint (`/export?format=csv&gid=`) — byte-identical
//      to the UI download. Needs the Drive API, which this project keeps
//      disabled, so it is expected to fail; kept because when it works it is
//      the highest-fidelity route.
//   2. Sheets `values.get` over a fixed A1:F500 range, written out as CSV.
//      Range is fixed rather than derived so the balance footers are included —
//      they carry no month or item, so no data-driven range finds them
//      (docs: issue #12).
//
// Zero dependencies, same hand-rolled JWT flow as verify-sheets-access.mjs.
//
//   GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
//   GOOGLE_SPREADSHEET_ID=<id> \
//   node scripts/export-sheet-csv.mjs [--out data]

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createSign } from 'node:crypto';
import { join } from 'node:path';

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TAB_PATTERN = /^cashflow (\d{4})$/;
// Wide enough to reach the footers on every tab (last non-empty row is 191 at
// most), narrow enough not to drag in the ~1000 blank allocated rows.
const READ_RANGE = 'A1:F500';
const FILE_PREFIX = 'cash flows - ';

const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;

const outIdx = process.argv.indexOf('--out');
const outDir = outIdx === -1 ? 'data' : process.argv[outIdx + 1];

function die(message) {
  console.error(`\n  FAIL  ${message}\n`);
  process.exit(1);
}

if (!keyPath) die('GOOGLE_APPLICATION_CREDENTIALS is not set (path to the service-account JSON).');
if (!spreadsheetId) die('GOOGLE_SPREADSHEET_ID is not set.');

const b64url = (input) => Buffer.from(input).toString('base64url');

function signJwt({ client_email, private_key }, scope) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({ iss: client_email, scope, aud: TOKEN_URL, iat: now, exp: now + 3600 }),
  );
  const signature = createSign('RSA-SHA256')
    .update(`${header}.${claims}`)
    .sign(private_key, 'base64url');
  return `${header}.${claims}.${signature}`;
}

async function getAccessToken(key, scope) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signJwt(key, scope),
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    const detail = body.error_description ?? JSON.stringify(body);
    return { error: `${res.status} ${body.error ?? ''}: ${detail}` };
  }
  return { token: body.access_token };
}

async function sheetsGet(token, path, params) {
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const body = await res.json();
  if (!res.ok) die(`${res.status} from Sheets: ${body.error?.message ?? JSON.stringify(body)}`);
  return body;
}

// --- route 1: Drive CSV export ------------------------------------------------

async function exportViaDrive(token, gid) {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/export`);
  url.searchParams.set('format', 'csv');
  url.searchParams.set('gid', String(gid));
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) return { error: `${res.status} ${res.statusText}` };
  // Raw bytes, not res.text(): the WHATWG decode strips a leading BOM, and the
  // point of this route is a file byte-identical to the UI download.
  const bytes = Buffer.from(await res.arrayBuffer());
  // A denied export answers 200 with an HTML sign-in page, so sniff the body.
  if (/^\s*</.test(bytes.subarray(0, 64).toString('utf8'))) {
    return { error: 'got HTML, not CSV (export denied)' };
  }
  return { csv: bytes };
}

// --- route 2: Sheets values -> CSV -------------------------------------------

// Matches Sheets' own CSV quoting: quote when the cell holds a comma, a quote,
// or a newline; double any embedded quotes.
function csvCell(value) {
  const s = value === undefined || value === null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

// The UI's CSV pads every row to the widest row in the sheet and drops trailing
// empty rows. Sheets' values.get already drops both trailing empty rows and
// trailing empty cells, so only the padding has to be restored.
function rowsToCsv(rows) {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  return rows
    .map((row) => Array.from({ length: width }, (_, i) => csvCell(row[i])).join(','))
    .join('\n');
}

async function exportViaValues(token, title) {
  const range = encodeURIComponent(`'${title}'!${READ_RANGE}`);
  // FORMATTED_VALUE is what the CSV download writes: `2023-12` on entry rows
  // and `1.1.2025` on footers, rather than the raw date serials.
  const body = await sheetsGet(token, `/values/${range}`, {
    valueRenderOption: 'FORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING',
  });
  return { csv: rowsToCsv(body.values ?? []), rows: (body.values ?? []).length };
}

// --- main --------------------------------------------------------------------

const raw = await readFile(keyPath, 'utf8').catch(() => die(`cannot read key file at ${keyPath}`));
const key = JSON.parse(raw);
if (key.type !== 'service_account') die(`key file type is "${key.type}", expected "service_account".`);

console.log(`\n  service account : ${key.client_email}`);
console.log(`  spreadsheet     : ${spreadsheetId}`);
console.log(`  out             : ${outDir}/`);

const sheetsAuth = await getAccessToken(key, SCOPE);
if (sheetsAuth.error) die(`token exchange failed — ${sheetsAuth.error}`);
const token = sheetsAuth.token;
console.log('  auth            : ok');

const meta = await sheetsGet(token, '', { fields: 'sheets.properties(title,sheetId,hidden)' });
const tabs = (meta.sheets ?? [])
  .map((s) => s.properties ?? {})
  .filter((p) => TAB_PATTERN.test(p.title ?? '') && !p.hidden);

if (tabs.length === 0) die(`no tab matched ${TAB_PATTERN}.`);
console.log(`  tabs            : ${tabs.map((t) => t.title).join(', ')}\n`);

// Drive export needs its own, wider scope; if that token is refused there is no
// point trying the endpoint per tab.
const driveAuth = await getAccessToken(key, 'https://www.googleapis.com/auth/drive.readonly');
if (driveAuth.error) {
  console.log(`  drive export    : unavailable (${driveAuth.error.split(':')[0]}) — using Sheets values\n`);
}

await mkdir(outDir, { recursive: true });

for (const tab of tabs) {
  const file = join(outDir, `${FILE_PREFIX}${tab.title}.csv`);
  let result;
  let route = 'values';

  if (driveAuth.token) {
    const attempt = await exportViaDrive(driveAuth.token, tab.sheetId);
    if (attempt.csv) {
      result = attempt;
      route = 'drive';
    } else {
      console.log(`  ${tab.title}: drive export failed (${attempt.error}) — falling back`);
    }
  }
  result ??= await exportViaValues(token, tab.title);

  await writeFile(file, result.csv, typeof result.csv === 'string' ? 'utf8' : undefined);
  const lines = result.csv.toString('utf8').split('\n').length;
  console.log(`  wrote ${file}  (${lines} lines, via ${route})`);
}

console.log(`\n  PASS  ${tabs.length} tab(s) exported\n`);
