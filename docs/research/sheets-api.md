# Google Sheets API research (Node + TypeScript, service account, private sheet)

Verified against primary sources only: Google's official Sheets API / Workspace / Cloud IAM
documentation, and the source and README of `googleapis/google-api-nodejs-client` and
`googleapis/google-auth-library-nodejs` on GitHub. Package versions checked at time of writing:
`googleapis@176.0.0` (depends on `google-auth-library@10.5.0`), latest `google-auth-library@11.0.2`.

## 1. Minimal auth + read

- The read-only scope string is exactly `https://www.googleapis.com/auth/spreadsheets.readonly`, documented as "See all your Google Sheets spreadsheets" and classified Sensitive. ([Sheets API scopes](https://developers.google.com/workspace/sheets/api/scopes))
- `spreadsheets.values.get` accepts any of `drive`, `drive.readonly`, `drive.file`, `spreadsheets`, `spreadsheets.readonly`; `spreadsheets.readonly` is the narrowest read-only option and Google's guidance is to pick "the most narrowly focused scope possible". ([values.get reference](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get)) ([Sheets API scopes](https://developers.google.com/workspace/sheets/api/scopes))
- The official Node quickstart uses this same single scope: `const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];`. ([Node.js quickstart](https://developers.google.com/workspace/sheets/api/quickstart/nodejs))
- A range that is only a tab name reads the whole tab: "`Sheet1` refers to all the cells in Sheet1" and "`'My Custom Sheet'` refers to all the cells in \"My Custom Sheet\"". So `cashflow 2024` needs no `A1:Z` bound. ([A1 notation concepts](https://developers.google.com/workspace/sheets/api/guides/concepts))
- Single quotes are mandatory for our tab names because they contain a space: "Single quotes are required for sheet names with spaces or special characters." Quoting also removes named-range ambiguity — "if there's a named range titled \"Sheet1\", then Sheet1 refers to the named range and `'Sheet1'` refers to the sheet". Always send `'cashflow 2024'`, not `cashflow 2024`. ([A1 notation concepts](https://developers.google.com/workspace/sheets/api/guides/concepts))
- The response is a `ValueRange`; the data lands in `res.data.values` as an array of arrays, and "empty trailing rows and columns will not be included", so row counts vary per tab and rows can be short. ([values.get reference](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get)) ([Read & write cell values](https://developers.google.com/workspace/sheets/api/guides/values))
- Defaults worth knowing: `majorDimension` = `ROWS`, `valueRenderOption` = `FORMATTED_VALUE`, `dateTimeRenderOption` = `SERIAL_NUMBER` (ignored while `valueRenderOption` is `FORMATTED_VALUE`). For arithmetic on cashflow amounts, pass `valueRenderOption: 'UNFORMATTED_VALUE'` to get numbers instead of locale-formatted strings. ([Read & write cell values](https://developers.google.com/workspace/sheets/api/guides/values))
- `GoogleAuth` is the idiomatic entry point per the `googleapis` README: rather than hand-building an OAuth2, JWT or Compute client, "the auth library can create the correct credential type for you", and the README shows no hand-constructed `google.auth.JWT` for service accounts at all. ([google-api-nodejs-client README](https://github.com/googleapis/google-api-nodejs-client/blob/main/README.md))
- Scopes may be given "either as an array or as a single, space-delimited string" in the `GoogleAuth` options. ([google-api-nodejs-client README](https://github.com/googleapis/google-api-nodejs-client/blob/main/README.md))
- The `googleapis` TypeScript section exports an `Auth` namespace for auth types plus generated `Params$...` and `Schema$...` types per method, e.g. `sheets_v4.Params$Resource$Spreadsheets$Values$Get` and `sheets_v4.Schema$ValueRange`. ([google-api-nodejs-client README](https://github.com/googleapis/google-api-nodejs-client/blob/main/README.md)) ([sheets v4 typings](https://github.com/googleapis/google-api-nodejs-client/blob/main/src/apis/sheets/v4.ts))
- Auth can be bound once at service level via `google.sheets({version: 'v4', auth})` instead of per request; created service clients are immutable, so new options require a new client. ([google-api-nodejs-client README](https://github.com/googleapis/google-api-nodejs-client/blob/main/README.md))
- The private spreadsheet does not need publishing: share it with the service account's email address like a normal user — "you can directly share individual files with the service account's email address using the standard UI", with no admin roles and no domain-wide delegation. Uncheck notifications, since "service accounts don't have inboxes it won't receive the invitation email, but the permission is still granted". Cloud IAM roles alone are not enough: they "don't grant access to Google Workspace assets (such as Sheets or Gmail)". `Viewer` access is sufficient for read-only. ([Create access credentials](https://developers.google.com/workspace/guides/create-credentials))

```ts
import { google, sheets_v4, Auth } from 'googleapis';

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'] as const;

// Idiomatic: GoogleAuth picks the right credential type for the environment.
// With GOOGLE_APPLICATION_CREDENTIALS set to the key file path, pass no key options at all.
const auth = new google.auth.GoogleAuth({ scopes: [...SCOPES] });

// Equivalent explicit-path form (see section 4 for the deprecation caveat):
// const auth = new google.auth.GoogleAuth({
//   keyFile: '/path/to/service-account.json',
//   scopes: [...SCOPES],
// });

// Equivalent low-level JWT form, for inline JSON held in an env var:
// import { JWT } from 'google-auth-library';
// const keys = JSON.parse(process.env.GOOGLE_SA_JSON!);
// const auth = new JWT({
//   email: keys.client_email,
//   key: keys.private_key,
//   scopes: [...SCOPES],
// });

const sheets: sheets_v4.Sheets = google.sheets({ version: 'v4', auth });

const SPREADSHEET_ID = process.env.SPREADSHEET_ID!;

export async function readTab(title: string): Promise<string[][]> {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    // Single quotes are REQUIRED: the tab name contains a space.
    // A bare tab name means "all cells in that tab".
    range: `'${title}'`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  return (res.data.values ?? []) as string[][];
}
```

## 2. Tab discovery

- Yes. `spreadsheets.get` returns the `Spreadsheet` resource whose `sheets[]` array holds one `Sheet` per tab, each with a `properties` object of type `SheetProperties`. ([spreadsheets.get reference](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/get))
- `SheetProperties.title` exists and is a `string`, documented as "The name of the sheet." Alongside it: `sheetId` (integer), `index` ("The index of the sheet within the spreadsheet"), `sheetType` (enum, defaults to `GRID`), and `hidden` (boolean). ([SheetProperties reference](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/sheets#SheetProperties))
- No cell data comes back unless you ask: "By default, data within grids is not returned." Grid data requires `includeGridData=true`, and that parameter "is ignored if a field mask was set in the request." ([spreadsheets.get reference](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/get))
- The cheapest mask for titles alone is `fields=sheets.properties.title`. Mask syntax: "multiple different fields are comma-separated and subfields are dot-separated", names may be camelCase or `separated_by_underscores`, and sibling subfields can be grouped in parentheses. ([Field masks](https://developers.google.com/workspace/sheets/api/guides/field-masks))
- Google's own worked example on that page is a `spreadsheets.get` with `?fields=sheets.properties(sheetId,title,sheetType,gridProperties)`, returning only a `sheets[].properties` skeleton — confirming titles are retrievable with no cell payload. Use `sheets.properties(title,index,hidden)` if you also want ordering and want to skip hidden tabs. ([Field masks](https://developers.google.com/workspace/sheets/api/guides/field-masks))
- Masking is the documented performance lever: "Using a FieldMask allows the API to avoid unnecessary work and improves performance", and "For best performance, explicitly list only the fields you need in the reply." ([Field masks](https://developers.google.com/workspace/sheets/api/guides/field-masks))
- Avoid `fields=*`: the docs warn the wildcard "can produce unwanted results if the API is updated in the future, as read-only fields and newly added fields may cause errors." ([Field masks](https://developers.google.com/workspace/sheets/api/guides/field-masks))
- In the Node client this is one typed call with `fields` supplied as a standard parameter ("Selector specifying which fields to include in a partial response") available on every method's `Params$...` interface, including `Params$Resource$Spreadsheets$Get`. ([sheets v4 typings](https://github.com/googleapis/google-api-nodejs-client/blob/main/src/apis/sheets/v4.ts))
- **Probing is unnecessary and should not be implemented.** One masked `spreadsheets.get` enumerates every tab title authoritatively, so the correct pattern is: list titles, filter with `/^cashflow (\d{4})$/`, then `values.get` each match. Speculatively trying `cashflow 2027` and catching an error costs an extra request per guess against the 60/min-per-user ceiling (section 3) and cannot discover tabs whose names you did not guess. ([Field masks](https://developers.google.com/workspace/sheets/api/guides/field-masks)) ([spreadsheets.get reference](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/get))
- `spreadsheets.get` needs no extra scope: it accepts the same set as `values.get`, so `spreadsheets.readonly` covers both discovery and reading. ([spreadsheets.get reference](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/get))

```ts
// Discovery: one request, titles only, zero cell data.
export async function listCashflowYears(): Promise<{ year: number; title: string }[]> {
  const res = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: 'sheets.properties(title,index,hidden)',
  });

  return (res.data.sheets ?? [])
    .flatMap((s) => {
      const title = s.properties?.title ?? '';
      const m = /^cashflow (\d{4})$/.exec(title);
      if (!m || s.properties?.hidden) return [];
      return [{ year: Number(m[1]), title }];
    })
    .sort((a, b) => a.year - b.year);
}
```

## 3. Quotas

- Read requests: **300 per minute per project** and **60 per minute per user per project**. Writes carry the identical 300 / 60 figures. ([Sheets API usage limits](https://developers.google.com/workspace/sheets/api/limits))
- **No daily cap.** "Provided that you stay within the per-minute quotas, there's no limit to the number of requests that you can make per day." ([Sheets API usage limits](https://developers.google.com/workspace/sheets/api/limits))
- Quotas refill every minute; exceeding them yields `429: Too many requests`, and Google advises waiting about a minute and applying truncated exponential backoff. ([Sheets API usage limits](https://developers.google.com/workspace/sheets/api/limits))
- **Service-account attribution matters for the per-user tier:** "API calls by a service account are considered to be using a single account." Every request from our one server identity counts against the same 60/min bucket, so the effective ceiling for this app is 60 reads/min, not 300. ([Sheets API usage limits](https://developers.google.com/workspace/sheets/api/limits))
- Batching does not buy quota headroom: each batch request, "including any subrequest, is counted as one API request toward your usage limit." It still saves round trips and latency — `values.batchGet` fetching all year tabs in one call is 1 request, whereas N separate `values.get` calls are N requests. That is the one place batching genuinely helps us. ([Sheets API usage limits](https://developers.google.com/workspace/sheets/api/limits)) ([Read & write cell values](https://developers.google.com/workspace/sheets/api/guides/values))
- Sizing check for this project: ~700 rows across a handful of tabs is trivially inside the limits. Full refresh via 1 masked `spreadsheets.get` + 1 `values.batchGet` = 2 requests, i.e. up to 30 full refreshes per minute before throttling. No pagination is needed — "There's no explicit limit to the amount of data returned", with a 2 MB payload maximum recommended for speed and a 180-second processing timeout. ([Sheets API usage limits](https://developers.google.com/workspace/sheets/api/limits)) ([Read & write cell values](https://developers.google.com/workspace/sheets/api/guides/values))
- Forward-looking cost note: standard usage is currently free, but the page states that exceeding quota limits "is planned to incur charges to your Google Cloud billing account later in 2026." Quota increases are requested via Quotas & System Limits in the Cloud console, with approval not guaranteed. ([Sheets API usage limits](https://developers.google.com/workspace/sheets/api/limits))

## 4. Key handling

- The `googleapis` README documents exactly two ways to reference the key file, and prefixes both with an explicit instruction: "Save the service account credential file somewhere safe, and *do not check this file into source control*!" ([google-api-nodejs-client README](https://github.com/googleapis/google-api-nodejs-client/blob/main/README.md))
- **Option A — `GOOGLE_APPLICATION_CREDENTIALS`.** "The value of this env var should be the full path to the service account credential file", e.g. `GOOGLE_APPLICATION_CREDENTIALS=./your-secret-key.json node server.js`. It holds a *path*, never the JSON itself. ([google-api-nodejs-client README](https://github.com/googleapis/google-api-nodejs-client/blob/main/README.md)) ([Application Default Credentials](https://docs.cloud.google.com/docs/authentication/application-default-credentials))
- ADC search order is: the `GOOGLE_APPLICATION_CREDENTIALS` env var, then a file from `gcloud auth application-default login`, then the attached service account from the metadata server. The docs stress that "The order of the locations ADC checks for credentials is not related to the relative merit of each location." ([Application Default Credentials](https://docs.cloud.google.com/docs/authentication/application-default-credentials))
- **Option B — explicit `keyFile`.** The README shows `new google.auth.GoogleAuth({ keyFile: '/path/to/your-secret-key.json', scopes: [...] })`; the submodule example uses the `keyFilename` spelling. Both map to the same field — the source does `this.keyFilename = opts.keyFilename || opts.keyFile`. ([google-api-nodejs-client README](https://github.com/googleapis/google-api-nodejs-client/blob/main/README.md)) ([googleauth.ts source](https://github.com/googleapis/google-auth-library-nodejs/blob/main/src/auth/googleauth.ts))
- **Caveat, and the most important finding in this section:** `keyFile`, `keyFilename` and `credentials` on `GoogleAuthOptions` are all annotated `@deprecated This option is being deprecated because of a potential security risk.` in current `google-auth-library` source (present in both v10.5.0, which `googleapis@176.0.0` pins, and the latest v11.0.2 typings). The same annotation is on the `fromJSON` and `fromStream` methods. Nothing breaks today, but new code should prefer the env-var form so we are not building on a deprecated option. ([googleauth.ts source](https://github.com/googleapis/google-auth-library-nodejs/blob/main/src/auth/googleauth.ts)) ([Deprecate unsafe loads commit](https://github.com/googleapis/google-auth-library-nodejs/commit/dc9f5cd0)) ([Externally sourced credentials](https://docs.cloud.google.com/docs/authentication/external/externally-sourced-credentials))
- Note this deprecation is documentation-only at runtime for now: a release that added `console.warn` on `keyFilename`/`credentials` use (v10.4.0) was reverted before v10.5.0, so no runtime warning is emitted currently. Expect it to return. ([add console warnings commit](https://github.com/googleapis/google-auth-library-nodejs/commit/cae596bcf3de1376c57c2cf92a45a8aff8ddd593)) ([revert commit](https://github.com/googleapis/google-auth-library-nodejs/commit/fbc6b112))
- **Option C — inline JSON in an env var.** The `google-auth-library` README documents this specifically for "platforms that deploy straight from source control": read the JSON from e.g. `process.env['CREDS']`, `JSON.parse` it, and pass `email: keys.client_email`, `key: keys.private_key`, `scopes` to a `JWT` client. This is the primary-source-sanctioned pattern if we want zero key files on disk. ([google-auth-library-nodejs README](https://github.com/googleapis/google-auth-library-nodejs/blob/main/README.md))
- Google's validation guidance actually favours the `JWT` path when the input is only ever a service account key: "use a credential loader specific to service account keys", because such a loader "parses only the fields present for service account keys, which don't expose any vulnerabilities" — the Node example given is `JWT.fromJSON(keys)`. If no type-specific loader is used, "validate the credential by confirming that the value for the `type` field is `service_account`." ([Externally sourced credentials](https://docs.cloud.google.com/docs/authentication/external/externally-sourced-credentials))
- Keeping it out of a public repo, stated unambiguously: "Don't submit service account keys to source code repositories." Risks called out include scanning of public repos by bad actors, private repos later being made public, and developers keeping local copies. Recommended controls: keep keys separate from source, prefer personal credentials during development, and enable automated detection (GitHub secret scanning, or a tool such as truffleHog in a pre-commit hook or CI). ([Best practices for managing service account keys](https://docs.cloud.google.com/iam/docs/best-practices-for-managing-service-account-keys))
- If a key ever is committed, removing the file is insufficient: "you must delete the key in IAM as quickly as possible", because version history is typically permanent. ([Best practices for managing service account keys](https://docs.cloud.google.com/iam/docs/best-practices-for-managing-service-account-keys))
- Two Google positions that cut against instinct, worth knowing before designing key storage:
  - "Whenever possible, avoid storing service account keys on a file system." If a file is unavoidable, restrict file permissions, enable access auditing, and encrypt the disk. The gcloud CLI can "write the service account key file straight to the location where you need it", avoiding a stop in the downloads folder. ([Best practices for managing service account keys](https://docs.cloud.google.com/iam/docs/best-practices-for-managing-service-account-keys))
  - "We don't recommend using Google Cloud's Secret Manager to store and rotate service account keys" — the argument is circularity: fetching the secret already requires a recognizable identity, and "your application can use that identity to authenticate to Google Cloud instead of using a service account key." The same reasoning is extended to Azure KeyVault and AWS Secret Manager. ([Best practices for managing service account keys](https://docs.cloud.google.com/iam/docs/best-practices-for-managing-service-account-keys))
- Also don't bake the key into a built artifact: "If a bad actor has access to the binary, they can extract any service account keys that are embedded in the binary." For server-side apps, keep keys separate from the binary. ([Best practices for managing service account keys](https://docs.cloud.google.com/iam/docs/best-practices-for-managing-service-account-keys))
- Operational hygiene the docs recommend and that applies to a single long-lived key: rotate keys routinely, use service account insights (90-day inactivity) and the Key Authentication Events metric to spot stale keys, apply expiry for non-production access but not production workloads, and set the Service Account Key Exposure Response constraint to `DISABLE_KEY` — though "Google Cloud doesn't guarantee that it will detect leaked keys." ([Best practices for managing service account keys](https://docs.cloud.google.com/iam/docs/best-practices-for-managing-service-account-keys))
- Practical recommendation for this repo, consistent with all of the above: keep the key file outside the working tree entirely (e.g. `/etc/cashflow/sa.json`, mode `0600`, owned by the service user), point `GOOGLE_APPLICATION_CREDENTIALS` at it from the process environment, and add both `*.json` credential names and any `.env` to `.gitignore`. ([google-api-nodejs-client README](https://github.com/googleapis/google-api-nodejs-client/blob/main/README.md)) ([Best practices for managing service account keys](https://docs.cloud.google.com/iam/docs/best-practices-for-managing-service-account-keys))

## 5. Contradictions / flags

Nothing invalidates the three locked assumptions. All three are directly supported by primary sources:

- *Key stays server-side* — supported. Direct file sharing with the service account needs "no administrative roles or configure domain-wide delegation", so the server-held key is sufficient on its own. ([Create access credentials](https://developers.google.com/workspace/guides/create-credentials))
- *Sheet stays private* — supported. Sharing the file with the service account's email grants access without publishing; "You can treat the service account's email address as a user account in the document's share settings." `Viewer` is enough for read-only. Nothing in the read path requires "publish to web". ([Create access credentials](https://developers.google.com/workspace/guides/create-credentials))
- *A new `cashflow 2027` tab needs no code change* — supported, provided discovery is done via `spreadsheets.get` with a title field mask and a regex filter (section 2), not via a hardcoded year list. The mask returns whatever tabs exist at call time. ([Field masks](https://developers.google.com/workspace/sheets/api/guides/field-masks))

Flags — non-contradicting, but they change implementation details:

- **`keyFile` / `keyFilename` / `credentials` are marked `@deprecated` in `google-auth-library`** (v10.5.0 as pinned by `googleapis@176.0.0`, and v11.0.2). Prefer `GOOGLE_APPLICATION_CREDENTIALS`, or an explicit `JWT` client for inline JSON. This contradicts the `googleapis` README, which still presents `keyFile` as a first-class option with no deprecation note. Trust the library source over the README here. ([googleauth.ts source](https://github.com/googleapis/google-auth-library-nodejs/blob/main/src/auth/googleauth.ts)) ([google-api-nodejs-client README](https://github.com/googleapis/google-api-nodejs-client/blob/main/README.md))
- **Google Cloud broadly discourages service account keys at all**: "Service account keys create a security risk and are not recommended", since "compromised service account keys can be used by a bad actor without any additional information", and Workload Identity Federation is "recommended" for non-Google-Cloud environments precisely because it avoids storing private keys locally. This does not block the locked decision — a key is the only practical option for a self-hosted server reading a Workspace file — but it is the documented position, and organizations created on or after 2024-05-03 have key creation disabled by default via org policy, which may require a project-level exception. ([Application Default Credentials](https://docs.cloud.google.com/docs/authentication/application-default-credentials)) ([google-auth-library-nodejs README](https://github.com/googleapis/google-auth-library-nodejs/blob/main/README.md)) ([Best practices for managing service account keys](https://docs.cloud.google.com/iam/docs/best-practices-for-managing-service-account-keys))
- **Secret Manager is explicitly not recommended** for storing service account keys, contrary to the usual reflex. Plan on a file with restricted permissions plus environment configuration instead. ([Best practices for managing service account keys](https://docs.cloud.google.com/iam/docs/best-practices-for-managing-service-account-keys))
- **Per-user quota is the real ceiling, not per-project.** Because "API calls by a service account are considered to be using a single account", the app is capped at 60 reads/min, not 300. Irrelevant at ~700 rows, but relevant if a poll loop or per-request pass-through read is ever added. ([Sheets API usage limits](https://developers.google.com/workspace/sheets/api/limits))
- **Tab names must be single-quoted in every range**, since `cashflow 2024` contains a space: "Single quotes are required for sheet names with spaces or special characters." An unquoted range risks a parse failure or resolving to a same-named named-range instead of the tab. ([A1 notation concepts](https://developers.google.com/workspace/sheets/api/guides/concepts))
- **`spreadsheets.readonly` is classified Sensitive**, which implies "additional app verification" if this ever becomes a published multi-user OAuth app. It is a non-issue for a service account acting only on files explicitly shared with it. ([Sheets API scopes](https://developers.google.com/workspace/sheets/api/scopes))
- **Row shapes are ragged.** "Empty trailing rows and columns will not be included", so parsing must tolerate short rows and differing row counts per year tab rather than assuming a fixed column count. ([Read & write cell values](https://developers.google.com/workspace/sheets/api/guides/values))
- **Default render option is not numeric.** `valueRenderOption` defaults to `FORMATTED_VALUE`, which returns locale-formatted strings; pass `UNFORMATTED_VALUE` for arithmetic on amounts. ([Read & write cell values](https://developers.google.com/workspace/sheets/api/guides/values))
- **The official Node quickstart is not a service-account sample.** It uses `@google-cloud/local-auth` with a Desktop-app OAuth client and a browser consent flow, which "doesn't work if run on a remote terminal such as Cloud Shell or over SSH." Take the scope and the `values.get` shape from it, but the auth setup from the `googleapis` README service-account section instead. ([Node.js quickstart](https://developers.google.com/workspace/sheets/api/quickstart/nodejs)) ([google-api-nodejs-client README](https://github.com/googleapis/google-api-nodejs-client/blob/main/README.md))
- **Cloud IAM roles are a red herring for access.** IAM roles "don't grant access to Google Workspace assets (such as Sheets or Gmail)" — granting the service account a project role does nothing; the sheet share is what authorizes the read. ([Create access credentials](https://developers.google.com/workspace/guides/create-credentials))
