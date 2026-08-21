# systemd unit for a Node HTTP service (Ubuntu droplet, behind Caddy)

Primary sources: the systemd man pages (`systemd.service(5)`, `systemd.exec(5)`, `systemd.unit(5)`, `systemd.special(7)`, `systemctl(1)`, `journalctl(1)`, `systemd-system.conf(5)`), the systemd `NEWS` file, and the Node.js API docs.

Note on citations: `freedesktop.org/software/systemd/man/latest/` returns HTTP 403 to non-browser clients from this environment, so the same upstream man pages are cited via **man7.org**, which republishes them verbatim (page footers identify them as systemd project documentation). Version-added notes in the man pages are quoted where a directive is recent, so you can check it against the droplet's `systemctl --version` (Ubuntu 22.04 ships systemd 249, Ubuntu 24.04 ships 255).

Assumed layout, used throughout:

| Thing | Path |
| --- | --- |
| App root (rsync target) | `/srv/cashflow` |
| Built entrypoint | `/srv/cashflow/dist/server.js` |
| Node binary | `/usr/bin/node` (confirm with `command -v node`) |
| Service user | `cashflow` |
| Env file | `/etc/cashflow/cashflow.env` |
| Google key JSON | `/etc/cashflow/google-sa.json` |
| Unit file | `/etc/systemd/system/cashflow.service` |

## 1. The conventional unit file

```ini
# /etc/systemd/system/cashflow.service
[Unit]
Description=Cashflow HTTP server (Node)
Documentation=https://github.com/your-org/cashflow
After=network-online.target
Wants=network-online.target

[Service]
Type=exec
User=cashflow
Group=cashflow
WorkingDirectory=/srv/cashflow
EnvironmentFile=/etc/cashflow/cashflow.env
ExecStart=/usr/bin/node /srv/cashflow/dist/server.js

Restart=on-failure
RestartSec=2s
TimeoutStopSec=20s

[Install]
WantedBy=multi-user.target
```

Add hardening from section 4 and the rate-limit settings from section 2 once the plain unit is confirmed working.

### Why each line

