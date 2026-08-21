# Caddy basic auth research (v2.11.4)

Verified against Caddy **v2.11.4** (latest stable at time of writing, published 2026-06-03) — [caddyserver/caddy releases](https://github.com/caddyserver/caddy/releases/latest). Docs pages at caddyserver.com/docs describe the v2.x current release line.

## 1. Directive name and syntax

- The current directive is **`basic_auth`**. The docs page is titled and spelled `basic_auth`, and states it was called `basicauth` before **v2.8.0** and was "renamed for consistency with other directives" — [basic_auth](https://caddyserver.com/docs/caddyfile/directives/basic_auth).
- `basicauth` **still works as a deprecated alias** — both names are registered to the same parser, and using the old one logs a warning. The docs page does not say this outright; the source does: `httpcaddyfile.RegisterHandlerDirective("basicauth", parseCaddyfile) // deprecated` and `caddy.Log()...Warn("the 'basicauth' directive is deprecated, please use 'basic_auth' instead!")` — [caddyauth/caddyfile.go](https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/caddyauth/caddyfile.go).
- Both spellings also appear in the hard-coded directive order list, with `basicauth` marked `// TODO: deprecated, renamed to basic_auth` — [httpcaddyfile/directives.go](https://github.com/caddyserver/caddy/blob/master/caddyconfig/httpcaddyfile/directives.go).

Documented syntax — [basic_auth](https://caddyserver.com/docs/caddyfile/directives/basic_auth):

```caddyfile
basic_auth [<matcher>] [<hash_algorithm> [<realm>]] {
	<username> <hashed_password>
	...
}
```

Minimal one-user block — [basic_auth](https://caddyserver.com/docs/caddyfile/directives/basic_auth):

```caddyfile
example.com {
	basic_auth {
		# Username "Bob", password "hiccup"
		Bob $2a$14$Zkx19XLiW6VYouLHR5NmfOFU0z2GTNmpkT/5qqR7hx4IjWJPDhjvG
	}
	respond "Welcome, {http.auth.user.id}" 200
}
```

Semantics and defaults:

- **Hash algorithm default is `bcrypt`.** The parser comment says "If no hash algorithm is supplied, bcrypt will be assumed", and with zero args `hashName = bcryptName` — [caddyauth/caddyfile.go](https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/caddyauth/caddyfile.go). Valid values are `bcrypt` and `argon2id`; anything else is a config error (`unrecognized hash algorithm`) — [caddyauth/caddyfile.go](https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/caddyauth/caddyfile.go).
- **Realm is positional and only settable after an algorithm.** The parser accepts at most 2 args: 1 arg = algorithm only, 2 args = algorithm + realm. So to set a realm you must spell the algorithm explicitly, e.g. `basic_auth bcrypt "Cashflow"` — [caddyauth/caddyfile.go](https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/caddyauth/caddyfile.go).
- **Realm default is `restricted`.** The struct field is documented `// The name of the realm. Default: restricted`, and at prompt time `if realm == "" { realm = "restricted" }` before setting `WWW-Authenticate: Basic realm="<realm>"` — [caddyauth/basicauth.go](https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/caddyauth/basicauth.go).
- **Scope defaults to the whole site.** With no matcher every request to the site is protected; with a path matcher only matching paths require auth. The docs show `basic_auth /secret/* { ... }` protecting only that prefix while the rest stays public — [basic_auth](https://caddyserver.com/docs/caddyfile/directives/basic_auth).
- Failed or missing credentials produce **HTTP 401 Unauthorized**; on success `{http.auth.user.id}` holds the username — [basic_auth](https://caddyserver.com/docs/caddyfile/directives/basic_auth).
- Plaintext passwords are rejected outright — the hash is mandatory, and both username and password tokens must be non-empty (`username and password cannot be empty or missing`) — [basic_auth](https://caddyserver.com/docs/caddyfile/directives/basic_auth), [caddyauth/caddyfile.go](https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/caddyauth/caddyfile.go).

## 2. Hash generation

Documented usage — [caddy hash-password](https://caddyserver.com/docs/command-line#caddy-hash-password):

```
caddy hash-password
	[-p, --plaintext <password>]
	[-a, --algorithm <name>]
	[--bcrypt-cost <cost>]
```

Full flag set from the command registration — [caddyauth/command.go](https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/caddyauth/command.go):

- `-p, --plaintext` — password to hash; if omitted it is read from stdin, and on a TTY the input is not echoed and is asked for twice ("Enter password:" / "Confirm password:", mismatch is a hard error) — [caddyauth/command.go](https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/caddyauth/command.go).
- `-a, --algorithm` — `bcrypt` or `argon2id`. **The flag default is `bcrypt`** (`cmd.Flags().StringP("algorithm", "a", bcryptName, ...)`), so a bare `caddy hash-password` emits a bcrypt `$2a$...` string. The docs describe `argon2id` as "recommended for modern security" and `bcrypt` as "legacy, slower, configurable cost", but do not state the default — [caddyauth/command.go](https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/caddyauth/command.go), [caddy hash-password](https://caddyserver.com/docs/command-line#caddy-hash-password).
- `--bcrypt-cost` — default **14** (`defaultBcryptCost = 14`, "cost 14 strikes a solid balance between security, usability, and hardware performance") — [caddyauth/bcrypt.go](https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/caddyauth/bcrypt.go).
- `--argon2id-time` (default 1), `--argon2id-memory` (default `46 * 1024` KiB), `--argon2id-threads` (default 1), `--argon2id-keylen` (default 32 bytes) — [caddyauth/argon2id.go](https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/caddyauth/argon2id.go).

The hash is written to **stdout only** (`fmt.Println(hashString)`); prompts go to stderr, so `caddy hash-password > hash.txt` captures just the hash — [caddyauth/command.go](https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/caddyauth/command.go). The docs say the output is "in a format usable directly in your Caddy config" — [caddy hash-password](https://caddyserver.com/docs/command-line#caddy-hash-password).

Recommended invocation for this service (interactive, no password in shell history, default bcrypt):

```bash
caddy hash-password
# or non-interactively via stdin (avoids the password appearing in argv):
printf '%s' 'my-secret' | caddy hash-password
```

Avoid `caddy hash-password --plaintext 'my-secret'` for real credentials — the password lands in shell history and `ps` output. (Inference from the flag being argv-based; the docs do not warn about this — [caddy hash-password](https://caddyserver.com/docs/command-line#caddy-hash-password).)

### Pasting into the Caddyfile — `$` caveats

- **Paste the hash verbatim, unquoted, no escaping.** All three doc examples show raw `$2a$14$...` and `$argon2id$v=19$...` values with no quoting or escaping — [basic_auth](https://caddyserver.com/docs/caddyfile/directives/basic_auth).
- Caddy's placeholder syntax is `{...}`, and the *only* `$`-sensitive form is `{$ENV}`. A bare `$` outside braces is not special, which is why bcrypt hashes need no escaping. Env substitution uses `{$VAR}` / `{$VAR:default}` and is done **"before Caddyfile parsing begins"** — [Caddyfile concepts](https://caddyserver.com/docs/caddyfile/concepts).
- **Templating/env-substitution caveat:** the danger is not Caddy, it is whatever generates the Caddyfile. `docker compose` / `envsubst` / shell heredocs treat `$` as an interpolation sigil, so a bcrypt hash pasted into those pipelines gets mangled (e.g. `$2a` becomes empty). This is an inference from the pre-parse expansion behaviour of `{$ENV}` plus standard interpolation rules; the Caddy docs give **no escape mechanism for a literal `$`** — [Caddyfile concepts](https://caddyserver.com/docs/caddyfile/concepts).
- If a literal brace ever needs protecting, the documented escape is on the brace, not the dollar: "The opening placeholder brace can be escaped `\{like.this}` to prevent replacement" — [Caddyfile concepts](https://caddyserver.com/docs/caddyfile/concepts).
- Since this setup edits `/etc/caddy/Caddyfile` directly (no Docker, no templating — see section 4), **no escaping applies**: paste the hash as-is. If the hash is instead injected at runtime, use `{env.VAR}` which defers substitution to runtime rather than parse time — [Caddyfile concepts](https://caddyserver.com/docs/caddyfile/concepts).
- Tokens containing spaces must be quoted (`directive "abc def"`), and backticks are available to avoid escaping quotes — neither is needed for a hash, which contains no whitespace — [Caddyfile concepts](https://caddyserver.com/docs/caddyfile/concepts).

## 3. Composition with `reverse_proxy` and an `import` snippet

### Directive ordering

Caddy hard-codes an evaluation order because "the order in which those directives are evaluated matters" — the order written in the Caddyfile is irrelevant — [directive order](https://caddyserver.com/docs/caddyfile/directives#directive-order). The relevant excerpt of that list, in order:

```
# middleware handlers; some wrap responses
basic_auth
forward_auth
request_header
encode
...
# handlers that typically respond to requests
abort
error
respond
metrics
reverse_proxy
php_fastcgi
file_server
```

- **`basic_auth` runs before `reverse_proxy`.** `basic_auth` is the first entry in the middleware-handler group; `reverse_proxy` sits far below in the "handlers that typically respond to requests" group — [directive order](https://caddyserver.com/docs/caddyfile/directives#directive-order). The same relative positions appear in `defaultDirectiveOrder` in source, where `basicauth`/`basic_auth` are at index ~73-74 — [httpcaddyfile/directives.go](https://github.com/caddyserver/caddy/blob/master/caddyconfig/httpcaddyfile/directives.go).
- Consequence: an unauthenticated request is answered with 401 and **never reaches the Node upstream**, so the app needs zero auth code — [directive order](https://caddyserver.com/docs/caddyfile/directives#directive-order) + [basic_auth](https://caddyserver.com/docs/caddyfile/directives/basic_auth).
- Order can only be changed via the `order` global option or a `route` block (which "preserves the order the directives appear within"). Neither is needed here — the default already puts auth first — [directive order](https://caddyserver.com/docs/caddyfile/directives#directive-order).

### How `import` interacts

- `import` "replac[es] this directive with the contents of the snippet or file", and is unusual in that "it is evaluated before the structure is parsed, and it can appear anywhere in the Caddyfile" — [import](https://caddyserver.com/docs/caddyfile/directives/import).
- So `import cloudflare` is spliced in literally "as if that file's contents appeared here to begin with", and normal directive sorting then applies to the flattened result. **The position of the `import` line inside the site block does not matter** — [import](https://caddyserver.com/docs/caddyfile/directives/import).
- `import` does not appear in the directive-order list at all, consistent with it being resolved pre-parse — [directive order](https://caddyserver.com/docs/caddyfile/directives#directive-order).
- `tls` (what the `cloudflare` snippet contains) is a site-level connection directive, not an HTTP handler, so it does not compete with `basic_auth`/`reverse_proxy` in the handler chain — it is absent from the ordering list — [directive order](https://caddyserver.com/docs/caddyfile/directives#directive-order).

### Copy-pasteable site block

Assumes the Node service listens on `127.0.0.1:3000` on the droplet itself, and the existing `(cloudflare)` snippet is already defined at the top of `/etc/caddy/Caddyfile` (see section 4). Replace the hash with your own `caddy hash-password` output and `<domain>` with the real domain.

```caddyfile
cashflow.<domain> {
    basic_auth {
        # generate with: caddy hash-password
        jiri $2a$14$Zkx19XLiW6VYouLHR5NmfOFU0z2GTNmpkT/5qqR7hx4IjWJPDhjvG
    }
    reverse_proxy localhost:3000
    import cloudflare
}
```

Notes on the block:

- Directive order in the file is cosmetic; auth-before-proxy is guaranteed by Caddy's hard-coded order — [directive order](https://caddyserver.com/docs/caddyfile/directives#directive-order).
- No matcher on `basic_auth` = the entire site is protected, which is what "zero app code" requires — [basic_auth](https://caddyserver.com/docs/caddyfile/directives/basic_auth).
- Realm will be the default `restricted`; to customise it you must also name the algorithm: `basic_auth bcrypt "Cashflow" { ... }` — [caddyauth/basicauth.go](https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/caddyauth/basicauth.go), [caddyauth/caddyfile.go](https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/caddyauth/caddyfile.go).
- `reverse_proxy` passes all incoming headers through, including `Host`, with only `X-Forwarded-For` / `X-Forwarded-Proto` / `X-Forwarded-Host` set by the proxy — [reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).
- **`Authorization` is forwarded to the upstream.** The docs list only those three exceptions to pass-through and never single out `Authorization`, so the credentials header reaches the Node app — [reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy). The app should ignore it; alternatively strip it with `header_up -Authorization` inside the `reverse_proxy` block.
- Validate and reload after editing: `sudo caddy validate --config /etc/caddy/Caddyfile` then `sudo systemctl reload caddy` — [jirigrill/reverse-proxy-setup README](https://github.com/jirigrill/reverse-proxy-setup/blob/main/README.md).

## 4. Fit with the existing `jirigrill/reverse-proxy-setup`

The repo is **documentation only** — its entire tree is a single `README.md` blob; there is no committed Caddyfile, no `docker-compose.yml`, no `sites-enabled/` directory — [repo tree](https://github.com/jirigrill/reverse-proxy-setup) (verified via `gh api repos/jirigrill/reverse-proxy-setup/git/trees/HEAD?recursive=1`, which returns one entry: `blob README.md`).

Actual convention, per the README — [README](https://github.com/jirigrill/reverse-proxy-setup/blob/main/README.md):

- **Single Caddyfile at `/etc/caddy/Caddyfile`**, edited by hand: `sudo nano /etc/caddy/Caddyfile` (README line 140).
- **Caddy installed natively via apt** (Cloudsmith repo) and run under systemd — `sudo apt install caddy`, `sudo systemctl enable caddy`. **No Docker anywhere.**
- **Snippet name is `cloudflare`**, defined once at the top of the file, holding the DNS-challenge TLS config with a runtime env placeholder (README lines 146-150):

```caddyfile
# Cloudflare DNS configuration snippet
(cloudflare) {
    tls {
        dns cloudflare {env.CLOUDFLARE_API_TOKEN}
    }
}
```

- The token comes from `/etc/caddy/cloudflare.env` loaded via a systemd override `EnvironmentFile=/etc/caddy/cloudflare.env`, and requires the `github.com/caddy-dns/cloudflare` plugin (`sudo caddy add-package github.com/caddy-dns/cloudflare`) — [README](https://github.com/jirigrill/reverse-proxy-setup/blob/main/README.md).
- **Per-site pattern: one flat site block per subdomain, `reverse_proxy` first then `import cloudflare` last** (README lines 153-156):

```caddyfile
service.your-domain.com {
    reverse_proxy HOME_SERVICE_TAILSCALE_IP:SERVICE_PORT
    import cloudflare
}
```

- Every example in the file repeats that exact two-line shape — e.g. `app.your-domain.com { reverse_proxy 100.x.x.x:3000 ... import cloudflare }` for "Node.js, React, etc.", plus jellyfin/plex/home/git/code blocks — [README](https://github.com/jirigrill/reverse-proxy-setup/blob/main/README.md).
- The README's own **"Adding New Services"** section states the procedure verbatim (README lines 349-360): "To add a new service, simply add a new block to your Caddyfile", followed by

```caddyfile
newservice.your-domain.com {
    reverse_proxy NEW_SERVICE_TAILSCALE_IP:NEW_SERVICE_PORT
    import cloudflare
}
```

  "Then: 1. Create the DNS record in Cloudflare  2. Reload Caddy: `sudo systemctl reload caddy`" — [README](https://github.com/jirigrill/reverse-proxy-setup/blob/main/README.md).

### Where to put the cashflow block

Append it to the end of `/etc/caddy/Caddyfile`, after the existing site blocks and below the `(cloudflare)` snippet definition, matching the house style (4-space indent, `reverse_proxy` then `import cloudflare`, with `basic_auth` added):

```caddyfile
cashflow.<domain> {
    basic_auth {
        jiri <paste caddy hash-password output>
    }
    reverse_proxy localhost:3000
    import cloudflare
}
```

Then: add the `cashflow` A record in Cloudflare pointing at the droplet IP, `sudo caddy validate --config /etc/caddy/Caddyfile`, `sudo systemctl reload caddy` — [README](https://github.com/jirigrill/reverse-proxy-setup/blob/main/README.md).

**Deviation from the existing pattern worth noting:** every documented site proxies to a *Tailscale IP* of a home box (`Internet → subdomain → Caddy (DigitalOcean) → Tailscale → Home Service`). The cashflow service runs on the droplet itself, so it uses `localhost:PORT` instead — a simpler case that needs no Tailscale hop, but it is the first site of its kind in this setup — [README](https://github.com/jirigrill/reverse-proxy-setup/blob/main/README.md).

Since the Caddyfile lives only on the droplet (not in git), there is **no repo file to edit** — the change is applied by SSHing to the droplet, or the site block should be committed into the `cashflow` repo as deployment documentation — [repo tree](https://github.com/jirigrill/reverse-proxy-setup).

## Contradictions / flags

Nothing invalidates the locked assumption "Auth: Caddy `basic_auth` at the proxy, zero app code". It holds. Caveats, in rough order of importance:

1. **Cloudflare proxy mode (orange cloud) is the real risk.** The existing setup's DNS records are plain A records to the droplet and TLS is issued via the Cloudflare **DNS challenge**, which works regardless of proxy mode — [README](https://github.com/jirigrill/reverse-proxy-setup/blob/main/README.md). But if the `cashflow` record is proxied, Caddy's `reverse_proxy` docs explicitly warn that with a CDN in front you "may be vulnerable to spoofing of the `X-Forwarded-For` header" unless `trusted_proxies` is configured — [reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy). This does not break basic auth (the `Authorization` header passes through Cloudflare), but any per-IP rate limiting or logging will see wrong client IPs. Recommendation: leave the record **DNS-only (grey cloud)** for this service, or set the server-wide `trusted_proxies` option.
2. **Basic auth over plain HTTP is insecure** — credentials are base64, not encrypted. The docs warn "basic auth is not secure over plain HTTP" — [basic_auth](https://caddyserver.com/docs/caddyfile/directives/basic_auth). Mitigated here because the `cloudflare` snippet gives real TLS and Caddy redirects HTTP→HTTPS by default, but it means the site must never be served over `http://`.
3. **Path scoping IS supported** — this is not a limitation. `basic_auth /secret/*` protects only matching paths, so a future public health-check endpoint can be carved out without app code — [basic_auth](https://caddyserver.com/docs/caddyfile/directives/basic_auth). Conversely, note the inverse: with no matcher, *everything* is behind auth including `/health`, `/favicon.ico`, and any webhook or API endpoint. If the Node service ever needs an unauthenticated callback (e.g. a bank webhook, a cron ping), basic auth as written will 401 it and the design must change to a path matcher.
4. **`Authorization` reaches the Node app.** Caddy does not strip it (only `X-Forwarded-*` are overridden) — [reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy). Harmless, but it means credentials are visible to app-level logging; strip with `header_up -Authorization` if that matters.
5. **Browser UX**: basic auth has no logout and no styled login page — the browser shows a native prompt reading "The website says: restricted" (the default realm) — [caddyauth/basicauth.go](https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/caddyauth/basicauth.go). Set a friendlier realm via `basic_auth bcrypt "Cashflow"`. Also relevant if the Node service is a SPA doing `fetch()` calls — a 401 on an XHR can trigger the native prompt rather than a clean redirect.
6. **`basicauth` vs `basic_auth` version floor**: `basic_auth` requires **v2.8.0+**. The README installs Caddy from apt on Ubuntu 22.04, which yields current stable, so this is fine — but if the droplet has an older pinned Caddy, `basic_auth` will fail to parse and `basicauth` must be used instead. Verify with `caddy version` — [basic_auth](https://caddyserver.com/docs/caddyfile/directives/basic_auth), [README](https://github.com/jirigrill/reverse-proxy-setup/blob/main/README.md).
7. **Doc gap corrected by source (twice)**: the docs page does not state that `basicauth` still works, nor that `hash-password` defaults to bcrypt. Both were confirmed only in source — [caddyauth/caddyfile.go](https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/caddyauth/caddyfile.go), [caddyauth/command.go](https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/caddyauth/command.go). The docs also list `argon2id` as "recommended" while the CLI still defaults to bcrypt — a mild inconsistency; pass `-a argon2id` explicitly if you want the recommended algorithm, and remember the `basic_auth` block must then also declare `argon2id`.
8. **bcrypt cost 14 is deliberately slow** (~1s per verification on modest hardware). Caddy mitigates this with an in-memory hash cache (`HashCache`, "can greatly improve the performance of traffic-heavy" sites) which `basic_auth` enables by default in the Caddyfile parser (`ba.HashCache = new(Cache)`) — [caddyauth/basicauth.go](https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/caddyauth/basicauth.go), [caddyauth/caddyfile.go](https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/caddyauth/caddyfile.go). Not a problem at this scale.
9. **The Caddyfile is not version-controlled**, so this auth config is untracked infrastructure living only on the droplet — [repo tree](https://github.com/jirigrill/reverse-proxy-setup). Losing the droplet loses the config; the hash should be recorded somewhere durable (it is safe to commit a bcrypt hash, though a password manager is better).
