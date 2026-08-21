#!/usr/bin/env node
// Proves the service account can read the private cashflow spreadsheet, and
// prints the tab titles so the discovery regex can be written against reality.
//
// Zero dependencies on purpose: this runs before the project has a package.json,
// so it does the service-account JWT flow by hand with node:crypto.
//
//   GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
//   GOOGLE_SPREADSHEET_ID=<id> \
//   node scripts/verify-sheets-access.mjs
//
// Prints nothing secret: no token, no key material, no cell values beyond the
// header row of the first matching tab.

import { readFile } from 'node:fs/promises';
import { createSign } from 'node:crypto';

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TAB_PATTERN = /^cashflow (\d{4})$/;

const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;

function die(message) {
  console.error(`\n  FAIL  ${message}\n`);
  process.exit(1);
}

if (!keyPath) die('GOOGLE_APPLICATION_CREDENTIALS is not set (path to the service-account JSON).');
if (!spreadsheetId) die('GOOGLE_SPREADSHEET_ID is not set.');

const b64url = (input) => Buffer.from(input).toString('base64url');

function signJwt({ client_email, private_key }) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signature = createSign('RSA-SHA256')
    .update(`${header}.${claims}`)
    .sign(private_key, 'base64url');
  return `${header}.${claims}.${signature}`;
}

async function getAccessToken(key) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signJwt(key),
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    die(
      `token exchange failed (${res.status} ${body.error ?? ''}): ${body.error_description ?? JSON.stringify(body)}\n` +
        '        "account not found" / "invalid_grant" means the service account or its key\n' +
        '        no longer exists, or the local clock is skewed far enough to invalidate the JWT.\n' +
        '        Note this step does not involve the spreadsheet at all — the key itself is the problem.',
    );
  }
  return body.access_token;
}

async function sheetsGet(token, path, params) {
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const body = await res.json();
  if (!res.ok) {
    const reason = body.error?.message ?? JSON.stringify(body);
    if (res.status === 403) {
      die(
        `403 from Sheets: ${reason}\n` +
          '        Either the Sheets API is not enabled on the project, or the spreadsheet\n' +
          '        has not been shared with the service-account email. Both are needed.',
      );
    }
    if (res.status === 404) {
      die(`404 from Sheets: ${reason}\n        Check GOOGLE_SPREADSHEET_ID.`);
    }
    die(`${res.status} from Sheets: ${reason}`);
  }
  return body;
}

const raw = await readFile(keyPath, 'utf8').catch(() => die(`cannot read key file at ${keyPath}`));
const key = JSON.parse(raw);
if (key.type !== 'service_account') {
  die(`key file type is "${key.type}", expected "service_account".`);
}

console.log(`\n  service account : ${key.client_email}`);
console.log(`  project         : ${key.project_id}`);
console.log(`  spreadsheet     : ${spreadsheetId}`);

const token = await getAccessToken(key);
console.log('  auth            : ok (token acquired)');

// Tab discovery — one masked request, no cell data. Mirrors the planned
// production call exactly (docs/research/sheets-api.md §2).
const meta = await sheetsGet(token, '', { fields: 'sheets.properties(title,index,hidden)' });
const tabs = (meta.sheets ?? []).map((s) => s.properties ?? {});

console.log(`\n  tabs (${tabs.length}):`);
const matching = [];
for (const tab of tabs) {
  const match = TAB_PATTERN.exec(tab.title ?? '');
  const flags = [match ? `match year=${match[1]}` : 'NO MATCH', tab.hidden ? 'hidden' : null]
    .filter(Boolean)
    .join(', ');
  console.log(`    [${String(tab.index).padStart(2)}] ${JSON.stringify(tab.title)}  — ${flags}`);
  if (match && !tab.hidden) matching.push(tab.title);
}

if (matching.length === 0) {
  die(`no tab matched ${TAB_PATTERN}. The discovery pattern needs revising against these titles.`);
}

// Prove an actual read, and show the header row so the schema assumption is checked too.
const probe = matching[0];
const values = await sheetsGet(token, `/values/${encodeURIComponent(`'${probe}'!A1:H2`)}`, {
  valueRenderOption: 'UNFORMATTED_VALUE',
});
console.log(`\n  read probe on ${JSON.stringify(probe)}:`);
for (const row of values.values ?? []) console.log(`    ${JSON.stringify(row)}`);

console.log(`\n  PASS  ${matching.length} cashflow tab(s) readable: ${matching.join(', ')}\n`);