- **`After=network-online.target` + `Wants=network-online.target`** — units that "strictly require a configured network connection" should pull this target in with a `Wants=` dependency and order themselves after it; the target exists to "pull in a service that delays further execution until the network is sufficiently set up" — [systemd.special(7)](https://man7.org/linux/man-pages/man7/systemd.special.7.html). `Wants=` is the correct strength: "Units listed in this option will be started if the configuring unit is", and if the wanted unit fails "the transaction is still valid" and this unit still starts — "This is the recommended way to hook the start-up of one unit to the start-up of another unit" — [systemd.unit(5)](https://man7.org/linux/man-pages/man5/systemd.unit.5.html). Use `Wants=` not `Requires=`: with `Requires=`, "this unit will be stopped (or restarted) if one of the other units is explicitly stopped (or restarted)", and "Often, it is a better choice to use `Wants=` instead of `Requires=`" — [systemd.unit(5)](https://man7.org/linux/man-pages/man5/systemd.unit.5.html).
- Both are needed because "requirement dependencies do not influence the order in which services are started or stopped" — without `After=` the two would start simultaneously — [systemd.unit(5)](https://man7.org/linux/man-pages/man5/systemd.unit.5.html).
- **Honest caveat on `network-online.target`**: it is an *active* unit that "may introduce substantial delays to further execution", and it "is only useful during the original system start-up logic" — after boot it stops tracking online state, so "it cannot be used as a network connection monitor concept" — [systemd.special(7)](https://man7.org/linux/man-pages/man7/systemd.special.7.html). For a server that only **listens on localhost** and makes outbound calls lazily, it is arguably unnecessary: `network.target` alone would do, and the docs note that daemons which merely "*provide* functionality to other hosts" usually do not need `network-online.target`. Keeping it is cheap insurance if the app resolves DNS or contacts Google during startup; drop it if boot time matters. Plain `network.target` is the weaker guarantee — at startup "there's no guarantee that hardware based devices have shown up" or acquired "complete IP configuration" — [systemd.special(7)](https://man7.org/linux/man-pages/man7/systemd.special.7.html).
- **`Type=exec`, not `simple`** — with `Type=simple` the service "is considered started immediately after the main service process has been forked off", i.e. *before* `execve()`, so "systemctl start command lines for simple services report success even if the service's binary cannot be invoked successfully (for example because the selected `User=` doesn't exist, or the service binary is missing)". `Type=exec` "is similar to simple, but the service manager will consider the unit started immediately after the main service binary has been executed", and the docs say plainly that for this reason "`Type=exec` is the better choice" and is "the preferred option for long-running services" — [systemd.service(5)](https://man7.org/linux/man-pages/man5/systemd.service.5.html). This matters directly for deploys: with `exec`, a botched rsync that leaves `dist/server.js` missing makes `systemctl restart` fail loudly instead of reporting success.
- **Not `Type=forking`** — a Node process started with `node server.js` does not double-fork or write a PID file; it stays in the foreground, so `forking` would be wrong. It is also discouraged in general: "The use of this type is discouraged, use notify, notify-reload, or dbus instead" — [systemd.service(5)](https://man7.org/linux/man-pages/man5/systemd.service.5.html).
- **Not `Type=notify`** (unless you want it) — `notify` "behaves like `exec`" but additionally requires the service to "send a notification message via `sd_notify(3)`" with `READY=1` before systemd considers it started — [systemd.service(5)](https://man7.org/linux/man-pages/man5/systemd.service.5.html). That means app code changes (calling `sd_notify` from Node), so it is only worth it if something must be ordered after the HTTP listener is actually accepting connections. Caddy does not need this.
- **`Type=` default** — if you omit it, you get `simple`, since `simple` is the default "if `ExecStart=` is specified but neither `Type=` nor `BusName=` are, and credentials are not used" — [systemd.service(5)](https://man7.org/linux/man-pages/man5/systemd.service.5.html). So `Type=exec` must be written explicitly.
- **Absolute path in `ExecStart=`** — "the first argument must be either an absolute path to an executable or a simple file name without any slashes"; bare names are resolved only against a compile-time search path (`/usr/local/bin/`, `/usr/bin/`, and their `sbin/` counterparts), "and an absolute path must be used in other cases" — [systemd.service(5)](https://man7.org/linux/man-pages/man5/systemd.service.5.html). Because the script path contains slashes, `ExecStart=node dist/server.js` would fail; and if node came from nvm or fnm (e.g. `/home/deploy/.nvm/versions/node/v22.x/bin/node`) it is outside the search path anyway. Use a system-wide node (NodeSource or `/usr/bin/node`) and give the full path. Verify with `systemd-path search-binaries-default` — [systemd.service(5)](https://man7.org/linux/man-pages/man5/systemd.service.5.html).
- **`ExecStart=` is not run through a shell.** Only "Basic environment variable substitution is supported. Use `${FOO}` as part of a word ... `$FOO` as a separate word" — [systemd.service(5)](https://man7.org/linux/man-pages/man5/systemd.service.5.html). There is no pipe, no redirection, no globbing. Do not write `ExecStart=/usr/bin/node dist/server.js >> log.txt`.
- **Exactly one `ExecStart=`** — "Unless `Type=oneshot` is set, exactly one command must be given" (multiple `ExecStart=` lines are a oneshot-only feature) — [systemd.service(5)](https://man7.org/linux/man-pages/man5/systemd.service.5.html).
- **`WorkingDirectory=`** — "Takes a directory path relative to the service's root directory ... Sets the working directory for executed processes." Unset, the default is "the root directory when systemd is running as a system instance", i.e. `/` — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html). Set it to the app root so any relative path the app uses (a `.env` fallback, a static assets dir, `require`/`import` of a relative file) resolves as it did in development. Prefix with `-` if a missing directory should not be fatal — "a missing working directory is not considered fatal" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html); do **not** do that here, since a missing `/srv/cashflow` means the deploy is broken and you want to know.
- **`User=` / `Group=`** — they "Set the UNIX user or group that the processes are executed as, respectively", and the default "is `root` for services of the system service manager" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html). A localhost HTTP server has no reason to be root (it binds a high port, not 80/443 — Caddy owns those). The account must exist beforehand: "the user/group must have been created statically in the user database ... before the service is started" or "program invocation will fail" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html). Create it as a no-login system user:

```bash
sudo useradd --system --home-dir /srv/cashflow --shell /usr/sbin/nologin cashflow
```

- **`DynamicUser=` is deliberately not used here.** It allocates the UID at start time and frees it at stop — convenient, but it implies `ProtectSystem=strict`, `ProtectHome=`, and `RemoveIPC=` — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html) — and a rotating UID complicates rsync-owned files and a `0600` secret file that must be readable by a *stable* owner. A static system user is the simpler fit for the rsync deploy model.
- **`[Install] WantedBy=multi-user.target`** — `multi-user.target` is the "special target unit for setting up a multi-user system (non-graphical)", and "Units that are needed for a multi-user system shall add `Wants=` dependencies for their unit to this unit during installation. This is best configured via `WantedBy=multi-user.target` in the unit's `[Install]` section" — [systemd.special(7)](https://man7.org/linux/man-pages/man7/systemd.special.7.html). This is what makes the service **survive reboots**: `systemctl enable` "creates the symlinks encoded in the `[Install]` sections" — [systemctl(1)](https://man7.org/linux/man-pages/man1/systemctl.1.html) — so the target pulls the unit in on every boot. Without `[Install]`, `enable` has nothing to do and the service will not come back after a reboot.
- **`TimeoutStopSec=20s`** — optional, but the default stop timeout is generous: `DefaultTimeoutStopSec=` "defaults to 90 s in the system manager" — [systemd-system.conf(5)](https://man7.org/linux/man-pages/man5/systemd-system.conf.5.html). If the Node process installs a `SIGTERM` handler for graceful shutdown and hangs, you would wait 90s per deploy. A word of caution on that handler: in Node, "`'SIGTERM'` and `'SIGINT'` have default handlers on non-Windows platforms that reset the terminal mode before exiting with code `128 + signal number`", but "If one of these signals has a listener installed, its default behavior will be removed (Node.js will no longer exit)" — [Node.js process docs](https://nodejs.org/api/process.html#signal-events). So if you add a `SIGTERM` listener for draining connections, it **must** call `server.close()` and exit explicitly, or systemd will `SIGKILL` it after the timeout on every restart.

## 2. Restart policy and start rate limiting

### `Restart=` values

`Restart=` "configures whether the service shall be restarted when the service process exits, is killed, or a timeout is reached", and the accepted values are `no`, `on-success`, `on-failure`, `on-abnormal`, `on-abort`, `on-watchdog`, `always` — [systemd.service(5)](https://man7.org/linux/man-pages/man5/systemd.service.5.html). The default is `no` — [systemd.service(5)](https://man7.org/linux/man-pages/man5/systemd.service.5.html), so a unit without this line will **not** survive a crash.

The exit-cause table from the man page, reformatted — [systemd.service(5)](https://man7.org/linux/man-pages/man5/systemd.service.5.html):

| Exit cause | `no` | `always` | `on-success` | `on-failure` | `on-abnormal` | `on-abort` | `on-watchdog` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Clean exit code or signal | | X | X | | | | |
| Unclean exit code | | X | | X | | | |
| Unclean signal | | X | | X | X | X | |
| Timeout | | X | | X | X | | |
| Watchdog | | X | | X | X | | X |
| Termination due to OOM | | X | | X | X | | |

### Recommendation: `Restart=on-failure`

The docs state it directly: `on-failure` is "the recommended choice for long-running services, in order to increase reliability by attempting automatic recovery from errors" — [systemd.service(5)](https://man7.org/linux/man-pages/man5/systemd.service.5.html).

"Clean exit" is defined as "an exit code of 0, or one of the signals `SIGHUP`, `SIGINT`, `SIGTERM`, or `SIGPIPE`, ... as well as the termination statuses and signals specified in `SuccessExitStatus=`" — [systemd.service(5)](https://man7.org/linux/man-pages/man5/systemd.service.5.html).

`always` vs `on-failure` for this workload:

- `always` restarts "regardless of whether the service exited cleanly or not" — [systemd.service(5)](https://man7.org/linux/man-pages/man5/systemd.service.5.html). It sounds safer but it papers over bugs: a Node server that hits a fatal config error and calls `process.exit(0)` would be silently restarted forever with no failure signal, and `systemctl status` would never show `failed`.
- `on-failure` catches everything that actually matters for an HTTP server: an uncaught exception (Node exits non-zero), a segfault, and — importantly for a small droplet — OOM kill, which the table above shows is covered by `on-failure`.
- A long-running HTTP server has **no legitimate reason** to exit 0 on its own. If it does, that is a bug you want surfaced. `on-failure` surfaces it.

Note `always` also has a documented nuance for `Type=oneshot` (rejected there), which does not apply to us — [systemd.service(5)](https://man7.org/linux/man-pages/man5/systemd.service.5.html).

Neither value restarts on an explicit stop: restarts do not happen if "the service process exits with a status in `RestartPreventExitStatus=` or the service is stopped with `systemctl stop`" — [systemd.service(5)](https://man7.org/linux/man-pages/man5/systemd.service.5.html). So `systemctl stop cashflow` stays stopped, and `systemctl restart` during deploy is not affected by the policy.

### `RestartSec=`

"Configures the time to sleep before restarting a service (as configured with `Restart=`). Takes a unit-less value in seconds, or a time span value such as '5min 20s'. Defaults to 100ms" — [systemd.service(5)](https://man7.org/linux/man-pages/man5/systemd.service.5.html).

100ms is very aggressive: combined with the default burst of 5 in 10s (below), a service that fails to start will exhaust its start limit in well under a second. Setting `RestartSec=2s` spreads 5 attempts over ~10s, which is enough for a transient upstream blip to clear while still tripping the limit on a genuinely broken deploy.

### Rate limiting: which section (this moved)

**`StartLimitIntervalSec=` and `StartLimitBurst=` belong in `[Unit]`, not `[Service]`, in current systemd.** They are documented under the "[UNIT] SECTION OPTIONS" heading of [systemd.unit(5)](https://man7.org/linux/man-pages/man5/systemd.unit.5.html), and `systemd.service(5)` only cross-references them: "service restart is subject to unit start rate limiting configured with `StartLimitIntervalSec=` and `StartLimitBurst=`, see `systemd.unit(5)` for details" — [systemd.service(5)](https://man7.org/linux/man-pages/man5/systemd.service.5.html).

The move happened in **systemd 230**, and the old location still works. From the upstream changelog: "The settings `StartLimitBurst=`, `StartLimitInterval=`, `StartLimitAction=` and `RebootArgument=` have been moved from the `[Service]` section of unit files to `[Unit]`, and they are now supported on all unit types, not just service units. Of course, systemd will continue to understand these settings also at the old location, in order to maintain compatibility" — [systemd NEWS, CHANGES WITH 230](https://github.com/systemd/systemd/blob/main/NEWS). This is why older blog posts and Stack Overflow answers show them under `[Service]`: that is legacy-compatible but not current. The directives themselves were "Added in version 229" — [systemd.unit(5)](https://man7.org/linux/man-pages/man5/systemd.unit.5.html) — note the older spelling was `StartLimitInterval=` without the `Sec` suffix.

### The failure mode: crash-loop → permanently stopped

Semantics: "Configure unit start rate limiting. Units which are started more than *burst* times within an *interval* time span are not permitted to start any more" — [systemd.unit(5)](https://man7.org/linux/man-pages/man5/systemd.unit.5.html).

And the trap, stated explicitly: "Note that units which are configured for `Restart=`, and which reach the start limit are not attempted to be restarted anymore" — [systemd.unit(5)](https://man7.org/linux/man-pages/man5/systemd.unit.5.html).

Defaults come from the manager config: `DefaultStartLimitIntervalSec=` "defaults to 10s" and `DefaultStartLimitBurst=` "defaults to 5" — [systemd-system.conf(5)](https://man7.org/linux/man-pages/man5/systemd-system.conf.5.html). Combined with `RestartSec=100ms`, an app that dies instantly on startup burns 5 attempts in about half a second and is then **left dead**. The journal line you will see is `Start request repeated too quickly` followed by `Failed with result 'start-limit-hit'` — this runtime message is not in the man pages, so treat the exact string as observed behaviour rather than a documented contract; the documented part is the "not attempted to be restarted anymore" sentence above.

Two consequences that bite in practice:

1. **A bad deploy is not self-healing.** If rsync ships a broken build, the service crash-loops, hits the limit, and stays down. Even after you fix the files, plain `systemctl start` may be refused until the interval elapses.
2. **Rate limiting applies to manual starts too**: the settings "are useful when `Restart=` is enabled ... however they apply to all kinds of starts (including manual)" — [systemd.unit(5)](https://man7.org/linux/man-pages/man5/systemd.unit.5.html).

### How to avoid it

Recovery — `systemctl reset-failed` "will cause the restart rate counter for a service to be flushed" — [systemd.unit(5)](https://man7.org/linux/man-pages/man5/systemd.unit.5.html); `reset-failed` "resets various other per-unit properties: the start rate limit counter of all unit types is reset ... Hence, when a unit with a start rate limit hits the limit and refuses to be started again, use this command to make it startable again" — [systemctl(1)](https://man7.org/linux/man-pages/man1/systemctl.1.html). Worth putting in the deploy script before the restart:

```bash
sudo systemctl reset-failed cashflow.service || true
sudo systemctl restart cashflow.service
```

Prevention — three options, in order of preference:

**(a) Widen `RestartSec=` so 5 attempts span a useful window** (what the unit in section 1 does). Simple, keeps the "give up eventually" behaviour, which is arguably correct: a service that cannot start after 5 tries needs a human.

**(b) Exponential backoff** (systemd ≥ 254 only). `RestartSteps=` takes "a positive integer as the number of steps to take to increase the interval of auto-restarts from `RestartSec=` to `RestartMaxDelaySec=`", where "Values between 3 and 5 are good choices when exponential backoff is desired", and `RestartMaxDelaySec=` sets "the longest time to sleep before restarting a service", defaulting to `infinity`; each "is effective only if" the other is set "and `RestartSec=` is not zero" — [systemd.service(5)](https://man7.org/linux/man-pages/man5/systemd.service.5.html). Both were "Added in version 254" — [systemd.service(5)](https://man7.org/linux/man-pages/man5/systemd.service.5.html) — so **check `systemctl --version` first**; these do not exist on Ubuntu 22.04's systemd 249.

```ini
[Unit]
StartLimitIntervalSec=60s
StartLimitBurst=8

[Service]
Restart=on-failure
RestartSec=1s
RestartSteps=4
RestartMaxDelaySec=60s
```

**(c) Never give up** — set `StartLimitIntervalSec=0`, since the interval "may be set to 0 to disable any kind of rate limiting" — [systemd.unit(5)](https://man7.org/linux/man-pages/man5/systemd.unit.5.html). Only sane with a large `RestartSec=`, otherwise a tight crash loop will spin the CPU and flood the journal forever with no failed state to alert on. Prefer (a) or (b).

Optional: `StartLimitAction=` "configures an additional action to take if the rate limit configured with `StartLimitIntervalSec=` and `StartLimitBurst=` is hit", taking "the same values as the `FailureAction=`/`SuccessAction=` settings", and defaulting to `none`, where "hitting the rate limit will trigger no action besides that the start will not be permitted" — [systemd.unit(5)](https://man7.org/linux/man-pages/man5/systemd.unit.5.html). Leave it at the default; you do not want a reboot loop on a droplet.

Also relevant if the unit is not referenced continuously: garbage collection flushes the counters, so "rate limiting is enforced after any unit condition checks are executed" and "for a unit that is not referenced continuously, rate limiting has no effect" — [systemd.unit(5)](https://man7.org/linux/man-pages/man5/systemd.unit.5.html). An enabled unit wanted by `multi-user.target` **is** referenced continuously, so the limit does apply to us.

## 3. Config injection via `EnvironmentFile=`

### Unit lines

```ini
[Service]
# Fails to start if the file is missing — what you want for required config.
EnvironmentFile=/etc/cashflow/cashflow.env

# Optional overrides layered on top (later files win). Note the "-" prefix.
EnvironmentFile=-/etc/cashflow/cashflow.local.env
```

### Example env file

```ini
# /etc/cashflow/cashflow.env
# Comments start with # or ; and are ignored.
; both of these lines are ignored

NODE_ENV=production
PORT=3000
HOST=127.0.0.1

# Path to the Google service-account key. Note: the PATH, not the key itself.
GOOGLE_APPLICATION_CREDENTIALS=/etc/cashflow/google-sa.json

SPREADSHEET_ID=1a2B3cD4eF5gH6iJ7kL8mN9oP0qR

# Interior whitespace is preserved verbatim; no quotes needed for a plain value.
SHEET_RANGE=Cashflow 2026!A1:H
```

### File format rules

All quoted from [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html):

- **Basic shape** — "reads the environment variables from a text file. The text file should contain newline-separated variable assignments."
- **Comments and blank lines** — "Empty lines, lines without an '=' separator, or lines starting with ';' or '#' will be ignored, which may be used for commenting." Note `;` works as well as `#`.
- **Encoding** — "The file must be encoded with UTF-8. Valid characters are unicode scalar values other than unicode noncharacters, U+0000 NUL, and U+FEFF unicode byte order mark. Control codes other than NUL are allowed." A BOM will break it — relevant if the file is ever generated on Windows.
- **Unquoted values** — "an unquoted value after the '=' is parsed with the same backslash-escape rules as POSIX shell unquoted text, but unlike in a shell, interior whitespace is preserved and quotes after the first non-whitespace character are preserved. Leading and trailing whitespace (space, tab, carriage return) is discarded, but interior whitespace within the line is preserved verbatim."
- **Line continuation** — "A line ending with a backslash will be continued to the following one, with the newline itself discarded."
- **Backslashes** — "A backslash `\` followed by any character other than newline will preserve the following character, so that `\\` will become the value `\`." So a literal backslash must be doubled.
- **Single quotes** — "a `'`-quoted value after the '=' can span multiple lines and contain any character verbatim other than single quote, like POSIX shell single-quoted text. No backslash-escape sequences are recognized."
- **Double quotes** — "a `"`-quoted value after the '=' can span multiple lines, and the same escape sequences are recognized as in POSIX shell double-quoted text."

**No shell expansion.** This is the rule people get wrong most often. `Environment=` says: "Variable expansion is not performed inside the strings and the '$' character has no special meaning" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html). For `EnvironmentFile=` paths specifically: "Note that shell variables such as `$HOME` are not expanded in this path. Use '%'-specifiers instead; for example, '%h' expands to the user's home directory" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html). Practical consequences for the env file:

- `KEY_PATH=$HOME/google-sa.json` stays literally `$HOME/google-sa.json`. Write the absolute path.
- `PORT=$(cat /etc/port)` is a literal string. No command substitution.
- `PATH=/opt/bin:$PATH` does **not** append. It sets `PATH` to the literal text.

### `EnvironmentFile=` vs `Environment=`

| | `Environment=` | `EnvironmentFile=` |
| --- | --- | --- |
| Where values live | inline in the unit file | separate file on disk |
| Quoting rules | unit-file quoting per `systemd.syntax(7)` | shell-like rules described above |
| Multi-line values | no | yes, via `'`/`"` quoting or trailing `\` |
| Read timing | at unit load | "shortly before the process is executed" |
| Precedence | lower | **higher** |

- `EnvironmentFile=` is "Similar to `Environment=`, but reads the environment variables from a text file" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html).
- **Precedence** — "Settings from these files override settings made with `Environment=`. If the same variable is set twice from these files, the files will be read in the order they are specified and the later setting will override the earlier setting" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html). So you can put safe defaults in `Environment=` in the unit and let the env file win.
- **Read timing** — the files "will be read shortly before the process is executed (more specifically, after all processes from a previous unit state terminated ... The files are read from the file system of the service manager, before any file system changes like bind mounts take place)" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html). Two useful corollaries: (i) editing the env file needs only `systemctl restart`, **not** `daemon-reload` (see section 6); (ii) because the file is read by the manager before namespacing is applied, `ProtectSystem=`/`ReadOnlyPaths=` from section 4 do **not** interfere with reading it.
- `Environment=` also differs in that it supports specifier expansion: "Specifier expansion is performed, see the 'Specifiers' section in systemd.unit(5)" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html).

### The `-` prefix

"The argument passed should be an absolute filename or wildcard expression. If the file does not exist, cannot be read, or contains invalid content, the service will fail to start. To make the file optional, prefix the path with '-', which causes all errors related to the file to be silently ignored" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html).

**Do not use `-` on the file holding required config.** Without it, a missing or malformed `/etc/cashflow/cashflow.env` fails the start loudly. With it, the service starts with no `SPREADSHEET_ID` and fails at the first Sheets call — a much worse failure mode. Reserve `-` for genuinely optional overlay files.

Also note `EnvironmentFile=` "may be specified more than once in which case all specified files are read", and "If the empty string is assigned to this option, the list of files to read is reset" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html). The reset trick matters for drop-ins: a `.d/override.conf` that wants to *replace* rather than *add* files must first assign `EnvironmentFile=`.

### Ownership and permissions

```bash
sudo install -d -o root -g cashflow -m 0750 /etc/cashflow

# The env file: readable by the service group only.
sudo install -o root -g cashflow -m 0640 /dev/null /etc/cashflow/cashflow.env

# The Google key itself: readable only by the service user.
sudo install -o cashflow -g cashflow -m 0600 google-sa.json /etc/cashflow/google-sa.json
```

Two notes on the common "0600 owned by the service user" advice:

- For the **key file**, `0600 cashflow:cashflow` is right — the Node process reads it as `cashflow`.
- For the **env file**, `0600 cashflow:cashflow` also works, but `0640 root:cashflow` is slightly better: `EnvironmentFile=` is read **by the service manager (PID 1, running as root) before the process is executed** — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html) — so the service user does not strictly need read access to it at all, and `root`-owned means a compromised app process cannot rewrite its own config. Either is defensible; do not make it world-readable.

The systemd docs do not prescribe a mode for `EnvironmentFile=`, so treat the specific octal as convention rather than a documented requirement; what **is** documented is the general warning about world-writable locations — the docs caution to "be careful with `AF_UNIX` file descriptor passing for directories" in world-writable directories — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html).

### Does this keep secrets out of the unit file? Partly — read this carefully

**Yes, for the unit file.** Unit files are world-readable, and the systemd project says so explicitly in the context of inline credentials: `SetCredential=` should "only be used for credentials that aren't sensitive, e.g. public keys or certificates, but not private keys", precisely because "unit files are world-readable (both on disk and via D-Bus)" — [systemd CREDENTIALS documentation](https://systemd.io/CREDENTIALS/). So moving values out of the unit and into a `0640`/`0600` file **does** remove them from a world-readable location. That is a real win, and it is the main thing the ticket asks for.

**But environment variables are not a secure secret channel in general.** The docs are blunt:

> "Note that environment variables are not suitable for passing secrets (such as passwords, key material, ...) to service processes. Environment variables set for a unit are exposed to unprivileged clients via D-Bus IPC, and generally not understood as being data that requires protection. Moreover, environment variables are propagated down the process tree, including across security boundaries (such as setuid/setgid executables), and hence might leak to processes that should not have access to the secret data. Use `LoadCredential=`, `LoadCredentialEncrypted=` or `SetCredentialEncrypted=` ... to pass data to unit processes securely."
> — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html)

Note carefully what this does and does not say. It says variables are exposed **via D-Bus IPC** (i.e. `systemctl show`, which reads the manager's in-memory state) — and this applies to variables loaded from `EnvironmentFile=` too, not only `Environment=`, because both end up in the same computed environment block. Verify on the droplet:

```bash
# Shows the effective environment, including values loaded from EnvironmentFile=.
systemctl show --property=Environment cashflow.service
```

**This is exactly why the design in the ticket is sound.** The env file carries `GOOGLE_APPLICATION_CREDENTIALS=/etc/cashflow/google-sa.json` — a **path**, not key material. The secret itself stays in a `0600` file guarded by filesystem permissions, which is not exposed over D-Bus. Passing a path in the environment and the secret on disk is the right split, and it matches the pattern the credentials docs suggest for `Environment=`: use the `%d` specifier "to build a *path* to a credential file, not to carry the secret itself" — [systemd CREDENTIALS documentation](https://systemd.io/CREDENTIALS/). Do **not** paste the JSON key contents into the env file.

`/proc` exposure is more limited than commonly claimed: `/proc/<pid>/environ` holds "the initial environment that was set when the currently executing program was started via execve(2)", and "Permission to access this file is governed by a ptrace access mode PTRACE_MODE_READ_FSCREDS check" — [proc_pid_environ(5)](https://man7.org/linux/man-pages/man5/proc_pid_environ.5.html). That is not world-readable for another unprivileged user; the D-Bus path above is the practical exposure. Note also that Node cannot hide from it: mutating `process.env` at runtime does not help, since "such modifications will not be reflected outside the Node.js process" — [Node.js process docs](https://nodejs.org/api/process.html#processenv) — and `/proc/<pid>/environ` reflects the *initial* environment regardless.

**Upgrade path if the key ever moves into the env file or you want defence in depth:** `LoadCredential=ID:PATH`. Credential "data is accessible from the unit's processes via the file system, at a read-only location that (if possible and permitted) is backed by non-swappable memory", and "The data is only accessible to the user associated with the unit, via the `User=`/`DynamicUser=` settings (as well as the superuser)" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html). Unlike environment variables, "the credential data is not propagated down the process tree" — [systemd CREDENTIALS documentation](https://systemd.io/CREDENTIALS/). Sketch:

```ini
[Service]
LoadCredential=google-sa:/etc/cashflow/google-sa.json
Environment=GOOGLE_APPLICATION_CREDENTIALS=%d/google-sa
```

Caveat: using credentials changes the implicit service type — `Type=exec` "is implied" when credentials are used — [systemd.service(5)](https://man7.org/linux/man-pages/man5/systemd.service.5.html) — which is already what we set, so no conflict. This is a nice-to-have, not required by the ticket.

## 4. Hardening directives

### Recommended set for this workload

Append to `[Service]`. Every directive here is safe for a localhost-listening Node server that makes outbound HTTPS calls to Google and reads one key file.

```ini
[Service]
# --- Privilege ---
NoNewPrivileges=true
CapabilityBoundingSet=
AmbientCapabilities=

# --- Filesystem ---
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadOnlyPaths=/etc/cashflow
# Only if the app actually writes somewhere. Prefer StateDirectory= (see below).
# ReadWritePaths=/var/lib/cashflow

# --- Kernel / system ---
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
ProtectProc=invisible
PrivateDevices=true
RestrictSUIDSGID=true
RestrictRealtime=true
LockPersonality=true
RestrictNamespaces=true

# --- Network ---
# AF_UNIX is required for journal logging. AF_NETLINK is required by glibc
# getaddrinfo()/getifaddrs() for DNS + interface enumeration — see notes.
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK

# --- Syscalls ---
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM

# --- NOT set, deliberately: MemoryDenyWriteExecute (breaks V8 JIT) ---
```

Verify the result with `systemd-analyze security cashflow.service`, which "analyzes the security and sandboxing settings of one or more specified service units" and produces "an overall exposure level value ... in the range 0.0…10.0 indicating how exposed a service is security-wise" — [systemd-analyze(1)](https://man7.org/linux/man-pages/man1/systemd-analyze.1.html). Its caveats are worth heeding: a high score means only that a service "might benefit from additional settings applied to them", and many settings "individually can be circumvented — unless combined with others" — [systemd-analyze(1)](https://man7.org/linux/man-pages/man1/systemd-analyze.1.html).

### Per-directive verdicts

**`NoNewPrivileges=` — SAFE, set it.** "If true, ensures that the service process and all its children can never gain new privileges through `execve()` (e.g. via setuid or setgid bits, or filesystem capabilities). This is the simplest and most effective way to ensure that a process and its children can never elevate privileges again. Defaults to false" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html). Node never needs to elevate. Caveat: "this setting only has an effect on the unit's processes themselves (or any processes directly or indirectly forked off them)" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html).

**`PrivateTmp=` — SAFE, set it.** "If enabled, a new file system namespace will be set up for the executed processes, and `/tmp/` and `/var/tmp/` directories inside it are not shared with processes outside of the namespace, plus all temporary files created by a service in these directories will be removed after the service is stopped ... Otherwise, defaults to false" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html). Node's `os.tmpdir()` honours `$TMPDIR`/`/tmp` and will land in the private instance transparently. The documented downside is irrelevant here: it "makes sharing between processes via `/tmp/` or `/var/tmp/` impossible" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html) — nothing shares tmp files with Caddy. Note there is also a `disconnected` value backing the dirs with "a completely new tmpfs instance" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html) — but it was "Added in version 258", so plain `true` is the portable choice.

**`ProtectSystem=strict` — SAFE **only if** the app writes nothing outside tmp. This is the #1 breakage risk.** "If set to 'strict' the entire file system hierarchy is mounted read-only, except for the API file system subtrees `/dev/`, `/proc/` and `/sys/` ... It is recommended to enable this setting for all long-running services, unless they are involved with system updates or need to modify the operating system in other ways" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html).

- **WILL BREAK** the service if it writes a log file, a SQLite DB, a cache, a PID file, or an upload directory anywhere on disk. Symptom: `EROFS` / `EACCES` on write.
- Escape hatches, per the docs: "If this option is used, `ReadWritePaths=` may be used to exclude specific directories from being made read-only. Similar, `StateDirectory=`, `LogsDirectory=`, ... also exclude the specific directories from the effect of `ProtectSystem=`" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html).
- Interaction worth knowing: "if `ProtectSystem=` is set to 'strict' and `PrivateTmp=` is enabled, then `/tmp/` and `/var/tmp/` will be writable" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html). So tmp writes keep working with the pair above.
- Reading `/srv/cashflow` and `/etc/cashflow` is unaffected — `strict` makes things read-**only**, not inaccessible.
- Prefer `StateDirectory=cashflow` over `ReadWritePaths=/var/lib/cashflow`: `StateDirectory=` creates the directory, owns it correctly, and exports its path in an environment variable — the directories are created "when the unit is started" and "the corresponding environment variable will be defined with the full paths of the directories" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html).
- Fallback if `strict` proves troublesome: `ProtectSystem=full`, which mounts `/usr/`, the boot dirs, **and** `/etc/` read-only but leaves the rest writable — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html).

**`ProtectHome=` — SAFE if node and the app are NOT under a home directory. Second-biggest breakage risk.** "If true, the directories `/home/`, `/root`, and `/run/user` are made inaccessible and empty for processes invoked by this unit ... It is recommended to enable this setting for all long-running services (in particular network-facing ones), to ensure they cannot get access to private user data" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html).

- **WILL BREAK** the service if node came from **nvm/fnm** (`/home/deploy/.nvm/...`) or if the rsync target is a home directory (`/home/deploy/cashflow`). `ExecStart=` would fail with "No such file or directory" even though the path exists on the host. This is the single most common cause of "works when I run it by hand, fails under systemd".
- The unit in section 1 avoids this by using `/usr/bin/node` and `/srv/cashflow`. **If your deploy rsyncs into a home directory, either move it to `/srv` or use `ProtectHome=read-only`** — "If set to 'read-only', the three directories are made read-only instead" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html).
- Also note "this setting provides no protection if home directories are placed at a non-standard location" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html).
- The `tmpfs` value exists as a middle ground, "useful to hide home directories not relevant to the processes invoked by the unit, while still allowing necessary directories to be made visible when listed in `BindPaths=` or `BindReadOnlyPaths=`" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html).

**`ReadWritePaths=` / `ReadOnlyPaths=` — SAFE, use as the allow-list for `ProtectSystem=strict`.** "Paths listed in `ReadWritePaths=` are accessible from within the namespace with the same access modes as from outside of it. Paths listed in `ReadOnlyPaths=` are accessible for reading only, writing will be refused even if the usual file access controls would permit this ... Use `ReadWritePaths=` in order to allow-list specific paths for write access if `ProtectSystem=strict` is used" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html). Nesting works: "Nest `ReadWritePaths=` inside of `ReadOnlyPaths=` in order to provide writable subdirectories within read-only directories" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html). Use `-` to tolerate absent paths: they "may be prefixed with '-', in which case they will be ignored when they do not exist" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html).

Documented limits, worth being honest about:
- "`ReadWritePaths=` cannot be used to gain write access to a file system whose superblock is mounted read-only" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html).
- Mount propagation leaks: "writable mounts appearing on the host will be writable in the unit's namespace too, even when propagated below a path marked with `ReadOnlyPaths=`! ... the lock-down offered by that setting is not complete, and does not offer full protection" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html).
- "the effect of these settings may be undone by privileged processes. In order to set up an effective sandboxed environment for a unit it is thus recommended to combine these settings with either `CapabilityBoundingSet=~CAP_SYS_ADMIN` or `SystemCallFilter=~@mount`" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html). The empty `CapabilityBoundingSet=` above covers this.
- These settings "disconnect propagation of mounts from the unit's processes to the host", so the unit cannot install mount points — irrelevant for us — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html).

`InaccessiblePaths=` is available but blunter: paths "will be made inaccessible for processes inside the namespace along with everything below them", and "This may be more restrictive than desired, because it is not possible to nest `ReadWritePaths=`, `ReadOnlyPaths=`, `BindPaths=`, or `BindReadOnlyPaths=` inside it" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html). Not needed here.

**`ProtectKernelTunables=` — SAFE, set it.** "If true, kernel variables accessible through `/proc/sys/`, `/sys/`, `/proc/sysrq-trigger`, `/proc/latency_stats`, `/proc/acpi`, `/proc/timer_stats`, `/proc/fs` and `/proc/irq` will be made read-only and `/proc/kallsyms` as well as `/proc/kcore` will be inaccessible ... Few services need to write to these at runtime; it is hence recommended to turn this on for most services" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html). Node reads `/proc` (e.g. for `os.cpus()`, cgroup memory limits) but does not write kernel tunables. Note it makes these read-only, not inaccessible, so reads still work. "Added in version 232."

**`ProtectKernelModules=` — SAFE, set it.** "If true, explicit module loading will be denied ... It is recommended to turn this on for most services that do not need special file systems or extra kernel modules to work" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html). Would only break a native addon that loads kernel modules; none of ours does. "Added in version 232."

**`ProtectKernelLogs=` — SAFE, set it.** "If true, access to the kernel log ring buffer will be denied ... removes `CAP_SYSLOG` from the capability bounding set for this unit, and installs a system call filter to block the `syslog(2)` system call (not to be confused with the libc API `syslog(3)` for userspace logging)" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html). The parenthetical matters: userspace logging via `syslog(3)` and writing to stdout/journal are unaffected. "Added in version 244."

**`ProtectControlGroups=` — SAFE, set it.** "If true, the Linux Control Groups hierarchies accessible through `/sys/fs/cgroup/` will be made read-only to all processes of the unit ... Except for container managers no services should require write access to the control groups hierarchies; it is hence recommended to set `ProtectControlGroups=` to true or 'strict' for most services" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html). Read-only is important to keep: Node reads cgroup files to size its heap on containerised/limited hosts, and `true` preserves reads. Avoid `private`/`strict` for now — they are newer and "are downgraded to false and true respectively unless the system is using the unified control group hierarchy and the kernel supports cgroup namespaces" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html). "Added in version 232."

