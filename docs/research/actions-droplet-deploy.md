# GitHub Actions → build → deploy over SSH to a DigitalOcean droplet

Scope: **public** GitHub repo; Vite + TypeScript frontend + Node server; push to `main`
deploys over SSH to an existing droplet; app runs as a systemd unit behind Caddy.

Every claim below ends in a link to a primary source (GitHub's own docs, the official
`actions/*` repos, the OpenSSH / rsync / sudo / systemd manuals, npm docs, DigitalOcean docs).
Where a primary source is silent, that is flagged rather than papered over.
## 1. The standard build-then-deploy-over-SSH pattern

### 1.1 GitHub does not document a generic VPS/SSH deploy

GitHub's "Deploying to third-party platforms" section only covers Azure App Service,
Azure Static Web Apps, AKS, Amazon ECS, GKE, and Xcode signing — there is no page for a
generic server, VPS, rsync, scp, or FTP target
([GitHub docs](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms)).
The deploy hub itself only links "Configuring and managing deployments" and "Deploying to
third-party platforms"
([GitHub docs](https://docs.github.com/en/actions/how-tos/deploy)).
So the pattern below is assembled from documented primitives (`needs`, `environment`,
`concurrency`, artifacts, secrets, `permissions`) plus the OpenSSH/rsync manuals, not
copied from a single GitHub "deploy to a VPS" tutorial.

### 1.2 Job structure

- Jobs "run in parallel by default"; to serialise them "you can define dependencies on
  other jobs using the `jobs.<job_id>.needs` keyword"
  ([GitHub docs](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)).
- `needs` identifies "any jobs that must complete successfully before this job will run",
  and a failure or skip "applies to all jobs in the dependency chain from the point of
  failure or skip onwards"
  ([github/docs source](https://raw.githubusercontent.com/github/docs/main/data/reusables/actions/jobs/section-using-jobs-in-a-workflow-needs.md)).
- Wrap the deploy job in a deployment environment: "Environments are used to describe a
  general deployment target like `production`", and they let you "require approval for a
  job to proceed, restrict which branches can trigger a workflow" and "limit access to
  secrets"
  ([GitHub docs](https://docs.github.com/en/actions/concepts/workflows-and-actions/deployment-environments)).
  "Any protection rules configured for the environment must pass before a job referencing
  the environment is sent to a runner"; the job "can access the environment's secrets only
  after the job is sent to a runner" (same page).
- Environment syntax accepts a bare name or `name` + `url`, where "The URL maps to
  `environment_url` in the deployments API"
  ([github/docs source](https://raw.githubusercontent.com/github/docs/main/data/reusables/actions/jobs/section-using-environments-for-jobs.md)).
- Serialise production deploys with `concurrency`: only "a single job or workflow using the
  same concurrency group will run at a time", and GitHub's own example for serialised
  releases is `group: production-deploy` with `queue: max`
  ([GitHub docs](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)).
  Do **not** use `cancel-in-progress: true` for a deploy — pairing `queue: max` with it "is
  not allowed and will result in a workflow validation error" (same page), and cancelling
  mid-rsync leaves a half-synced release.
- Trigger only on `main`: `on.push.branches` patterns are matched against the ref name, so
  `main` corresponds to `refs/heads/main`
  ([GitHub docs](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpushbranchesbranches-ignore)).
- Build step: `setup-node` "is the recommended way of using Node.js with GitHub Actions",
  and `npm ci` "is generally faster than running `npm install`" while it "prevents updates
  to the lock file"
  ([GitHub docs](https://docs.github.com/en/actions/tutorials/build-and-test-code/nodejs)).
- `setup-node`'s `cache: npm` caches the **package manager's global data**, not your tree:
  "The action does not cache `node_modules`", and it hashes `package-lock.json` as part of
  the cache key
  ([actions/setup-node README](https://raw.githubusercontent.com/actions/setup-node/main/README.md)).

### 1.3 Making the private key available: `ssh-agent` vs `~/.ssh/id_*`

Both work. The agent route is the better default:

- `ssh-agent` "is a program to hold private keys used for public key authentication", and
  with it "Authentication passphrases and private keys never go over the network"
  ([ssh-agent(1)](https://man.openbsd.org/ssh-agent.1)).
- Starting it prints the shell assignments to `eval`, populating `SSH_AUTH_SOCK` (a
  Unix-domain socket, "accessible only to the current user") and `SSH_AGENT_PID`
  ([ssh-agent(1)](https://man.openbsd.org/ssh-agent.1)).
- `ssh-add` "adds private key identities to the OpenSSH authentication agent"; the agent
  "must be running and the `SSH_AUTH_SOCK` environment variable must contain the name of
  its socket"
  ([ssh-add(1)](https://man.openbsd.org/ssh-add.1)).
- `ssh-add -` reads the key from stdin: in the OpenSSH source, `add_file()` does
  `if (strcmp(filename, "-") == 0) { fd = STDIN_FILENO; filename = "(stdin)"; }`
  ([openssh-portable ssh-add.c](https://raw.githubusercontent.com/openssh/openssh-portable/master/ssh-add.c)).
  Note the man page only documents `-` for `-d` (removal), so stdin-add is a source-verified
  behaviour rather than a documented interface
  ([ssh-add(1)](https://man.openbsd.org/ssh-add.1)).
- If you do write the key to `~/.ssh/id_ed25519` instead, permissions matter: "Identity
  files should not be readable by anyone but the user", and `ssh-add` "ignores identity
  files if they are accessible by others"
  ([ssh-add(1)](https://man.openbsd.org/ssh-add.1)).

Why prefer the agent on a public repo's runner: GitHub's own agent-forwarding page makes the
general argument — it "allows you to use your local SSH keys instead of leaving keys
(without passphrases!) sitting on your server"
([GitHub docs](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/using-ssh-agent-forwarding)).
Applied to a runner, keeping the key in the agent means it is never written to a file that a
later step, a cache action, or an artifact upload could pick up.

Generate a **dedicated** deploy key, Ed25519, per GitHub's key guidance:
`ssh-keygen -t ed25519 -C "your_email@example.com"`
([GitHub docs](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/generating-a-new-ssh-key-and-adding-it-to-the-ssh-agent)).
`actions/checkout` makes the same point for its own `ssh-key` input: "we recommend using a
service account with the least permissions necessary"
([actions/checkout README](https://raw.githubusercontent.com/actions/checkout/main/README.md)).

### 1.4 known_hosts: pin the host key, don't blind-trust

- `StrictHostKeyChecking=yes` means ssh will "never automatically add host keys" and
  "refuses to connect to hosts whose host key has changed", which "provides maximum
  protection against man-in-the-middle (MITM) attacks"
  ([ssh_config(5)](https://man.openbsd.org/ssh_config.5)).
- `accept-new` adds new keys automatically but "will not permit connections to hosts with
  changed host keys"; `no` allows connections to changed-key hosts (same page). For a
  deploy job, use `yes` with a pre-seeded `known_hosts`.
- `UserKnownHostsFile` "Specifies one or more files to use for the user host key database"
  ([ssh_config(5)](https://man.openbsd.org/ssh_config.5)).
- `BatchMode=yes` disables "password prompts and host key confirmation requests" — right for
  "scripts and other batch jobs where no user is present"; default is `no`
  ([ssh_config(5)](https://man.openbsd.org/ssh_config.5#BatchMode)).
- `ssh-keyscan` output is "usable as an ssh(1) known_hosts file", but it "cannot verify the
  authenticity of the host keys it obtains" — so "ssh-keyscan output should be verified out
  of band, or only used directly for host authentication if the network is trusted"
  ([ssh-keyscan(1)](https://man.openbsd.org/ssh-keyscan.1)).
  **Conclusion: run `ssh-keyscan` once on your own machine, verify against the droplet
  console, and store the result as a secret/variable. Do not `ssh-keyscan` inside the
  workflow.** `webfactory/ssh-agent`'s README reaches the same conclusion and notes a host
  key "can safely be committed into the repo" because it is not confidential
  ([webfactory/ssh-agent README](https://raw.githubusercontent.com/webfactory/ssh-agent/master/README.md)).

### 1.5 The canonical rsync step

- rsync's remote shell is chosen "either by using the -e command line option, or by setting
  the RSYNC_RSH environment variable"
  ([rsync(1)](https://download.samba.org/pub/rsync/rsync.1)).
- `-a` = "archive mode is -rlptgoD"; `-z` "compress file data during the transfer";
  `--delete` "delete extraneous files from dest directories" (default mode is
  `--delete-during`); `--exclude=PATTERN` "exclude files matching PATTERN"; `-i`
  "output a change-summary for all updates" (same page).
- Trailing slash: "A trailing slash on the source changes this behavior to avoid creating an
  additional directory level at the destination" — i.e. `dist/` means "copy the contents of
  this directory" (same page).
- "Note that rsync must be installed on both the source and destination machines." (same
  page) — the droplet needs the `rsync` package.
- `--rsync-path=PROGRAM`: "Use this to specify what program is to be run on the remote
  machine to start-up rsync… Note that PROGRAM is run with the help of a shell, so it can be
  any program, script, or command sequence you'd care to run"
  ([rsync.1.md source](https://raw.githubusercontent.com/RsyncProject/rsync/master/rsync.1.md)).
  This is the hook that makes a forced command / `sudo rsync` possible (see §4).
- `ssh` runs commands non-interactively: "If a command is specified, it will be executed on
  the remote host instead of a login shell", `-T` disables pty allocation, and ssh "exits
  with the exit status of the remote command or with 255 if an error occurred"
  ([ssh(1)](https://man.openbsd.org/ssh.1)).
- `-o` "Can be used to give options in the format used in the configuration file… useful for
  specifying options for which there is no separate command-line flag" (same page).

### 1.6 Baseline workflow (plain `ssh`/`rsync`, no marketplace SSH action)

```yaml
name: deploy

on:
  push:
    branches:
      - main

# Least privilege for GITHUB_TOKEN at workflow level.
permissions:
  contents: read

# Serialise production deploys instead of cancelling them mid-transfer.
concurrency:
  group: production-deploy
  queue: max

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v7 # 3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          persist-credentials: false
      - uses: actions/setup-node@v7 # 820762786026740c76f36085b0efc47a31fe5020
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npm run build
      # Stage exactly what ships (see §5).
      - name: Assemble release payload
        run: |
          set -euo pipefail
          mkdir -p release
          cp -R dist release/dist
          cp -R server release/server
          cp package.json package-lock.json release/
      - uses: actions/upload-artifact@v7 # 043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
        with:
          name: release
          path: release
          retention-days: 7

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: production
      url: https://cashflow.example.com
    permissions:
      contents: read
    steps:
      - uses: actions/download-artifact@v8 # 3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c
        with:
          name: release
          path: release

      # --- plain ssh-agent: key lives in memory, never on disk ---
      - name: Start ssh-agent and load deploy key
        env:
          SSH_PRIVATE_KEY: ${{ secrets.DEPLOY_SSH_KEY }}
        run: |
          set -euo pipefail
          eval "$(ssh-agent -s)"
          echo "SSH_AUTH_SOCK=$SSH_AUTH_SOCK" >> "$GITHUB_ENV"
          echo "SSH_AGENT_PID=$SSH_AGENT_PID" >> "$GITHUB_ENV"
          printf '%s\n' "$SSH_PRIVATE_KEY" | ssh-add -

      # Pinned host key from a secret/variable; verified out of band. No ssh-keyscan here.
      - name: Pin droplet host key
        env:
          KNOWN_HOSTS: ${{ secrets.DEPLOY_KNOWN_HOSTS }}
        run: |
          set -euo pipefail
          mkdir -p ~/.ssh && chmod 700 ~/.ssh
          printf '%s\n' "$KNOWN_HOSTS" > ~/.ssh/known_hosts
          chmod 600 ~/.ssh/known_hosts

      - name: Rsync release to droplet
        env:
          DEPLOY_HOST: ${{ secrets.DEPLOY_HOST }}
          DEPLOY_USER: ${{ secrets.DEPLOY_USER }}
        run: |
          set -euo pipefail
          rsync -rlptzi --delete \
            -e "ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$HOME/.ssh/known_hosts" \
            release/ "$DEPLOY_USER@$DEPLOY_HOST:/srv/cashflow/current/"

      - name: Install prod deps and restart service
        env:
          DEPLOY_HOST: ${{ secrets.DEPLOY_HOST }}
          DEPLOY_USER: ${{ secrets.DEPLOY_USER }}
        run: |
          set -euo pipefail
          ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes \
            "$DEPLOY_USER@$DEPLOY_HOST" \
            'set -euo pipefail; cd /srv/cashflow/current && npm ci --omit=dev && sudo -n /usr/bin/systemctl restart cashflow.service'

      - name: Kill agent
        if: always()
        run: ssh-agent -k || true
```

Notes on the YAML above:

- `permissions: contents: read` is what `actions/checkout` itself recommends "unless you
  supply `token` or `ssh-key`"
  ([actions/checkout README](https://raw.githubusercontent.com/actions/checkout/main/README.md)).
- `persist-credentials: false` opts out of storing the Actions token in git config; by
  default checkout configures "the token or SSH key with the local git config" (same page).
  The deploy job never needs a git credential at all.
- I dropped `-a` in favour of `-rlptzi`: `-a` includes `-g` and `-o` (group/owner
  preservation), which a non-root deploy user cannot apply anyway — `-a` is defined as
  "-rlptgoD"
  ([rsync(1)](https://download.samba.org/pub/rsync/rsync.1)).
- Comment-pinning SHAs is shown because "Pinning an action to a full-length commit SHA is
  currently the only way to use an action as an immutable release"
  ([GitHub docs](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions));
  in real use put the SHA in the `uses:` value, not the comment. SHAs resolved from the
  GitHub API for `actions/checkout@v7.0.1`, `actions/setup-node@v7.0.0`,
  `actions/upload-artifact@v7.0.1`, `actions/download-artifact@v8.0.1`.

### 1.7 The de facto marketplace norm

Two third-party actions are the community default and worth naming:

- **`appleboy/ssh-action`** ("🚀 SSH for GitHub Actions") — runs remote commands; inputs
  `host`, `username`, `key`, `port`, `script`, plus `fingerprint` for host verification. Its
  README documents that verifying the fingerprint "helps prevent man-in-the-middle attacks",
  and notes `script_stop` was removed in favour of `set -e`
  ([appleboy/ssh-action README](https://raw.githubusercontent.com/appleboy/ssh-action/master/README.md)).
- **`webfactory/ssh-agent`** — starts the agent, exports `SSH_AUTH_SOCK`, and loads keys; the
  key "is available in memory on the GitHub Action worker node, but never written to disk"
  ([webfactory/ssh-agent README](https://raw.githubusercontent.com/webfactory/ssh-agent/master/README.md)).
  It is essentially the 6 lines of §1.6 packaged, and it deliberately does **not** configure
  `known_hosts` for you (same page).

Neither is documented or endorsed by GitHub. Given GitHub's own warning that "a compromise of
a single action within a workflow can be very significant" and "there is significant risk in
sourcing actions from third-party repositories on GitHub"
([GitHub docs](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)),
the plain-`ssh` baseline above is the recommendation for a public repo holding a droplet
deploy key. If you do adopt one, SHA-pin it.

## 2. Secrets needed

### 2.1 The exact set

Deploy transport (all required):

| Secret | Value | Why it must be a secret |
| --- | --- | --- |
| `DEPLOY_SSH_KEY` | Private half of a dedicated Ed25519 deploy key, PEM-delimited, no passphrase (or paired with a passphrase secret) | Grants shell access to the droplet |
| `DEPLOY_HOST` | Droplet IP or hostname | Not strictly confidential, but keeping it out of logs reduces targeting; can be a repo **variable** instead |
| `DEPLOY_USER` | Dedicated non-root deploy user (§4) | Same as above |
| `DEPLOY_KNOWN_HOSTS` | One or more verified `known_hosts` lines for the droplet | Not confidential — a host key "can safely be committed into the repo" ([webfactory/ssh-agent README](https://raw.githubusercontent.com/webfactory/ssh-agent/master/README.md)) — so a repo variable or a committed file is equally correct |

App config that the **server on the droplet** needs (Google Sheets access, per the repo
README's "Reads a private Google Spreadsheet"):

| Secret | Notes |
| --- | --- |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | The service-account JSON. **Do not store it as one JSON blob** — see §2.2 |
| `GOOGLE_SPREADSHEET_ID` | Low sensitivity but a private-data pointer; keep it a secret or a variable |

**Strong recommendation: do not ship the Google credentials through the workflow at all.**
Put them on the droplet once, in a systemd credential or an `EnvironmentFile`, and let the
deploy job only rsync code and restart the unit. That removes two secrets from a public
repo's blast radius entirely. See §4.5 for the systemd side.

### 2.2 Never store the service-account JSON as a single secret

GitHub is explicit that structured data breaks redaction: "Structured data can cause secret
redaction within logs to fail", because "redaction largely relies on finding an exact match
for the specific secret value" — therefore "do not use a blob of JSON, XML, or YAML (or
similar) to encapsulate a secret value… Instead, create individual secrets for each sensitive
value"
([GitHub docs](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)).
The secrets reference repeats the advice: "avoid using structured data as the values of
secrets"
([GitHub docs](https://docs.github.com/en/actions/reference/security/secrets)).

So if the JSON must transit the workflow, split it — `GOOGLE_SA_CLIENT_EMAIL`,
`GOOGLE_SA_PRIVATE_KEY`, `GOOGLE_SA_PROJECT_ID` — and reassemble on the droplet, or use the
documented large/binary-secret workaround: encrypt locally with
`gpg --symmetric --cipher-algo AES256 my_secret.json`, commit only the `.gpg`, and store just
the passphrase as `LARGE_SECRET_PASSPHRASE`
([GitHub docs](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions)).
Base64 is not a substitute: it "only converts binary to text, and is not a substitute for
actual encryption" (same page).

### 2.3 Mechanics and limits

- Create via Settings → Secrets and variables → Actions → New repository secret, or
  `gh secret set SECRET_NAME < secret.txt`
  ([GitHub docs](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions)).
- Names "Can only contain alphanumeric characters… or underscores", "Must not start with the
  `GITHUB_` prefix", "Must not start with a number", and are "case insensitive when
  referenced"
  ([GitHub docs](https://docs.github.com/en/actions/reference/security/secrets)).
- "Secrets are limited to 48 KB in size"; limits are "up to 1,000 organization secrets, 100
  repository secrets, and 100 environment secrets" (same page). A Google SA JSON is well
  under 48 KB.
- Repository and org secrets are read at queue time; environment secrets load "when a job
  referencing the environment starts" (same page).
- An unset secret "will be an empty string" — so a typo silently yields an empty key rather
  than a failure
  ([GitHub docs](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions)).
- Secrets "cannot be used in `if:` conditionals"; use job-level env vars (same page).
- Prefer env vars or STDIN over command-line args, since processes "may be visible to other
  users (using the `ps` command)"; and quote secrets in shells because they "often contain
  special characters" (same page). The §1.6 workflow follows both (`printf … | ssh-add -`).
- Put the deploy secrets on the **`production` environment**, not at repo level, so they are
  gated: "A workflow job cannot access environment secrets until approval is granted by a
  reviewer"
  ([GitHub docs](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)),
  and "These secrets are only available to workflow jobs that use the environment"
  ([GitHub docs](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)).
  Environment secrets take precedence: "the secret at the lowest level takes precedence"
  ([GitHub docs](https://docs.github.com/en/actions/reference/security/secrets)).

### 2.4 Behaviour in fork / pull-request runs — the part that matters for a public repo

- **The core guarantee**: "With the exception of `GITHUB_TOKEN`, secrets are not passed to the
  runner when a workflow is triggered from a forked repository"
  ([GitHub docs](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions),
  restated at
  [events reference](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)).
  So a fork PR against this public repo cannot read `DEPLOY_SSH_KEY`.
- The fork's `GITHUB_TOKEN` "has read-only permissions in pull requests from forked
  repositories"
  ([GitHub docs](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)).
- Reusable workflows do not inherit secrets — they "must be passed explicitly"
  ([GitHub docs](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions)).
- Dependabot runs "are treated as though they are from a forked repository", get a read-only
  token, and "cannot access any secrets"
  ([GitHub docs](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows),
  [permissions reference](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions)).
- **`pull_request_target` is the hole**: with that trigger "the job receives the base
  repository's `GITHUB_TOKEN` and access to repository and organization secrets", and the
  token gets read/write "even when it is triggered from a public fork"
  ([securely-using-pull_request_target](https://raw.githubusercontent.com/github/docs/main/content/actions/reference/security/securely-using-pull_request_target.md),
  [permissions reference](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions)).
- The "Send write tokens / Send secrets to workflows from pull requests" toggles are **private
  repos only** — they live under "Enabling workflows for forks of private repositories" and
  are "Available to private repositories only"
  ([GitHub docs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository)).
  Nothing to turn off here; the public-repo default is already no-secrets.
- Fork approval defaults: "all first-time contributors require approval to run workflows", and
  the options are "Require approval for first-time contributors who are new to GitHub",
  "Require approval for first-time contributors", and "Require approval for all external
  contributors" (same page). Caveat printed there: for the first two, a user "could meet this
  requirement by getting a simple typo or other innocuous change accepted."
- Critically: `pull_request_target` workflows "will always run, regardless of approval
  settings" (same page).

## 3. Public-repo safety

### 3.1 What redaction does — and does not — do

- Redaction is best-effort, not a guarantee: "Because there are multiple ways a secret value
  can be transformed, automatic redaction is not guaranteed"
  ([GitHub docs](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)).
- Scope is per-job and per-runner: "a secret will only be redacted if it was used within a
  job and is accessible by the runner" (same page).
- **Transformed values are not masked unless you re-register them**: "Registering secrets
  applies to any sort of transformation/encoding as well… If your secret is transformed in
  some way (such as Base64 or URL-encoded), be sure to register the new value as a secret
  too" — and a derived value such as a signed JWT "should be formally registered as a secret"
  (same page). Directly relevant here: base64ing the Google SA JSON produces a string GitHub
  will happily print in full.
- Structured data breaks it (see §2.2): "Structured data can cause secret redaction within
  logs to fail" (same page).
- The manual escape hatch is `add-mask`: "Mask all sensitive information that is not a GitHub
  secret by using `::add-mask::VALUE`. This causes the value to be treated as a secret and
  redacted from logs" (same page). Syntax `echo "::add-mask::Mona The Octocat"`; "Each masked
  word separated by whitespace is replaced with the `*` character"; registration is needed
  "once per value per job"
  ([workflow commands](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands)).
- Masking is **not retroactive**: "Make sure you register the secret with 'add-mask' before
  outputting it in the build logs or using it in any other workflow commands" (same page).
  And once masked "you won't be able to set that value as an output" (same page).
- Categories GitHub scrubs automatically include Azure keys, "HTTP Bearer token headers",
  JWTs, NPM author tokens, NuGet API keys, and GitHub tokens/PATs (`ghp`, `gho`, `ghu`,
  `ghs`, `ghr` prefixes)
  ([secrets reference](https://docs.github.com/en/actions/reference/security/secrets)).
  **An SSH private key is not in that list** — it is only redacted because you stored it as a
  secret.
- If it leaks: "If an unredacted secret is sent to a workflow run log, you should delete the
  log and rotate the secret"
  ([GitHub docs](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)).
- Verify empirically — review logs "after supplying both valid and invalid inputs", because
  tools may route secrets into STDOUT/STDERR (same page).
- One more angle: "GitHub does not redact secrets that are printed in logs"
  ([using-secrets](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions))
  — i.e. redaction is a match-and-replace over known values, not a guard against printing.

### 3.2 `pull_request` vs `pull_request_target`

- `pull_request` from a fork: read-only `GITHUB_TOKEN`, no other secrets
  ([events reference](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)).
  It checks out the **merge branch** by default (`GITHUB_REF` =
  `refs/pull/PULL_REQUEST_NUMBER/merge`), so tests run "against the merged result" (same page).
- `pull_request_target` runs "in the context of the default branch of the base repository",
  which "prevents execution of unsafe code from the head of the pull request that could alter
  your repository or steal any secrets you use in your workflow" — and GitHub's own advice:
  "Avoid using this event if you need to build or run code from the pull request" (same page).
- The warning callout: "Running untrusted code on the `pull_request_target` trigger may lead
  to security vulnerabilities. These vulnerabilities include cache poisoning and granting
  unintended access to write privileges or secrets" (same page).
- The "pwn request": overriding the default to check out the PR head and then run it means
  those commands "run with the base repository's secrets and token"
  ([securely-using-pull_request_target](https://raw.githubusercontent.com/github/docs/main/content/actions/reference/security/securely-using-pull_request_target.md)).
  The rule stated there: you "must ensure the checked-out code is only ever inspected as data
  and never executed."
- Preference order per GitHub: "Avoid using the `pull_request_target` workflow trigger if it's
  not necessary" and "For privilege separation between workflows, `workflow_run` is a better
  trigger"
  ([secure-use reference](https://docs.github.com/en/actions/reference/security/secure-use)).
  But `workflow_run` carries the same warning — it "is able to access secrets and write
  tokens, even if the previous workflow was not"
  ([events reference](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows))
  — and workflows using it "should treat artifacts uploaded from other workflows with caution"
  ([secure-use](https://docs.github.com/en/actions/reference/security/secure-use)).
- `actions/checkout` v7 now blocks this by default: it "refuses to check out fork pull request
  code by default" for `pull_request_target`/`workflow_run`, because executing fork code in
  that trusted context "commonly leads to 'pwn request' vulnerabilities". The opt-out
  `allow-unsafe-pr-checkout` is "intentionally named to be easy to spot in code review and
  static analysis"
  ([actions/checkout README](https://raw.githubusercontent.com/actions/checkout/main/README.md),
  [securely-using-pull_request_target](https://raw.githubusercontent.com/github/docs/main/content/actions/reference/security/securely-using-pull_request_target.md)).
  That protection covers only fork PR refs — "not third-party repos, `git fetch`,
  `gh pr checkout`, or downloaded artifacts" (same page).

### 3.3 `permissions:` and the `GITHUB_TOKEN` default scope

- `permissions` lets you adjust the token "adding or removing access as required, so that you
  only allow the minimum required access"
  ([workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions)).
- **A partial block is an allowlist**: "If you specify the access for any of these
  permissions, all of those that are not specified are set to `none`" (same page). So
  `permissions: contents: read` at workflow level already zeroes everything else.
- `permissions: {}` is documented as the way "to disable permissions for all of the available
  permissions"; `read-all` / `write-all` are the coarse shorthands (same page).
- Scope may sit at workflow level, where "the setting applies to all jobs in the workflow", or
  per job (same page).
- Repo default: for a **new personal-account repo** the token "only has read access for the
  `contents` and `packages` scopes"; the Settings toggle picks between "read and write access
  for all permissions (the permissive setting), or just read access for the `contents` and
  `packages` permissions (the restricted setting)"
  ([GitHub docs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository)).
  **Verify this repo is on the restricted setting** — an older repo may still be permissive.
- GitHub's own recommendation: "It's good security practice to set the default permission for
  the `GITHUB_TOKEN` to read access only for repository contents. The permissions can then be
  increased, as required, for individual jobs"
  ([hardening](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)).
- Fork downgrade: for a fork PR event other than `pull_request_target`, with "Send write
  tokens" off, "the permissions are adjusted to change any write permissions to read only"
  ([workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions)).
- Uncomfortable but load-bearing: "Any user with write access to your repository has read
  access to all secrets configured in your repository"
  ([hardening](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)).

### 3.4 Script injection

- The documented failure mode is interpolating attacker-controlled context (PR title, branch
  name) into `run:`. GitHub's fix: "set the value of the expression to an intermediate
  environment variable", after which the value "is stored in memory and used as a variable,
  and doesn't interact with the script generation process"
  ([hardening](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)).
  Best option is "to create a JavaScript action that processes the context value as an
  argument" (same page). Also "consider using double quote shell variables to avoid word
  splitting" (same page).
- On a public repo, PR titles and branch names come from strangers. The §1.6 workflow uses
  no `${{ github.event.* }}` interpolation anywhere.

### 3.5 Runner and artifact exposure

- Self-hosted runners "should almost never be used for public repositories… because any user
  can open pull requests against the repository and compromise the environment"
  ([hardening](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)).
  Stay on GitHub-hosted `ubuntu-latest`.
- Consequence for droplet firewalling: GitHub-hosted runner IPs are not a usable allowlist —
  "Since there are so many IP address ranges for GitHub-hosted runners, we do not recommend
  that you use these as allowlists for your internal resources", and the API list "is updated
  once a week"
  ([GitHub docs](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)).
  DigitalOcean's recommended baseline is a cloud firewall allowing "SSH connections to the
  Droplet on port 22" from `0.0.0.0/0`
  ([DigitalOcean docs](https://docs.digitalocean.com/products/droplets/getting-started/recommended-droplet-setup/)),
  so `from=` in `authorized_keys` (§4) is not a viable lock either.
- Artifacts: hidden files are excluded by default "to avoid unintentionally uploading
  sensitive information", and if you enable `include-hidden-files` the contents "should be
  validated before enabled this to avoid uploading sensitive information"; exclude with `!`
  negation, e.g. omitting `.production.env`
  ([actions/upload-artifact README](https://raw.githubusercontent.com/actions/upload-artifact/main/README.md)).
- Artifact retention default is 90 days; "you can change this retention period to anywhere
  between 1 day or 90 days" for public repos (400 for private), and the change "only applies
  to new artifacts and log files"
  ([GitHub docs](https://docs.github.com/en/organizations/managing-organization-settings/configuring-the-retention-period-for-github-actions-artifacts-and-logs-in-your-organization)).
- **Flag / gap**: I could not find a GitHub docs statement that public-repo artifacts are
  anonymously downloadable. The artifact-download how-to says only "Read access to the
  repository is required"
  ([GitHub docs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts));
  the REST download endpoint says "OAuth tokens and personal access tokens (classic) need the
  `repo` scope"
  ([REST docs](https://docs.github.com/en/rest/actions/artifacts));
  and `artifact-url` requires that "Users must be logged-in in order for this URL to work"
  ([upload-artifact README](https://raw.githubusercontent.com/actions/upload-artifact/main/README.md)).
  On a public repo, "read access" is everyone. Treat build artifacts as world-readable and
  never put a `.env`, the SA JSON, or `node_modules` containing baked secrets into one.
- Vite specifics worth stating even though it is not a GitHub-doc claim: anything the client
  bundle needs is compiled into `dist/` and therefore public by construction. The Google
  service-account key must be server-side only.

### 3.6 "Do this so nothing leaks" — concrete rules for this repo

1. Deploy workflow triggers on `push` to `main` only. **Never** `pull_request_target` and
   never `workflow_run` chained off a PR build — both "may have repository write access and
   access to referenced secrets"
   ([secure-use](https://docs.github.com/en/actions/reference/security/secure-use)).
2. Keep the CI workflow (`pull_request`) and the deploy workflow (`push`) in separate files.
   CI touches no secrets; only deploy does.
3. Put `permissions: contents: read` at the top of every workflow — specifying any scope sets
   the rest to `none`
   ([workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions)).
4. Set the repo default token permission to restricted in Settings → Actions
   ([GitHub docs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository)).
5. Put `DEPLOY_*` on a `production` **environment** with a required reviewer, so no job reaches
   them without approval
   ([hardening](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)).
   Add a deployment branch rule limiting the environment to `main`
   ([manage-environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)).
6. Never store the Google SA JSON as one secret; split it, or better, keep it only on the
   droplet ([hardening](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)).
7. If you base64 or otherwise transform any secret, `::add-mask::` the transformed value
   before it can be printed (same page,
   [workflow commands](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands)).
8. Never interpolate `${{ github.event.* }}` into `run:`; route through `env:` (same hardening
   page).
9. SHA-pin every third-party action — full-length commit SHA is "the only way to use an action
   as an immutable release" (same page). Consider the repo policy that requires it (same page).
10. Never `echo`/`cat` the key, and never `set -x` in a step that handles it. Pass it via env
    + stdin, not argv, since args "may be visible to other users (using the `ps` command)"
    ([using-secrets](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions)).
11. Do not upload `.env`, credentials, or `node_modules` as artifacts; keep
    `include-hidden-files` off ([upload-artifact README](https://raw.githubusercontent.com/actions/upload-artifact/main/README.md)).
12. Use `persist-credentials: false` on checkout in any job that does not need git auth
    ([actions/checkout README](https://raw.githubusercontent.com/actions/checkout/main/README.md)).
13. Pin the droplet host key from a pre-verified value; never `ssh-keyscan` in-workflow, since
    it "cannot verify the authenticity of the host keys it obtains"
    ([ssh-keyscan(1)](https://man.openbsd.org/ssh-keyscan.1)), and never
    `StrictHostKeyChecking=no` ([ssh_config(5)](https://man.openbsd.org/ssh_config.5)).
14. Set fork-run approval to at least "Require approval for first-time contributors"; prefer
    "all external contributors" given the documented typo bypass
    ([GitHub docs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository)).
15. Review PR diffs touching `.github/workflows/` with extra care before approving a run — the
    docs single these out
    ([GitHub docs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/approve-runs-from-forks)).
16. Enable CodeQL for Actions and/or OpenSSF Scorecards; "CodeQL can scan and detect
    potentially vulnerable GitHub Actions workflows"
    ([secure-use](https://docs.github.com/en/actions/reference/security/secure-use)).
17. Rotate the deploy key on a schedule and immediately on any suspicion; GitHub advises
    periodically reviewing and rotating secrets
    ([hardening](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)).
18. Stay on GitHub-hosted runners (same page).
19. Note there is no OIDC path here. OIDC removes long-lived secrets — "You won't need to
    duplicate your cloud credentials as long-lived GitHub secrets"
    ([GitHub docs](https://docs.github.com/en/actions/concepts/security/openid-connect))
    — but a bare droplet has no OIDC trust broker, so an SSH key is unavoidable. That makes
    §4's key scoping the primary mitigation, not an optional extra.

## 4. SSH key scoping on the droplet

### 4.1 Dedicated non-root user

DigitalOcean's own recommended baseline is "SSH key authentication for a sudo non-`root` user,
no password-based access to `root`, and a cloud firewall to restrict access to SSH only", with
the rationale that root privileges are broader than needed so a sudo user "decreases the risk
of making destructive changes by accident"
([DigitalOcean docs](https://docs.digitalocean.com/products/droplets/getting-started/recommended-droplet-setup/)).
Their cloud-config uses `PermitRootLogin prohibit-password` (not `no`) and validates with
`sshd -t -q` before `systemctl restart sshd` (same page).

Per sshd, `PermitRootLogin` accepts `yes`, `prohibit-password`, `forced-commands-only`, or
`no`, and "The default is prohibit-password"; `no` means "root is not allowed to log in"
([sshd_config(5)](https://man.openbsd.org/sshd_config.5)).
`PasswordAuthentication` "default is yes" — set it to `no`
(same page). `AllowUsers` restricts logins so that "login is allowed only for user names that
match one of the patterns" (same page).

Create a **separate** `deploy` user distinct from your interactive admin user, owning
`/srv/cashflow`. Keys go in `~/.ssh/authorized_keys`, which needs `700` on `~/.ssh` and `600`
on `authorized_keys` — DigitalOcean warns "If they don't, you cannot log in"
([DigitalOcean docs](https://docs.digitalocean.com/products/droplets/how-to/add-ssh-keys/to-existing-droplet/)).
Note also that after creation "you can't add or modify the SSH keys on your Droplet using the
control panel" (same page) — so add the deploy key by hand or via `ssh-copy-id`.

### 4.2 `authorized_keys` options

Per sshd(8):

- `restrict` — "Enable all restrictions, i.e. disable port, agent and X11 forwarding, as well
  as disabling PTY allocation" plus `~/.ssh/rc`, and it automatically picks up "any
  restrictions added in future versions". Individual capabilities can be re-enabled with
  `pty`, `port-forwarding`, `agent-forwarding`, `X11-forwarding`, `user-rc`
  ([sshd(8)](https://man.openbsd.org/sshd.8)). **Always include `restrict`.**
- `command="…"` — "Specifies that the command is executed whenever this key is used for
  authentication" and "The command supplied by the user (if any) is ignored". Note that even
  with a forced command the client can still request forwarding "unless they are explicitly
  prohibited, e.g. using the `restrict` key option" (same page). It "may be superseded by an
  sshd_config(5) `ForceCommand` directive" (same page).
- `SSH_ORIGINAL_COMMAND` — "The command originally supplied by the client is available in the
  `SSH_ORIGINAL_COMMAND` environment variable" (same page). This is what makes a dispatcher
  forced command possible.
- `from="pattern-list"` — "either the canonical name of the remote host or its IP address must
  be present in the comma-separated list of patterns", CIDR allowed; its purpose is to make a
  stolen key harder to abuse (same page).
  **Not usable here**: GitHub-hosted runner IPs are explicitly not recommended as an allowlist
  and rotate weekly
  ([GitHub docs](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)).
  `from=` only becomes viable with larger runners' "Static IP addresses" or self-hosted
  runners (same page) — and self-hosted is ruled out for a public repo (§3.5).
- The individual negatives `no-agent-forwarding`, `no-port-forwarding`, `no-pty`,
  `no-X11-forwarding`, `no-user-rc` are all subsumed by `restrict`
  ([sshd(8)](https://man.openbsd.org/sshd.8)).
- 8-bit-clean channel matters for rsync: with `command=`, you should "avoid requesting a pty or
  use `no-pty`" (same page) — `restrict` covers it, and §1.6 passes `ssh -T`.

### 4.3 Is a forced command workable for rsync-then-restart?

**Yes, with one of two shapes.**

**Option A — `rrsync` + a second key.** `rrsync` is "a script to setup restricted rsync users
via ssh logins"; an SSH login "can be restricted to only allow the running of an rsync
transfer" by "forcing the running of the rrsync script", relying on "a feature of ssh that
allows a command to be forced to run instead of an interactive shell"
([rrsync(1)](https://download.samba.org/pub/rsync/rrsync.1)).
It "validates the path arguments it is sent to try to restrict them to staying within the
specified DIR", refuses `--copy-links` "so that a copy cannot dereference a symlink within the
DIR to get to a file outside the DIR", and refuses `--protect-args` because that "would allow
options to be sent to the server-side that the script cannot check" (same page). Useful flags:
`-wo` ("Allow only writing to the DIR"), `-no-del` ("Disable rsync's `--delete*` and
`--remove*` options"), `-no-overwrite` (same page). Canonical line:

```
command="rrsync -wo /srv/cashflow/current",restrict ssh-ed25519 AAAA... deploy@actions
```

The hard limit: "there can be just one restricted dir per authorized key" (same page) — and
crucially, a key forced to `rrsync` **cannot also restart the service**. That means two keys
(two secrets, two connections) or Option B. Also flag the rrsync bash caveat: bash "may try to
be overly helpful" by running bashrc files before the forced command, so use a simpler login
shell such as dash for the deploy user (same page).

**Option B (recommended) — one forced dispatcher script.** A single `command=` script inspects
`SSH_ORIGINAL_COMMAND` and allows exactly two shapes: an rsync server invocation, and a literal
`cashflow-release` token. This works because the client's original request is preserved in
`SSH_ORIGINAL_COMMAND`
([sshd(8)](https://man.openbsd.org/sshd.8)).

```
# ~deploy/.ssh/authorized_keys  (single line)
command="/usr/local/bin/cashflow-deploy-gate",restrict ssh-ed25519 AAAA... gha-deploy
```

```bash
#!/bin/sh
# /usr/local/bin/cashflow-deploy-gate  — root-owned, mode 0755
# NOTE: under a forced command, "$@" is empty — the client's request arrives only in
# $SSH_ORIGINAL_COMMAND, so the gate must dispatch on that string.
set -eu
case "${SSH_ORIGINAL_COMMAND:-}" in
  # Hand rsync invocations to rrsync, which does the option/path validation properly.
  rsync\ --server\ *)
    exec /usr/bin/rrsync -wo /srv/cashflow/current ;;
  cashflow-release)
    exec /usr/local/bin/cashflow-release ;;
  *)
    echo "rejected: ${SSH_ORIGINAL_COMMAND:-<none>}" >&2; exit 1 ;;
esac
```

```bash
#!/bin/sh
# /usr/local/bin/cashflow-release — root-owned, mode 0755
set -eu
cd /srv/cashflow/current
/usr/bin/npm ci --omit=dev
exec /usr/bin/sudo -n /usr/bin/systemctl restart cashflow.service
```

Caveats to be honest about:

- Pattern-matching rsync's server-side argv is fragile; rsync's own protected-args behaviour and
  option set change between versions, and `rrsync` exists precisely because doing this correctly
  is fiddly — it accepts only "a subset of rsync's options"
  ([rrsync(1)](https://download.samba.org/pub/rsync/rrsync.1)).
  Prefer calling `rrsync` from inside the dispatcher rather than hand-rolling the match.
- `--rsync-path` is how the client asks for a specific remote program: "Note that PROGRAM is run
  with the help of a shell, so it can be any program, script, or command sequence"
  ([rsync.1.md](https://raw.githubusercontent.com/RsyncProject/rsync/master/rsync.1.md)).
  With a forced command the client's `--rsync-path` is what lands in `SSH_ORIGINAL_COMMAND`, so
  the gate must whitelist rather than trust it.
- A forced command is not a full sandbox: sshd's `ForceCommand` docs note "This directive does
  not limit other kinds of access that a client may request via their connection"
  ([sshd_config(5)](https://man.openbsd.org/sshd_config.5)) — hence `restrict` on the key line.

**Pragmatic middle ground** if the dispatcher feels over-engineered for a personal project:
dedicated non-root `deploy` user + `restrict` (no forced command) + `sudoers` limited to the one
`systemctl restart` line + the deploy user owning only `/srv/cashflow`. That bounds the damage
without the argv-matching fragility.

If you do adopt the gate, the §1.6 workflow changes: the final `ssh … 'cd … && npm ci …'` step
becomes `ssh … cashflow-release`, because the forced command means "The command supplied by the
user (if any) is ignored"
([sshd(8)](https://man.openbsd.org/sshd.8)).

### 4.4 Restarting the unit without full root

`systemctl restart` "Stop and then start one or more units specified on the command line"
([systemctl(1)](https://man.archlinux.org/man/systemctl.1)).
Acting on a system unit is an authenticated operation — the same page documents
`--no-ask-password` as "Do not query the user for authentication for privileged operations",
which is what makes it privileged (same page). So grant exactly that one command via sudoers.

`sudoers` semantics that make this safe:

- NOPASSWD: "This behavior can be modified via the `NOPASSWD` tag", and it is positional —
  "the NOPASSWD tag sets a default for the commands that follow it in the Cmnd_Spec_List"
  ([sudoers(5)](https://www.sudo.ws/docs/man/sudoers.man/)).
- **Arguments must be constrained or the grant is unbounded**: "If no command line arguments are
  specified, the user may run the command with any arguments they choose." When arguments are
  given, "the arguments in the Cmnd must match those given by the user on the command line"
  (same page). A bare `/usr/bin/systemctl` grant = root.
- Wildcards are dangerous: "Wildcards in command line arguments should be used with care"
  because "Wildcards can match any character, including white space"; "In most cases, it is
  safer to use a regular expression to match command line arguments" (same page).
- Commands must be "a fully qualified file name" (same page).
- Drop-in files: `@includedir /etc/sudoers.d` exists so rules can live in separate files;
  "Files are parsed in sorted lexical order", and files "ending in `~` or containing `.`" are
  skipped. Edit with `visudo -f /etc/sudoers.d/yourfile`, because "`visudo` will not edit the
  files in a `@includedir` directory unless one of them contains a syntax error" (same page).
- `sudo -n` / `--non-interactive`: "Avoid prompting the user for input of any kind" — if a
  password is needed sudo "will display an error message and exit"
  ([sudo(8)](https://www.sudo.ws/docs/man/sudo.man/)).
  Use `-n` in CI so a misconfigured sudoers fails loudly instead of hanging.

The one line (in `/etc/sudoers.d/010-cashflow-deploy`, no dot in the filename, mode `0440`):

```
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart cashflow.service
```

If you also want status/reload, list them explicitly rather than widening:

```
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart cashflow.service, \
                            /usr/bin/systemctl status cashflow.service, \
                            /usr/bin/systemctl is-active cashflow.service
```

Two further notes:

- Do **not** use `ALL` as the command — "it allows the user to run any command on the system",
  and matching `ALL` "implies the `SETENV` tag unless you add `NOSETENV`"
  ([sudoers(5)](https://www.sudo.ws/docs/man/sudoers.man/)).
- Optional hardening: a `Digest_Spec` pins the binary — "the command will only match
  successfully if it can be verified using one of the SHA-2 digests in the list" — but note the
  documented race if the user can write to the command (same page). Not worth it here since
  `/usr/bin/systemctl` is root-owned.
- Also viable per systemd: run the app as a **user service** under the deploy user, in which
  case no sudo is needed at all — but that changes the Caddy/boot story, so it's a design
  choice, not a drop-in.

### 4.5 Keep app secrets on the droplet, out of the workflow

systemd is explicit that env vars are the wrong place for a service-account key:

> "Note that environment variables are not suitable for passing secrets (such as passwords, key
> material, …) to service processes. Environment variables set for a unit are exposed to
> unprivileged clients via D-Bus IPC… Moreover, environment variables are propagated down the
> process tree, including across security boundaries (such as setuid/setgid executables), and
> hence might leak… Use `LoadCredential=`, `LoadCredentialEncrypted=` or
> `SetCredentialEncrypted=` (see below) to pass data to unit processes securely."
> ([systemd.exec source](https://raw.githubusercontent.com/systemd/systemd/main/man/systemd.exec.xml))

`LoadCredential=ID:PATH` makes the data "accessible from the unit's processes via the file
system, at a read-only location that (if possible and permitted) is backed by non-swappable
memory"; it "is only accessible to the user associated with the unit", exported via
`$CREDENTIALS_DIRECTORY` (same source). systemd's design doc adds: "Access to credentials is
restricted to the service's user", "each time a credential is accessed an access check is
enforced by the kernel", and "Unlike environment variables the credential data is not
propagated down the process tree"
([systemd.io/CREDENTIALS](https://systemd.io/CREDENTIALS/)).
It also warns that `SetCredential=` in a unit file is the wrong place for secrets, since "unit
files are world-readable (both on disk and via D-Bus)" (same page).

```ini
# /etc/systemd/system/cashflow.service
[Unit]
Description=cashflow server
After=network-online.target

[Service]
Type=simple
User=cashflow
Group=cashflow
WorkingDirectory=/srv/cashflow/current
# Non-secret config only.
Environment=NODE_ENV=production
Environment=PORT=3000
EnvironmentFile=-/etc/cashflow/env
# Secrets: root-owned 0400 file, exposed only to this unit's user.
LoadCredential=google-sa:/etc/cashflow/google-sa.json
ExecStart=/usr/bin/node server/index.js
Restart=on-failure
# Reachable only via Caddy.
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/srv/cashflow/current

[Install]
WantedBy=multi-user.target
```

The server reads the key at `${CREDENTIALS_DIRECTORY}/google-sa`. `EnvironmentFile=` "reads the
environment variables from a text file" containing "newline-separated variable assignments",
and prefixing the path with `-` "causes all errors related to the file to be silently ignored"
— otherwise a missing file means "the service will fail to start"
([systemd.exec source](https://raw.githubusercontent.com/systemd/systemd/main/man/systemd.exec.xml)).
Those files "will be read shortly before the process is executed", so a restart is enough to
pick up changes (same source).

**Net effect: `GOOGLE_SERVICE_ACCOUNT_KEY` never becomes a GitHub secret at all.**

## 5. Artifact vs source: what actually ships

### Option A — ship `dist/` + server + `package.json` + lockfile, run `npm ci --omit=dev` on the droplet

`npm ci` is documented for exactly this: "automated environments such as test platforms,
continuous integration, and deployment"
([npm docs](https://docs.npmjs.com/cli/v10/commands/npm-ci)).
Its guarantees:

- "The project **must** have an existing `package-lock.json` or `npm-shrinkwrap.json`" — so the
  lockfile must be in the payload (same page).
- "If a `node_modules` is already present, it will be automatically removed before `npm ci`
  begins its install" — no drift from a previous release (same page).
- "It will never write to `package.json` or any of the package-locks: installs are essentially
  frozen" (same page).
- "If dependencies in the package lock do not match those in `package.json`, `npm ci` will exit
  with an error, instead of updating the package lock" (same page).
- `--omit=dev`: "Dependency types to omit from the installation tree on disk"; the omitted deps
  "are still resolved and added to the `package-lock.json`… just not physically installed on
  disk"; and if the omit list includes `dev`, "the `NODE_ENV` environment variable will be set
  to `'production'` for all lifecycle scripts"
  ([npm config docs](https://docs.npmjs.com/cli/v10/using-npm/config)).
  `--production` is deprecated — "DEPRECATED: Use `--omit=dev` instead" (same page).
- Gotcha: flags that alter tree shape (`--legacy-peer-deps`, `--install-links`) used when
  generating the lockfile "must be repeated for `npm ci`, or errors are likely"; commit an
  `.npmrc` if so ([npm ci docs](https://docs.npmjs.com/cli/v10/commands/npm-ci)).

**Pros**: small transfer (no `node_modules`); native modules compile against the droplet's own
Node/libc rather than the runner's; the deployed tree is exactly reproducible from the lockfile;
no risk of rsyncing a runner-only artifact.
**Cons**: the droplet needs network access to the npm registry at deploy time; a registry outage
or a yanked package breaks the deploy; `npm ci` deletes `node_modules` first, so there is a
window where the tree is incomplete; install time is on the critical path of the restart.

### Option B — build everything in CI and rsync `node_modules` too

**Pros**: the droplet needs no registry access and no npm at deploy time; the deploy is a pure
file copy plus a restart, so it is faster and atomic-ish; identical bits from artifact to server.
**Cons**: `node_modules` is thousands of files, which makes rsync slow and `--delete` risky;
native/prebuilt binaries are compiled for the **runner's** platform, which is only safe if the
runner and droplet match (both `ubuntu-latest`-era x86_64 with the same Node major — verify, do
not assume); artifact hygiene gets harder — remember hidden files are excluded "to avoid
unintentionally uploading sensitive information"
([upload-artifact README](https://raw.githubusercontent.com/actions/upload-artifact/main/README.md)),
and on a public repo you should treat artifacts as world-readable (§3.5); artifacts also count
against a storage quota, with GitHub Free at "500 MB"
([GitHub docs](https://docs.github.com/en/actions/reference/limits)).
Note the CI cache does not help here either: `setup-node`'s cache "does not cache
`node_modules`"
([setup-node README](https://raw.githubusercontent.com/actions/setup-node/main/README.md)).

### Recommendation: Option A

For a Vite + TS frontend and a small Node server, ship the built `dist/`, the server source,
`package.json`, and `package-lock.json`, then `npm ci --omit=dev` on the droplet. It keeps the
transfer small, keeps native deps correct for the droplet, and gets `npm ci`'s frozen-lockfile
guarantees. The Vite build output is static and needs no runtime deps at all — Caddy serves it —
so only the server's production dependencies are installed.

Two refinements worth adopting:

1. **Release directories + symlink swap** instead of rsyncing over the live tree, so `npm ci`'s
   `node_modules` deletion never happens under a running process. rsync to
   `/srv/cashflow/releases/<sha>/`, install, then repoint `/srv/cashflow/current` and restart.
   Use `--link-dest` semantics or a plain `cp -al` of the previous release to keep transfers
   incremental.
2. **Use the artifact as the handoff between jobs, not as the deploy channel.** Artifacts are
   documented for exactly this — "Jobs that are dependent on a previous job's artifacts must
   wait for the dependent job to complete successfully"
   ([GitHub docs](https://docs.github.com/en/actions/tutorials/store-and-share-data)),
   and artifacts "cannot be used interchangeably" with caches
   ([GitHub docs](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts)).
   Keep `retention-days` short (min 1, max 90 for public repos)
   ([upload-artifact README](https://raw.githubusercontent.com/actions/upload-artifact/main/README.md),
   [retention docs](https://docs.github.com/en/organizations/managing-organization-settings/configuring-the-retention-period-for-github-actions-artifacts-and-logs-in-your-organization)).
   Note artifacts are zipped, and "All directories will have `755` and all files will have
   `644`" — tar first with `archive: false` if you need to preserve modes
   ([upload-artifact README](https://raw.githubusercontent.com/actions/upload-artifact/main/README.md)).
   Also note v4+ artifacts "are immutable", so names must be unique per run (same page).

If you later add a build step that genuinely cannot run on the droplet, Option B becomes
defensible — but pin the runner image and the Node major to match the droplet explicitly rather
than relying on `ubuntu-latest`.

## Contradictions / flags

1. **GitHub documents no VPS/SSH deploy pattern at all.** Every page under "Deploying to
   third-party platforms" targets Azure, AWS ECS, or GKE
   ([GitHub docs](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms)).
   The "standard pattern" in §1 is assembled from documented primitives plus OpenSSH/rsync
   manuals — there is no GitHub-blessed reference workflow to conform to. Anything presented
   online as "the GitHub way to deploy over SSH" is community convention.

2. **The whole approach is the one GitHub steers away from.** GitHub's stated direction is OIDC
   with short-lived tokens — "You won't need to duplicate your cloud credentials as long-lived
   GitHub secrets"
   ([GitHub docs](https://docs.github.com/en/actions/concepts/security/openid-connect)).
   A bare droplet has no OIDC trust broker, so a long-lived SSH private key in repository
   secrets is unavoidable. This is a real, documented deviation from best practice, mitigated
   only by key scoping (§4) and environment gating.

3. **`from=` IP pinning is not available.** The natural hardening for a deploy key —
   `from="…"` in `authorized_keys`
   ([sshd(8)](https://man.openbsd.org/sshd.8)) — conflicts with GitHub's own statement that
   runner ranges are unsuitable as allowlists and rotate weekly
   ([GitHub docs](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)).
   The workarounds (static-IP larger runners, self-hosted runners) are respectively paid and
   explicitly discouraged for public repos
   ([hardening](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)).
   So the droplet's SSH port stays open to the internet, matching DigitalOcean's own
   `0.0.0.0/0` port-22 baseline
   ([DigitalOcean docs](https://docs.digitalocean.com/products/droplets/getting-started/recommended-droplet-setup/)).

4. **`rrsync`'s one-directory limit conflicts with rsync-then-restart.** "there can be just one
   restricted dir per authorized key", and a key forced to `rrsync` cannot also invoke
   `systemctl`
   ([rrsync(1)](https://download.samba.org/pub/rsync/rrsync.1)).
   So a pure forced-command design needs either two keys (two secrets) or a custom dispatcher
   whose argv matching is version-fragile. §4.3 Option B is a reasonable compromise but is my
   construction, not documented practice.

5. **`restrict` disables PTY, and `--rsync-path` gives the client a shell.** `command=` runs
   "with the help of a shell" on the rsync side
   ([rsync.1.md](https://raw.githubusercontent.com/RsyncProject/rsync/master/rsync.1.md)),
   and sshd notes `ForceCommand` "does not limit other kinds of access that a client may
   request via their connection"
   ([sshd_config(5)](https://man.openbsd.org/sshd_config.5)).
   A forced command is a narrowing, not a jail. Do not treat it as a sandbox.

6. **`ssh-add -` is source-verified, not documented.** The man page documents `-` only for `-d`
   (removal) ([ssh-add(1)](https://man.openbsd.org/ssh-add.1)); the stdin-add path is visible in
   `ssh-add.c` (`if (strcmp(filename, "-") == 0) { fd = STDIN_FILENO; … }`)
   ([openssh-portable](https://raw.githubusercontent.com/openssh/openssh-portable/master/ssh-add.c)).
   It is stable and widely relied on, but it is an undocumented interface. Writing the key to a
   `600` file and `ssh-add`ing that is the documented alternative — at the cost of the key
   touching disk.

7. **Artifact visibility on public repos is a documentation gap.** No GitHub page I found states
   whether public-repo artifacts are anonymously downloadable; docs say only "Read access to the
   repository is required"
   ([GitHub docs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts))
   and that `artifact-url` requires being logged in
   ([upload-artifact README](https://raw.githubusercontent.com/actions/upload-artifact/main/README.md)).
   Since read access on a public repo is everyone, treat artifacts as public. Same gap for
   workflow logs — the docs never state public visibility explicitly, but assume it.

8. **Deployment environments on free public repos.** Environments are available "limited to
   public repos" on Free plans
   ([GitHub docs](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments))
   — so this works here, but note that if the repo were ever made **private**, "Downgrading a
   public repo to private causes configured rules and environment secrets to be ignored" (same
   page). A visibility change would silently drop the protection on the deploy secrets.

9. **Environment auto-creation is a soft spot.** "Running a workflow that references an
   environment that does not exist will create an environment with the referenced name" with no
   rules or secrets, and "Anyone able to edit workflows can spawn one" (same page). A typo in
   `environment: prodution` therefore yields an unprotected environment rather than an error —
   and no secrets, meaning the deploy fails with an empty key rather than loudly.

10. **`concurrency` + `cancel-in-progress` is a trap for deploys.** The common copy-paste
    (`cancel-in-progress: true`) would kill a job mid-rsync, leaving a partially synced release.
    `queue: max` is the documented serialising form, and combining the two "is not allowed and
    will result in a workflow validation error"
    ([workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)).

11. **Redaction is weaker than it feels.** "automatic redaction is not guaranteed", structured
    data breaks it, and transformed values are unmasked unless re-registered
    ([hardening](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)).
    A Google service-account JSON stored as a single secret is precisely the documented
    anti-pattern — the strongest argument for keeping it on the droplet (§4.5) and out of Actions
    entirely.

12. **systemd contradicts the common "put secrets in `EnvironmentFile`" advice.** Environment
    variables "are not suitable for passing secrets" because they are "exposed to unprivileged
    clients via D-Bus IPC" and "propagated down the process tree"
    ([systemd.exec source](https://raw.githubusercontent.com/systemd/systemd/main/man/systemd.exec.xml)).
    If the server currently reads the Google key from an env var, that is a defect worth fixing
    with `LoadCredential=`.

13. **Restarting a system unit needs privilege the deploy user should not have.** The sudoers
    grant must include the arguments — "If no command line arguments are specified, the user may
    run the command with any arguments they choose"
    ([sudoers(5)](https://www.sudo.ws/docs/man/sudoers.man/)).
    A bare `NOPASSWD: /usr/bin/systemctl` grant is equivalent to root. Running the app as a
    systemd **user** service would remove the need for sudo altogether, but changes the boot and
    Caddy story.

14. **Caddy is untouched by all of the above.** Nothing in the deploy flow restarts or reloads
    Caddy. If a release ever changes the reverse-proxy port or the static root, that is a
    separate, manual (or separately sudo-scoped) step. Worth deciding explicitly rather than
    discovering it during a deploy.

15. **Repo state check.** The repo currently contains only `README.md` and `.gitignore` — there
    is no `package.json`, no lockfile, no `server/`, no `.github/workflows/`, and no `.nvmrc`.
    Every path in the §1.6 workflow (`server/index.js`, `.nvmrc`, `npm run build`) is therefore
    assumed and must be reconciled with the actual project layout once it exists.