**`RestrictAddressFamilies=` — SAFE **but** must include `AF_UNIX` and (in practice) `AF_NETLINK`. Naive use BREAKS DNS.** "Restricts the set of socket address families accessible to the processes of this unit. Takes 'none', or a space-separated list of address family names to allow-list, such as `AF_UNIX`, `AF_INET` or `AF_INET6` ... By default, no restrictions apply" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html).

- `AF_INET`/`AF_INET6` are required: they are the families for "IPv4 Internet protocols" and "IPv6 Internet protocols" — [address_families(7)](https://man7.org/linux/man-pages/man7/address_families.7.html) — needed both to listen on localhost and to reach Google over HTTPS.
- `AF_UNIX` is required: "in most cases, the local `AF_UNIX` address family should be included in the configured allow list as it is frequently used for local communication, including for `syslog(2)` logging" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html). Omitting it can break journal logging.
- **`AF_NETLINK` is the one that catches people out.** `AF_NETLINK` is the "Kernel user interface device" — [address_families(7)](https://man7.org/linux/man-pages/man7/address_families.7.html) — and `NETLINK_ROUTE` "Receives routing and link updates and may be used to modify the routing tables (both IPv4 and IPv6), IP addresses, link parameters" — [netlink(7)](https://man7.org/linux/man-pages/man7/netlink.7.html). glibc's `getaddrinfo()` filters results by locally configured address families — IPv4 results are returned "only if the local system has at least one IPv4 address configured", same for IPv6 — [getaddrinfo(3)](https://man7.org/linux/man-pages/man3/getaddrinfo.3.html) — and `getifaddrs()`, which enumerates those addresses, requires kernel netlink support: "Support of address families other than IPv4 is available only on kernels that support netlink" — [getifaddrs(3)](https://man7.org/linux/man-pages/man3/getifaddrs.3.html). **Flag: the man pages document the requirement and the netlink dependency but never state outright "blocking AF_NETLINK breaks getaddrinfo".** That inference is well-established operationally (Node's default DNS resolution goes through `getaddrinfo` in the threadpool), so include `AF_NETLINK` and verify empirically — resolve `sheets.googleapis.com` from the running service before declaring the sandbox good.
- Documented limits: it "restricts access to the `socket(2)` system call only. Sockets passed into the process by other means (for example, by using socket activation with socket units) are unaffected", and it "is limited to some ABIs, in particular x86-64, but currently has no effect on 32-bit x86, s390, s390x, mips, mips-le, ppc, ppc-le, ppc64, or ppc64-le, and is ignored" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html). A DigitalOcean droplet is x86-64 (or arm64), so it is effective. The docs recommend pairing: "it is recommended to combine this option with `SystemCallArchitectures=native`" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html), which the block above does.

**`PrivateDevices=` — SAFE, set it.** "If true, sets up a new `/dev/` mount for the executed processes and only adds API pseudo devices such as `/dev/null`, `/dev/zero` or `/dev/random` (as well as the pseudo TTY subsystem) to it, but no physical devices" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html). Node needs `/dev/urandom` (crypto) and `/dev/null`; both are API pseudo devices and remain available. One documented caveat to be aware of: "The new `/dev/` will be mounted read-only and 'noexec'. The latter may break old programs which try to set up executable memory by using `mmap(2)` of `/dev/zero` instead of using `MAP_ANON`" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html). Modern V8 uses `MAP_ANON`, so this is fine in practice; if a native addon misbehaves, this is a suspect.

**`RestrictSUIDSGID=` — SAFE, set it.** "If set, any attempts to set the set-user-ID (SUID) or set-group-ID (SGID) bits on files or directories will be denied ... it is recommended to restrict creation of SUID/SGID files to the few programs that actually require them" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html). "Added in version 242."

**`RestrictRealtime=` — SAFE, set it.** "If set, any attempts to enable realtime scheduling in a process of the unit are refused ... Realtime scheduling policies may be used to monopolize CPU time ... and may hence be used to lock up or otherwise trigger Denial-of-Service situations" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html).

**`LockPersonality=` — SAFE, set it.** "If set, locks down the `personality(2)` system call so that the kernel execution domain may not be changed from the default ... because odd personality emulations may be poorly tested and source of vulnerabilities" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html). "Added in version 235."

**`ProtectClock=` / `ProtectHostname=` — SAFE, set them.** `ProtectClock=`: "If set, writes to the hardware clock or system clock will be denied ... It is recommended to turn this on for most services that do not need modify the clock or check its state" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html). `ProtectHostname=`: "If set to a true value, changing hostname or domainname via `sethostname()` and `setdomainname()` system calls is prevented" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html). Reading the hostname (`os.hostname()`) still works.

**`ProtectProc=invisible` — SAFE, set it.** "When set to 'invisible' processes owned by other users are hidden from `/proc/` ... It is generally recommended to run most system services with this option set to 'invisible'." Note the precondition: "the root user is unaffected by this option, so to be effective it has to be used together with `User=` or `DynamicUser=yes`" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html). We set `User=cashflow`, so it is effective. "Added in version 247."

**`ProcSubset=pid` — DO NOT SET. Likely to break Node.** "If 'pid', all files and directories not directly associated with process management and introspection are made invisible in the `/proc/` file system ... Note that Linux exposes various kernel APIs via `/proc/`, which are made unavailable with this setting. Since these APIs are used frequently this option is useful only in a few, specific cases, and is not suitable for most non-trivial programs" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html). Node reads `/proc/meminfo`, `/proc/cpuinfo`, `/proc/sys/...`; hiding them is asking for trouble. Skip it.

**`MemoryDenyWriteExecute=` — WOULD BREAK THE SERVICE. DO NOT SET.** This is the clearest hard "no" in the list. "If set, attempts to create memory mappings that are writable and executable at the same time, or to change existing memory mappings to become executable, or mapping shared memory segments as executable, are prohibited ... **Note that this option is incompatible with programs and libraries that generate program code dynamically at runtime, including JIT execution engines**, executable stacks, and code 'trampoline' feature of various C compilers" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html). V8 is a JIT engine; Node will crash or fail to start. (`node --jitless` exists but destroys performance — not a trade worth making for a small HTTP server.)

**`RestrictNamespaces=true` — SAFE for a plain Node server.** It restricts namespace creation. Safe here because our process does not create namespaces — but note it **would break** the service if it ever shells out to Docker, `unshare`, or a sandboxing library. Given it "Defaults to off" behaviour is permissive, setting `true` is a genuine tightening; drop it if you later add container tooling — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html).

**`SystemCallFilter=@system-service` — SAFE, and recommended by the docs as the companion to the network restriction.** "Takes a space-separated list of system call names or system call groups. If this setting is used, system calls executed by the unit processes except for the listed ones will result in the system call being denied (allow-listing) ... The default action when a system call is denied is to terminate the processes with a `SIGSYS` signal. This can changed using `SystemCallErrorNumber=`" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html). Setting `SystemCallErrorNumber=EPERM` turns hard kills into ordinary errors, which is much easier to debug than an unexplained `SIGSYS`. The docs suggest combining the address-family restriction "with `SystemCallFilter=@service`, to only allow a limited subset of system calls" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html); `@system-service` is the broader, more commonly used group for long-running daemons. **Verify empirically** — the man page does not enumerate group contents inline, and a syscall filter is the most likely of these settings to produce a subtle failure. If the service misbehaves, remove this line first.

**`SystemCallArchitectures=native` — SAFE, set it.** "If this setting is used, processes of this unit will only be permitted to call native system calls, and system calls of the specified architectures ... On systems supporting multiple ABIs at the same time — such as x86/x86-64 — it is hence recommended to limit the set of permitted system call architectures so that secondary ABIs may not be used to circumvent the restrictions applied to the native ABI ... setting `SystemCallArchitectures=native` is a good choice for disabling non-native ABIs" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html). "Added in version 209."

**`CapabilityBoundingSet=` (empty) — SAFE.** It "Controls which capabilities to include in the capability bounding set", and "If the empty string is assigned to this option, the bounding set is reset to the empty capability set" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html). Safe because the app binds a **high** port (3000), not 80/443 — Caddy owns the privileged ports. **This would break the service** if you ever changed it to listen on a port below 1024, which needs `CAP_NET_BIND_SERVICE`. In that case use `AmbientCapabilities=CAP_NET_BIND_SERVICE` and add it to the bounding set — but the far better answer is to keep it on a high port behind Caddy, which is already the architecture.

### Breakage summary

| Directive | Verdict for this service |
| --- | --- |
| `MemoryDenyWriteExecute=` | **BREAKS** — V8 JIT is explicitly called out as incompatible |
| `ProcSubset=pid` | **LIKELY BREAKS** — "not suitable for most non-trivial programs" |
| `RestrictAddressFamilies=` without `AF_NETLINK` | **BREAKS DNS** (verify empirically) |
| `RestrictAddressFamilies=` without `AF_UNIX` | **BREAKS** journal/local logging |
| `ProtectHome=true` with node or app under `/home` | **BREAKS** — `ExecStart` path vanishes |
| `ProtectSystem=strict` with any app disk write | **BREAKS** — `EROFS`; add `StateDirectory=`/`ReadWritePaths=` |
| `CapabilityBoundingSet=` (empty) with a port < 1024 | **BREAKS** bind — needs `CAP_NET_BIND_SERVICE` |
| `SystemCallFilter=` | Usually fine; first thing to remove when debugging |
| everything else above | Safe |

Roll these out **incrementally** — add the block, `systemctl restart`, exercise a real Sheets call, and check the journal. Do not apply all of them blind at the same time as a code deploy.

## 5. Logging

### Where stdout/stderr go by default

**Straight to the journal, with no configuration.** `StandardOutput=` "Controls where file descriptor 1 (stdout) of the executed processes is connected to", and the `journal` value "connects standard output with the journal, which is accessible via `journalctl(1)`" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html).

The defaults come from the manager config:

- `StandardOutput=` "defaults to the value set with `DefaultStandardOutput=` in `systemd-system.conf(5)`, which defaults to `journal`" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html), confirmed by `DefaultStandardOutput=journal` in [systemd-system.conf(5)](https://man7.org/linux/man-pages/man5/systemd-system.conf.5.html).
- `StandardError=` "defaults to the value set with `DefaultStandardError=` in `systemd-system.conf(5)`, which defaults to `inherit`" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html), confirmed by `DefaultStandardError=inherit` in [systemd-system.conf(5)](https://man7.org/linux/man-pages/man5/systemd-system.conf.5.html).
- `inherit` for stderr means it follows stdout: "if set to `inherit` the file descriptor used for standard output is duplicated for standard error" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html).

**Net effect: both stdout and stderr land in the journal by default. You do not need `StandardOutput=journal` in the unit** — it is already the default. Including it is harmless documentation, but section 1 omits it deliberately to keep the unit minimal.

### Is app-side logging config needed? No

`console.log()` and `console.error()` write to `process.stdout`/`process.stderr` — "They are used internally by `console.log()` and `console.error()`, respectively" — [Node.js process docs](https://nodejs.org/api/process.html#a-note-on-process-io). systemd captures both. So:

- **Do not** add `winston`/`pino` file transports, log rotation, or a `logs/` directory. journald already handles persistence, rotation, and rate limiting, and a file transport would fight `ProtectSystem=strict` from section 4.
- **Do not** write your own timestamps if you do not want to — journald records its own. Structured JSON logging (e.g. pino to stdout) is still fine and works well with `journalctl -o cat | jq`.
- Avoid `file:`/`append:` redirection to a log file; there is no reason to bypass the journal here.

One real Node caveat that affects logging under systemd: writes to stdout are **asynchronous** when it is a pipe on POSIX. The docs' table: "Files: *synchronous* on Windows and POSIX / TTYs (Terminals): *asynchronous* on Windows, *synchronous* on POSIX / Pipes (and sockets): *synchronous* on Windows, *asynchronous* on POSIX" — [Node.js process docs](https://nodejs.org/api/process.html#a-note-on-process-io). Under systemd, stdout is a socket/pipe to journald, so it is the asynchronous case. The docs warn that asynchronous output may be "not written at all if `process.exit()` is called before an asynchronous write completes" — [Node.js process docs](https://nodejs.org/api/process.html#a-note-on-process-io). **Practical consequence: a fatal-error handler that does `console.error(err); process.exit(1)` can lose the very log line you need to diagnose the crash.** Let the process die naturally on an uncaught exception, or `await` a flush before exiting.

### `journalctl` invocations

```bash
# All logs for the unit, newest at the bottom, jump to the end.
sudo journalctl -u cashflow.service -e

# Follow live (the deploy-watching command).
sudo journalctl -u cashflow.service -f

# Last 200 lines.
sudo journalctl -u cashflow.service -n 200

# Since a wall-clock time / relative time.
sudo journalctl -u cashflow.service --since "2026-08-21 09:00:00"
sudo journalctl -u cashflow.service --since "-15min"
sudo journalctl -u cashflow.service --since today

# This boot only.
sudo journalctl -u cashflow.service -b

# Raw messages with no metadata (nice when the app emits JSON).
sudo journalctl -u cashflow.service -o cat | jq .
```

- `-u` "Show messages for the specified systemd unit"; usefully, it also adds "additional matches for messages from systemd and messages about coredumps for the specified unit" — [journalctl(1)](https://man7.org/linux/man-pages/man1/journalctl.1.html) — so you see systemd's own `Started`/`Failed`/`Start request repeated too quickly` lines interleaved with app output. Prefer `-u` over a bare `_SYSTEMD_UNIT=` match for exactly this reason.
- `-f` / `--follow`: "Show only the most recent journal entries, and continuously print new entries as they are appended to the journal" — [journalctl(1)](https://man7.org/linux/man-pages/man1/journalctl.1.html).
- `-e` / `--pager-end`: "Immediately jump to the end of the journal inside the implied pager tool", and it "implies `--lines=1000`" — [journalctl(1)](https://man7.org/linux/man-pages/man1/journalctl.1.html).
- `-n` / `--lines=`: "Show the most recent journal events and limit the number of events shown"; default is 10 — [journalctl(1)](https://man7.org/linux/man-pages/man1/journalctl.1.html).
- `--since=`/`--until=` accept absolute times, `yesterday`/`today`/`tomorrow`/`now`, and "relative times prefixed with '-' or '+'" — [journalctl(1)](https://man7.org/linux/man-pages/man1/journalctl.1.html).
- `-b` / `--boot`: "Show messages from a specific boot. This will add a match for '_BOOT_ID='" — [journalctl(1)](https://man7.org/linux/man-pages/man1/journalctl.1.html).
- `-o cat` shows "only the actual message of each journal entry with no metadata, not even a timestamp" — [journalctl(1)](https://man7.org/linux/man-pages/man1/journalctl.1.html).

### Filtering to "since the last restart" — the modern way

```bash
# Logs from the current (latest) invocation of the unit only.
sudo journalctl -u cashflow.service -I

# The previous invocation — i.e. what the service said before it crashed.
sudo journalctl -u cashflow.service --invocation=-1

# List invocations with timestamps.
sudo journalctl -u cashflow.service --list-invocations
```

`-I` / `--invocation=` "Show messages from a specific invocation of unit", adding matches for `_SYSTEMD_INVOCATION_ID=` and friends; "`-I` is equivalent to `--invocation=0`, and logs for the latest invocation will be shown", while `0` is the latest and `-1` the one before it. When an offset is used a unit must be named with `-u`/`--user-unit=` — [journalctl(1)](https://man7.org/linux/man-pages/man1/journalctl.1.html). `--list-invocations` "lists a unit's invocation IDs with first/last message timestamps" and requires `-u` — [journalctl(1)](https://man7.org/linux/man-pages/man1/journalctl.1.html).

**Version caveat:** both `-I/--invocation=` and `--list-invocations` were "Added in version 257" — [journalctl(1)](https://man7.org/linux/man-pages/man1/journalctl.1.html) — so they are **not available on Ubuntu 22.04 (systemd 249) or 24.04 (systemd 255)**. Portable fallback using the documented `_SYSTEMD_INVOCATION_ID` field:

```bash
sudo journalctl _SYSTEMD_INVOCATION_ID=$(systemctl show -p InvocationID --value cashflow.service)
```

That idiom is **not** in the man page — the field name and the `FIELD=VALUE` match syntax are documented ("Matches ... in the format 'FIELD=VALUE' ... referring to components of a structured journal entry" — [journalctl(1)](https://man7.org/linux/man-pages/man1/journalctl.1.html)), and `systemctl show` is documented as the machine-readable counterpart to `status` — [systemctl(1)](https://man7.org/linux/man-pages/man1/systemctl.1.html) — but the composition is convention. `--since "-5min"` is the crude-but-always-works alternative.

### Privileges

Reading a system unit's journal needs privilege: "All users are granted access to their private per-user journals", but by default "only root and users who are members of a few special groups are granted access to the system journal", specifically members of `systemd-journal`, `adm`, and `wheel`, who "can read all journal files" — [journalctl(1)](https://man7.org/linux/man-pages/man1/journalctl.1.html). So either use `sudo` or add your account to `adm`/`systemd-journal`. Also note `systemctl status` shows only the last 10 log lines and reports only "runtime status" for the current/most recent invocation — "use `journalctl --unit=`" for history — [systemctl(1)](https://man7.org/linux/man-pages/man1/systemctl.1.html).

## 6. Reload / restart mechanics for the deploy

### The three commands are not interchangeable

| Command | What it acts on | Use when |
| --- | --- | --- |
| `systemctl daemon-reload` | **systemd's** own view of unit files | you edited `cashflow.service` |
| `systemctl restart cashflow` | the **service process** — stop then start | you rsynced new app code, or changed the env file |
| `systemctl reload cashflow` | the **app's own** config, via `ExecReload=` | not applicable to us (no `ExecReload=`) |

- **`restart`** — "Stop and then start one or more units specified on the command line. If the units are not running yet, they will be started" — [systemctl(1)](https://man7.org/linux/man-pages/man1/systemctl.1.html). This is the deploy command. It is a full process replacement, so new `.js` files are picked up (Node caches modules for the process lifetime; nothing short of a new process reloads them). One documented nuance, harmless here: "restarting a unit with this command does not necessarily flush out all of the unit's resources before it is started again", e.g. the file descriptor store persists "as long as the unit has a job pending"; to flush it use explicit `stop` then `start` — [systemctl(1)](https://man7.org/linux/man-pages/man1/systemctl.1.html). We do not use `FileDescriptorStoreMax=`, so `restart` is sufficient.
- **`reload`** — "Asks all units listed on the command line to reload their configuration. **Note that this will reload the service-specific configuration, not the unit configuration file of systemd.** If you want systemd to reload the configuration file of a unit, use the `daemon-reload` command," and the docs illustrate with Apache: "this will reload Apache's `httpd.conf` in the web server, not the `apache.service` systemd unit file." They add: "This command should not be confused with the `daemon-reload` command" — [systemctl(1)](https://man7.org/linux/man-pages/man1/systemctl.1.html). Reloading requires the unit to implement it: `ExecReload=` sets "Commands to execute to trigger a configuration reload in the service" and "Use of this setting is optional" — [systemd.service(5)](https://man7.org/linux/man-pages/man5/systemd.service.5.html). **Our unit has no `ExecReload=`, so `systemctl reload cashflow` is not usable.** The docs confirm the graceful variant's behaviour: `reload-or-restart` will "Reload one or more units if they support it. If not, stop and then start them instead" — [systemctl(1)](https://man7.org/linux/man-pages/man1/systemctl.1.html) — and similarly "When a unit marked for reload does not support reload, restart will be queued" — [systemctl(1)](https://man7.org/linux/man-pages/man1/systemctl.1.html). Use plain `restart` and be explicit.
- **`daemon-reload`** — "Reload the systemd manager configuration. This will rerun all generators, reload all unit files, and recreate the entire dependency tree" — [systemctl(1)](https://man7.org/linux/man-pages/man1/systemctl.1.html). It does **not** touch running processes.

### When is `daemon-reload` required?

| Changed | `daemon-reload`? | `restart`? |
| --- | --- | --- |
| `/etc/systemd/system/cashflow.service` | **YES** | yes |
| a drop-in `cashflow.service.d/*.conf` | **YES** | yes |
| `/srv/cashflow/dist/**` (rsync of app code) | no | **yes** |
| `/etc/cashflow/cashflow.env` | no | **yes** |
| `/etc/cashflow/google-sa.json` | no | **yes** (to re-read it) |

- **Unit file changed → `daemon-reload` required.** The manager caches unit files in memory; without a reload it keeps using the old ones. The docs note the symptom indirectly: `systemctl cat` output "might not match the system manager's understanding of these units" if the on-disk file was updated "without `daemon-reload` intervening" — [systemctl(1)](https://man7.org/linux/man-pages/man1/systemctl.1.html).
- **Env file changed → `daemon-reload` NOT required.** `EnvironmentFile=` contents are read "shortly before the process is executed" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html) — i.e. at each start, not at unit load. A plain `restart` picks up new values. (You *do* need `daemon-reload` if you changed which files the unit reads, since that is a unit-file change.)
- **App files changed → `daemon-reload` NOT required**, only `restart`. `daemon-reload` knows nothing about `dist/server.js`.
- `enable`/`disable` do the reload for you: after `enable`, "the system manager configuration is reloaded (in a way equivalent to `daemon-reload`)" — [systemctl(1)](https://man7.org/linux/man-pages/man1/systemctl.1.html). But if you hand-manage symlinks, "the administrator must make sure to invoke `daemon-reload` manually as necessary" — [systemctl(1)](https://man7.org/linux/man-pages/man1/systemctl.1.html).
- `daemon-reload` is safe to run unconditionally in a deploy script — it is cheap and does not disturb running services. Belt-and-braces is fine.

### Is `systemctl enable --now` the right first-install command? Yes

```bash
# First install, once:
sudo systemctl daemon-reload
sudo systemctl enable --now cashflow.service
```

`enable` "creates the symlinks encoded in the `[Install]` sections", but "Note that this does not have the effect of also starting any of the units being enabled. If this is desired, combine this command with the `--now` switch, or invoke `start` with appropriate arguments later" — [systemctl(1)](https://man7.org/linux/man-pages/man1/systemctl.1.html). The docs stress that enabling and starting are "orthogonal" — [systemctl(1)](https://man7.org/linux/man-pages/man1/systemctl.1.html). So `enable --now` is exactly the "start it, and also bring it back after reboot" command, and it is the right one-liner for a first install. `enable` alone leaves the service down until the next boot; `start` alone leaves it dead *after* the next boot — the reboot-survival requirement needs `enable`.

Note `enable` requires `[Install]` — it "warns for units without install info" — and "enabling a masked unit is not supported and results in an error" — [systemctl(1)](https://man7.org/linux/man-pages/man1/systemctl.1.html). Since `enable` performs its own reload, the explicit `daemon-reload` above is redundant on first install but harmless.

The mirror image for teardown: `disable` "does not stop anything: to stop as well, combine this command with the `--now` switch" — [systemctl(1)](https://man7.org/linux/man-pages/man1/systemctl.1.html).

### Deploy sequence from GitHub Actions

For the steady-state deploy (rsync app files, restart), `daemon-reload` is unnecessary — but including it costs nothing and covers the case where the workflow also syncs the unit file:

```bash
set -euo pipefail

# 1. rsync has already placed new files in /srv/cashflow.

# 2. Only needed if the unit file itself changed. Harmless otherwise.
sudo systemctl daemon-reload

# 3. Clear any start-limit / failed state left by a previous bad deploy (section 2).
sudo systemctl reset-failed cashflow.service || true

# 4. Replace the process. `restart` starts it if it was stopped.
sudo systemctl restart cashflow.service

# 5. Verify — do not assume success.
sudo systemctl is-active cashflow.service
sudo journalctl -u cashflow.service -n 50 --no-pager
```

Step 5 matters because of `Type=exec`: with `Type=simple` a restart would report success even when the binary could not be invoked — "systemctl start command lines for simple services report success even if the service's binary cannot be invoked successfully" — [systemd.service(5)](https://man7.org/linux/man-pages/man5/systemd.service.5.html). With `Type=exec`, a non-zero exit from `systemctl restart` is meaningful, so let the CI step fail on it. `--no-pager` is needed in CI: "Do not pipe output into a pager" — [journalctl(1)](https://man7.org/linux/man-pages/man1/journalctl.1.html).

Sudo scope: the deploy account only needs `daemon-reload`, `reset-failed`, `restart`, and `is-active` for this one unit — worth narrowing in `/etc/sudoers.d/` rather than granting blanket root.

## Contradictions / flags

Nothing contradicts the plan of "systemd service on the droplet, config via `EnvironmentFile=` rather than baked into the unit". That plan is sound and is what the unit in section 1 implements. Six things to be aware of, in rough order of importance:

1. **The docs say environment variables are not a secure secret channel — but the ticket's design sidesteps this.** "Note that environment variables are not suitable for passing secrets (such as passwords, key material, ...) to service processes. Environment variables set for a unit are exposed to unprivileged clients via D-Bus IPC ... Use `LoadCredential=`, `LoadCredentialEncrypted=` or `SetCredentialEncrypted=` ... to pass data to unit processes securely" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html). Note the exposure applies to values loaded from `EnvironmentFile=` too, since both feed the same environment block visible via `systemctl show`. **This is not a contradiction of the plan** because we pass a *path* (`GOOGLE_APPLICATION_CREDENTIALS=/etc/cashflow/google-sa.json`), not the key. The secret stays in a `0600` file protected by filesystem permissions. The spreadsheet ID is low-sensitivity. Flag only if someone later inlines the JSON key into the env file — at that point switch to `LoadCredential=`.

2. **`EnvironmentFile=` does keep secrets out of the world-readable unit file — this part is confirmed.** "Unit files are world-readable (both on disk and via D-Bus)", which is why the project warns against inline sensitive credentials — [systemd CREDENTIALS documentation](https://systemd.io/CREDENTIALS/). So the plan's core premise is correct and documented.

3. **`freedesktop.org` man pages are cited via man7.org.** `www.freedesktop.org/software/systemd/man/latest/*` returned HTTP 403 to every non-browser fetch from this environment. man7.org republishes the same upstream systemd man pages verbatim, so all systemd citations point there. If you want the canonical URLs, substitute `https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html` etc. in a browser — content is identical.

4. **Version-gated directives.** Several recommendations do not exist on older systemd. Run `systemctl --version` on the droplet before using: `RestartSteps=`/`RestartMaxDelaySec=` are "Added in version 254" — [systemd.service(5)](https://man7.org/linux/man-pages/man5/systemd.service.5.html); `journalctl -I/--invocation=` and `--list-invocations` are "Added in version 257" — [journalctl(1)](https://man7.org/linux/man-pages/man1/journalctl.1.html); `PrivateTmp=disconnected` is "Added in version 258" — [systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html). Ubuntu 22.04 ships systemd 249 and 24.04 ships 255, so on either LTS the invocation flags are unavailable (fallback given in section 5) and on 22.04 exponential backoff is unavailable too (use the wider `RestartSec=` from section 2 option (a)).

5. **`StartLimitIntervalSec=`/`StartLimitBurst=` in `[Unit]`, not `[Service]`** — they moved in systemd 230 and "systemd will continue to understand these settings also at the old location, in order to maintain compatibility" — [systemd NEWS](https://github.com/systemd/systemd/blob/main/NEWS). Older tutorials showing them under `[Service]` are legacy-correct but not current. Not a functional contradiction, just a docs-drift trap.

6. **Two inferences that primary sources support only indirectly — verify empirically rather than trusting this document:**
   - **`AF_NETLINK` needed for DNS.** The man pages document that `getaddrinfo()` filters by locally configured address families — [getaddrinfo(3)](https://man7.org/linux/man-pages/man3/getaddrinfo.3.html) — and that `getifaddrs()` needs kernel netlink support for non-IPv4 families — [getifaddrs(3)](https://man7.org/linux/man-pages/man3/getifaddrs.3.html) — and that `AF_NETLINK`/`NETLINK_ROUTE` is the interface for IP address and link information — [netlink(7)](https://man7.org/linux/man-pages/man7/netlink.7.html). **No primary source states outright that blocking `AF_NETLINK` breaks name resolution.** Resolve a Google hostname from the sandboxed service before trusting the address-family list.
   - **The `Start request repeated too quickly` log string.** The *behaviour* is documented — "units which are configured for `Restart=`, and which reach the start limit are not attempted to be restarted anymore" — [systemd.unit(5)](https://man7.org/linux/man-pages/man5/systemd.unit.5.html) — but the exact runtime message appears in no man page. Treat it as observed output, not a contract.

7. **Minor: `After=network-online.target` may be unnecessary for this service.** It "may introduce substantial delays to further execution" and the docs note daemons that merely provide functionality to other hosts usually do not need it — [systemd.special(7)](https://man7.org/linux/man-pages/man7/systemd.special.7.html). A localhost-only listener behind Caddy arguably qualifies. Keeping it is defensive (helps if the app contacts Google at startup); dropping it speeds boot. Not a contradiction, just an over-specification worth a conscious decision.
