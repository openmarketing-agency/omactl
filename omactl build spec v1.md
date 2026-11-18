# omactl: build spec v1

Nov 17, 2026 · @Suraj Jha

## 1. Overview

`omactl` is a single-binary CLI that installs, runs, backs up, updates and repairs the self-hosted apps inside one Open Marketing Agency (OMA) instance. It is the infrastructure helper behind OMA.

Each machine (a per-user VM in OMA Cloud, or a self-hoster's server) runs only `omactl` and Docker. Everything else runs in containers.

| Caller | How it uses omactl |
| --- | --- |
| OMA maintenance agent (Hermes) | Shell commands with `--json`; reads structured output and exit codes |
| Scheduled jobs | systemd timers (Linux, WSL2) or launchd (macOS) running omactl subcommands |
| Humans (OMA ops, self-hosters) | The same commands over SSH, with readable text output |

**Goals for v1**

- Install any catalog app at runtime, with dependencies, routing, secrets and setup, in one command.
- Prove apps work with functional checks (`verify`), never just a running container or an HTTP 200.
- Back up before every change and nightly; restore any app to a chosen snapshot.
- Update apps from versioned catalog releases, with automatic rollback on failure.
- Keep instance-local fixes in override files that survive updates and can be reported upstream.
- Behave the same on every supported platform.
- Be fully operable by an AI agent: non-interactive, JSON everywhere, plan before apply, stable exit codes.

**Non-goals for v1**

- No daemon, web UI or HTTP API.
- No multi-machine control. Each instance manages only itself; fleet rollout happens through release channels.
- No Kubernetes, no native Windows (WSL2 only), no Podman.
- No end-user features. OMA users never see omactl.
- No real marketing apps in this build. The catalog holds only Traefik (a system app) and the test fixtures. Real apps (Ghost first) are added later as catalog folders.

**Glossary**: *catalog* = versioned set of app definitions; *app* = one catalog entry, run as one Compose project; *instance* = one machine managed by one omactl; *op* = one run of a mutating command, with an id and a journal entry.

## 2. Tech stack and portability rules

omactl is TypeScript compiled into standalone executables with `bun build --compile`; at runtime the host needs nothing but Docker.

**Build targets**: `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-x64`, `bun-darwin-arm64`, `bun-linux-x64-musl`, `bun-linux-arm64-musl`. Windows users run the Linux build inside WSL2. Pin the Bun version in `package.json` and in CI.

| Need | Library or API |
| --- | --- |
| CLI parsing | `commander` |
| Schemas and validation | `zod`, with JSON Schema export for manifests and every `--json` output |
| YAML | `yaml` |
| Config history | `isomorphic-git` (never the `git` binary) |
| HTTP | built-in `fetch` |
| Hashes and signatures | built-in `crypto` (SHA-256, Ed25519) |
| Processes | `Bun.spawn` |
| Tests | `bun test` |

Every dependency must be pure JavaScript, with no native addons. Adding one needs a one-line justification in the PR.

**Host requirements**: Docker Engine, Docker Desktop, OrbStack or Colima, with the Compose v2 plugin. Keep minimum versions in one constant; start at Engine 24.0 and Compose 2.24 and adjust after testing. No bash, git, restic, curl, jq or Python is required on the host.

**Portability rules** (code review checklist)

1. The only program omactl executes is `docker`. Exception: `src/platform/` may call `systemctl` and `launchctl`.
2. Use Docker JSON output (`--format json`) everywhere. Never parse table output.
3. Never assume a Docker socket path. The `docker` CLI resolves the active context (`DOCKER_HOST`, `docker context`).
4. App data lives only in named Docker volumes. No host bind mounts for app data or config.
5. Build paths with `node:path`. No hard-coded separators or absolute paths outside `src/platform/`.
6. All app logic (setup, verify, dumps, restic, writing files into volumes) runs inside containers.
7. Every image is pinned by tag and digest and published for `linux/amd64` and `linux/arm64`.
8. Files written by omactl use LF line endings and explicit file modes.
9. `process.platform` checks appear only in `src/platform/`.
10. Every Docker call has a timeout; image pulls retry 3 times with backoff.

## 3. Architecture and on-disk layout

All instance state lives in one directory, `OMA_HOME`. Each app is a Compose project built from three layered files, and Traefik is the only service that binds host ports.

&#91;embedded content: instance architecture · omactl, Docker, Traefik, apps, backups, releases\]

omactl drives Docker only through its CLI. Traefik is the only way in, restic runs only during backups, and releases are pulled, never pushed.

**OMA\_HOME** is `$OMA_HOME` if set, else `~/.oma`. OMA Cloud images set `OMA_HOME=/srv/oma`.

```text
$OMA_HOME/
  omactl.yml                  instance config
  catalog/                    current catalog release (read-only, replaced on update)
  apps/<appId>/
    compose.yml               from catalog; replaced on update; never edited locally
    compose.generated.yml     rendered by omactl (labels, networks, restart policy)
    compose.override.yml      local fixes; never touched by updates
    hooks/                    copied from catalog
    .env                      generated secrets and settings (0600, not in git)
    app.lock.json             installed version, desired state, links, domains, outputs, timestamps
  system/traefik/
    traefik.yml               static config (rendered)
    dynamic/<appId>.yml       routes per app (rendered)
  secrets/                    backup.env, restic password, heartbeat token (0600, not in git)
  state/lock                  global mutation lock
  state/catalog.lock.json     catalog version, channel, sha256, signature status
  state/ops/<opId>.json       operation journal
  logs/omactl.jsonl           structured logs, secrets redacted
  .git/                       config history (isomorphic-git)
```

Git tracks `omactl.yml`, `apps/*/compose*.yml`, `apps/*/app.lock.json` and `system/`. It ignores `.env`, `secrets/`, `state/`, `logs/` and `catalog/`.

**omactl.yml**

```yaml
instance_id: inst_7f3a2c          # generated at init
base_domain: localhost            # apps get <appId>.<base_domain>
ingress:
  http_port: 80
  https_port: 443
  tls: off                        # off | acme
  acme_email: null
channel: stable                   # stable | canary | pinned
release_url: https://releases.openmarketing.agency
updates: notify                   # auto | notify | off
backup:
  repository: null                # s3:https://<account>.r2.cloudflarestorage.com/<bucket>/<instance_id>, or a local path
  policy: self-managed            # self-managed: omactl may prune | central: never prune
  nightly_window: "01:00-05:00"
heartbeat:
  url: null                       # optional, off by default
```

**Compose layers.** Every Compose call for an app runs from `apps/<appId>/` as:

`docker compose -p oma-<appId> --env-file .env -f compose.yml -f compose.generated.yml [-f compose.override.yml] <subcommand>`

| Layer | Owner | Holds |
| --- | --- | --- |
| `compose.yml` | Catalog | The app definition, unchanged |
| `compose.generated.yml` | omactl | Labels `oma.managed=true`, `oma.app`, `oma.catalog`; the `oma_edge` network on the main service; `restart: unless-stopped` |
| `compose.override.yml` | Maintenance agent or operator | Local fixes only; left out of the command when absent |

`.env` feeds Compose `${VAR}` interpolation only. Catalog compose files map each variable to the services that need it.

**Networking**

- `init` creates one shared external network, `oma_edge`.
- Traefik and each app's main service join `oma_edge`. The main service must be named exactly `<appId>`: Compose registers service names as DNS aliases on every network a service joins, so unique names prevent collisions.
- Other apps reach a main service at `http://<appId>:<port>`. Databases and internal services stay on the app's own project network.
- Apps never publish host ports. Only Traefik binds `http_port` and `https_port`.

**Routing**

- Traefik is the system app `traefik`, installed by `init`. It never mounts the Docker socket.
- Traefik uses its file provider, watching the named volume `oma_traefik_dynamic`.
- omactl renders route files into `system/traefik/dynamic/` and syncs them into that volume by streaming a tar archive (`docker cp -`, or a pinned helper container). The same mechanism writes any config files a manifest declares.
- Each route's default host is `<appId>.<base_domain>`. `omactl domain add` adds more hosts.
- TLS `off` serves HTTP only (behind Cloudflare, or local). TLS `acme` uses Let's Encrypt HTTP-01 and stores certificates in the volume `oma_traefik_acme`.

**Lock, journal and history**

- Every mutating command takes an exclusive lock at `state/lock` (pid, opId, command, start time). A second one waits up to `--lock-timeout` (default 120 s), then exits 4. A lock held by a dead pid is taken over and logged. Read-only commands never lock.
- Each mutating command gets an id `op_<UTC timestamp>_<4 random chars>` and writes `state/ops/<opId>.json`: command, args, plan, steps with status and timings, result, snapshot ids.
- Config changes are committed to git with the message `<command> <args> [<opId>]`.
- `app.lock.json` holds `desired_state` (`running` or `stopped`). Repairs only start apps whose desired state is `running`.
- Every command is idempotent. Installing an installed app is a no-op unless its catalog definition changed.

## 4. Catalog and manifest format

An app is a folder in the catalog: a manifest, a Compose file and hook scripts. Adding an app never requires changing or rebuilding omactl.

```text
catalog/
  catalog.json                {"version": "2026.11.17-1", "min_omactl": "0.1.0"}
  system/traefik/             system app, same format as apps
  apps/<appId>/
    manifest.yml
    compose.yml
    hooks/*.sh                POSIX sh, run inside containers
    files/*                   optional config templates
    README.md
  bundles/<bundleId>.yml      named sets of apps (OMA maps playbooks to bundles)
```

**manifest.yml** (zod schema, exported to `schemas/manifest.schema.json`)

```yaml
id: testapp                         # ^[a-z][a-z0-9-]{1,30}$
name: Test App
version: 1.0.0
description: Stateful fixture used to test omactl
resources: { memory_mb: 256, disk_mb: 512 }
requires: [traefik]                 # installed first, automatically
main_service: testapp               # must equal id; joins oma_edge
routes:
  - name: web
    service: testapp
    port: 3000
    host: "{appId}.{base_domain}"
volumes:                            # every volume in compose.yml, named oma_<appId>_<key>
  - { key: files,  backup: files }  # files = back up contents
  - { key: pgdata, backup: skip }   # skip = covered by a dump
  - { key: dump,   backup: files }
stop_during_backup: false
env:                                # rendered into .env
  - { name: POSTGRES_PASSWORD, generate: "password:32", secret: true }
  - { name: TESTAPP_BOOTSTRAP_TOKEN, generate: "token:32", secret: true }
  - { name: PUBLIC_URL, value: "{url:web}" }
config_files: []                    # { template: files/x.conf, volume: config, path: x.conf }
provides:
  - capability: notes.api
    outputs:
      url: "http://{appId}:3000"
      api_key: "{output:TESTAPP_API_KEY}"
consumes: []                        # { capability, required, env_prefix, default_provider }
hooks:
  setup:        { service: testapp, script: hooks/setup.sh,  timeout: 120 }
  verify:       { service: testapp, script: hooks/verify.sh, timeout: 60 }
  pre_backup:   { service: db, script: hooks/dump.sh, timeout: 300 }
  post_restore: { service: db, script: hooks/load.sh, timeout: 300 }
  migrate:      null
  on_link:      null
ready_timeout: 180                  # seconds for healthchecks on up --wait
```

Template variables: `{appId}`, `{base_domain}`, `{url:<route>}`, `{host:<route>}`, `{env:<NAME>}`, `{output:<NAME>}`, `{link:<capability>.<key>}`. An unknown variable is a lint error. Generated values (`password:N`, `token:N`) are created once and never regenerated.

**Hook protocol**

1. omactl streams the script over stdin: `exec -T <service> sh -s` for a running service, `run --rm -T <service> sh -s` for a one-off tool service. No bind mounts.
2. The hook sees its service's environment plus `OMA_APP_ID`, `OMA_HOOK`, `OMA_OP_ID` and `OMA_BASE_URL`.
3. Exit code 0 means success. Anything else is failure; stderr goes to the journal with secrets redacted.
4. Stdout lines of the form `OMA_OUTPUT KEY=value` are captured as outputs. Secret outputs go to `.env`; `app.lock.json` records only their names.
5. Hooks must be idempotent and never print secrets except through `OMA_OUTPUT`.

**Links**

- A link joins a consumer's `consumes` entry to a provider's `provides` capability.
- Creating a link renders the provider's outputs into the consumer's `.env` as `<env_prefix><KEY>` (for example `NOTES_URL`, `NOTES_API_KEY`). It then recreates the consumer's containers, runs its `on_link` hook and its `verify`.
- On install, a required capability links automatically when exactly one installed app provides it. With none, omactl installs `default_provider`. With several, install fails unless `--link <capability>=<appId>` is given.
- Removing a provider that has consumers requires `--force` and marks those consumers `degraded`.

**Bundles**: `{ id: notes-demo, apps: [testapp, testclient] }`. `omactl install --bundle notes-demo` installs in dependency order and links the apps.

**Catalog lint** (`omactl catalog lint <path>`, run in catalog CI). Lint fails on any of these:

- Manifest schema invalid, or `docker compose config` fails.
- An image not pinned by tag and digest, or missing `linux/amd64` or `linux/arm64` (checked through the registry API). Fixture catalogs may pass `--allow-local-images`.
- In `compose.yml`: `network_mode: host`, `privileged`, `devices`, `pid: host`, `ipc: host`, `cap_add: [ALL]`, host bind mounts, Docker socket mounts, `ports` or `container_name`. Traefik is exempt from the `ports` rule only.
- A volume not declared in the manifest, or not named `oma_<appId>_<key>` with an explicit `name:`.
- A long-running service without a `healthcheck`.
- A main service not named `<appId>`.
- A missing `setup` or `verify` hook, or a hook failing `sh -n`.
- An unresolved template variable.

## 5. CLI reference

Every command supports `--json`, never prompts without a TTY, and maps every outcome to one of ten exit codes.

**Global flags**: `--json`, `--home <path>`, `--plan` (print the plan, change nothing), `--yes` (accept non-destructive prompts), `--confirm <appId|instance>` (required for destructive operations), `--lock-timeout <s>`, `--timeout <s>`, `--verbose`, `--quiet`. Without a TTY and without a required flag, a command exits 8 and prints its plan.

**JSON envelope** (example of a failure)

```json
{
  "ok": false,
  "command": "install",
  "op_id": "op_20261117T101500Z_k3f9",
  "data": null,
  "warnings": [{ "code": "LOW_DISK", "message": "4.1 GB free on the Docker data root" }],
  "error": { "code": "VERIFY_FAILED", "message": "testapp verify failed", "hint": "Run: omactl logs testapp", "details": {} }
}
```

On success `ok` is true and `error` is null. Each command's `data` has a zod schema, exported to `schemas/output/<command>.schema.json`.

| Exit code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Unexpected error |
| 2 | Invalid usage |
| 3 | Precondition failed (doctor check, not initialized, missing dependency, blocked by policy) |
| 4 | Lock held by another operation |
| 5 | Verify failed |
| 6 | Change failed and was rolled back successfully |
| 7 | Change failed and rollback failed: needs a human |
| 8 | Confirmation required; plan printed, nothing changed |
| 9 | Not found (app, snapshot, capability) |

| Command | Behavior |
| --- | --- |
| `init` | Create OMA\_HOME, config, git repo and `oma_edge`; fetch the catalog; install Traefik. Flags: `--base-domain`, `--http-port`, `--https-port`, `--tls`, `--acme-email`, `--channel`, `--catalog <dir>` (dev and tests). |
| `doctor` | Platform and health checks with the support tier (section 9). Never mutates. |
| `catalog list`, `catalog show <app>`, `catalog lint <path>` | Browse the current catalog; lint a catalog directory. |
| `install <app...>` | Install with dependencies, secrets, routing, setup and links, then verify. Flags: `--bundle`, `--link cap=app`, `--set KEY=VAL`, `--domain host`. |
| `remove <app>` | Remove containers, keep volumes. `--purge` deletes volumes after a final backup (destructive). `--force` allows removing a provider that has consumers. |
| `start`, `stop`, `restart` with app ids or `--all` | Lifecycle; also sets `desired_state`. |
| `status [app]` | Versions, container health, desired state, last verify, last backup, override present, links, domains, orphaned volumes. |
| `logs <app>` | Container logs. Flags: `--service`, `--since`, `--tail`. No follow mode with `--json`. |
| `verify [app...]` or `--all` | Functional checks. `--repair` brings failed apps up, re-runs setup and verifies again. |
| `setup <app>` | Re-run the idempotent setup hook. |
| `link <consumer> <provider>`, `unlink` | Manage links; `--capability` when ambiguous. |
| `domain add`, `domain remove`, `domain list` | Extra hostnames per route (`--route`). |
| `credentials <app>` | Print secrets and outputs. The only command that prints secrets; never logged. |
| `exec <app> -- <cmd...>` | Run a command in an app container (`--service`). Diagnosis escape hatch; journaled. |
| `overrides [app]` | Apps with an override, and the effective diff (`docker compose config` with and without it). |
| `backup init`, `backup run`, `backup list`, `backup check`, `backup prune` | Section 7. |
| `restore <app>` | Section 7. Destructive. |
| `update` | Section 8. `--check`, `--to <version>`, app ids to limit scope. |
| `self-update` | Section 8. `--check`, `--channel`, `--rollback`. |
| `schedule install`, `schedule remove`, `schedule status` | Section 9. |
| `history` | Operation journal. `--limit`, `--op <opId>`. |
| `heartbeat` | Send status to `heartbeat.url` when set (section 8). |
| `version` | Binary version, catalog version, platform, support tier. |

## 6. Core flows

Every mutating flow follows one pattern: lock, create an opId, build a plan, stop there if `--plan`, execute the steps, journal them, commit config, unlock.

**init**

1. Run doctor. Abort with exit 3 on blocking failures.
2. Create the OMA\_HOME tree, `omactl.yml` with a new `instance_id`, the git repo and `.gitignore`.
3. Create the `oma_edge` network if it is missing.
4. Fetch and verify the catalog for the channel, or copy it from `--catalog <dir>`.
5. Install the `traefik` system app and check that it answers on the ingress port.
6. Running `init` again changes nothing and reports the current state.

**install**

1. Resolve install order from `requires` and required `consumes`. Check memory and disk against `resources`; warn or fail.
2. For each app not yet installed: copy `compose.yml` and hooks from the catalog; render `.env` (generate secrets once, never overwrite existing ones); render `compose.generated.yml`; render routes and config files.
3. `pull` (3 retries with backoff), then `up -d --wait --wait-timeout <ready_timeout>`.
4. Run `setup` and store its outputs.
5. Create links and run `on_link` hooks.
6. Sync Traefik routes, then run `verify`.
7. On failure: save logs to the journal, mark the app `failed` in `app.lock.json`, exit 5 (or 1). No retries beyond pulls.

**verify --repair** (also the boot job)

1. For each app whose `desired_state` is `running`: if containers are missing or unhealthy, run `up -d --wait`.
2. Run `verify`. On failure, re-run `setup`, then `verify` again.
3. Report each app's result. Exit 5 if any app still fails.

**update** (one app at a time, transactional)

1. Take a `pre-update` backup and record its snapshot id.
2. Copy the new definition from the catalog. Re-render generated files: keep existing `.env` values, add new keys, never drop secrets. Never touch `compose.override.yml`.
3. Run `docker compose config`. If the override no longer merges, treat it as a failed update.
4. `pull`, `up -d --wait`, then `migrate` (if defined), `setup` and `verify`.
5. On failure: stop the app, restore the previous definition from git, restore volumes from the pre-update snapshot, `up -d --wait`, `verify`. A clean rollback exits 6. A failed rollback exits 7 and marks the app `needs_human`.

&#91;embedded content: update flow · 3 steps, 2 checks, 3 outcomes\]

Every failed update ends in a known state: the previous version running (exit 6) or a clear stop for a human (exit 7).

**remove**

- Default: `down`, keep volumes, remove routes, mark consumers `degraded`, delete the app's folder and state. Its volumes stay listed as orphaned in `status`.
- `--purge --confirm <appId>`: take a `pre-remove` backup, then also delete the app's volumes.

## 7. Backups and restore

Backups use restic inside a pinned container, cover only volumes the manifest marks `files`, and run before every change and nightly.

- Image: `restic/restic:<version>@<digest>` (multi-arch).
- Repository: any S3-compatible bucket (Cloudflare R2 in OMA Cloud), or a local directory for tests and self-hosters.
- Credentials and the repo password live in `secrets/backup.env` and are passed with `--env-file`, never as arguments.
- The named volume `oma_restic_cache` holds restic's cache.

**backup init**: write `secrets/backup.env`, generate a repo password when new, run `restic init` unless the repo exists, then a quick `restic check`.

**backup run** (`--app <id>...` or `--all`; `--reason nightly|pre-update|pre-remove|pre-restore|manual`)

1. Run each app's `pre_backup` hook (for example, a database dump into its `dump` volume).
2. Run restic with every `files` volume mounted read-only at `/backup/<appId>/<key>`, plus the app's config (`compose*.yml`, `app.lock.json`, `.env`) streamed in as a tar.
3. Tag snapshots `instance:<instance_id>`, `app:<appId>`, `reason:<reason>`, `catalog:<version>`, `op:<opId>`, and set restic's host to `instance_id`.
4. Record the snapshot id and size in the journal and as `last_backup` in `app.lock.json`.
5. If `stop_during_backup` is true, stop the app during step 2 and start it after.
6. One app's failure does not stop the others; the exit code reflects any failure.

**backup list** returns snapshots filtered by tags. **backup check** runs `restic check` (a data subset for nightly runs).

**backup prune** runs only with `policy: self-managed`. It keeps 7 daily, 4 weekly and 6 monthly snapshots, and never removes a `pre-update` snapshot younger than 14 days. With `policy: central` it exits 3: the central system prunes, and instance credentials cannot delete.

**restore** `<app>` with `--snapshot <id>` or `--latest`, plus `--confirm <appId>`

1. Take a `pre-restore` backup of the current state.
2. Stop the app.
3. Wipe each `files` volume and restore its contents from the snapshot, inside a container with the volume mounted read-write.
4. With `--with-config`, also restore config files from the snapshot; otherwise keep the current config.
5. Start only the services `post_restore` needs (for example, the database), wait until healthy, run `post_restore`.
6. Start the app and run `verify`.

**Rules**

- Backups must work with credentials that cannot delete (bucket object lock or a write-only key).
- Every volume declares a backup mode in the manifest; nothing is excluded silently.

## 8. Releases, channels and self-update

Each instance pulls signed releases from its channel. Nothing is pushed to instances, so rollout speed is controlled by moving channels.

**Channel file**: `GET <release_url>/channels/<channel>.json`, plus `<channel>.json.sig` (Ed25519 over the exact bytes).

```json
{
  "channel": "stable",
  "published_at": "2026-11-17T10:00:00Z",
  "omactl": {
    "version": "0.3.0",
    "assets": {
      "linux-x64":    { "url": "https://.../omactl-linux-x64", "sha256": "..." },
      "linux-arm64":  { "url": "https://.../omactl-linux-arm64", "sha256": "..." },
      "darwin-x64":   { "url": "https://.../omactl-darwin-x64", "sha256": "..." },
      "darwin-arm64": { "url": "https://.../omactl-darwin-arm64", "sha256": "..." }
    }
  },
  "catalog": { "version": "2026.11.17-1", "url": "https://.../catalog-2026.11.17-1.tar.gz", "sha256": "..." }
}
```

Public keys are compiled into omactl as a list, so keys can rotate. A channel file without a valid signature is ignored and reported.

**update**

1. Fetch and verify the channel file; compare catalog versions.
2. `--check` reports the new version and which installed apps change (manifest and compose diff), then exits 0.
3. Otherwise download the tarball, check its sha256, extract to a temp dir, validate schemas, swap it into `catalog/` atomically and write `state/catalog.lock.json`.
4. Apply transactional updates (section 6) to changed apps, one at a time. Stop at the first exit 7.
5. With `updates: notify`, scheduled runs only do `--check` and record the result; with `auto` they apply it.
6. With `channel: pinned`, versions change only through `--to <version>`.

**self-update**

1. Fetch and verify the channel file; exit if already current.
2. Download this platform's asset next to the current binary; check its sha256.
3. Smoke test: run the new binary with `version --json`.
4. Rename the current binary to `omactl.prev`, then atomically rename the new one into place.
5. If the binary's location is not writable, exit 3 with a hint.
6. `self-update --rollback --confirm instance` restores `omactl.prev`.

**Heartbeat**: when `heartbeat.url` is set, `omactl heartbeat` POSTs `instance_id`, omactl and catalog versions, support tier, doctor result and, per app, version, desired state, last verify result and last backup time. It authenticates with a bearer token from `secrets/`. A failed heartbeat never changes the exit code of the job that sent it.

**install.sh** (POSIX sh): detect OS and architecture, download from the stable channel, check the sha256, install to `/usr/local/bin` (root) or `~/.local/bin`, then print the next step, `omactl init`.

## 9. Platform adapter, scheduling and doctor

All OS differences live in `src/platform/`: the home directory, the scheduler and the support tier.

| Scheduled job | When | Command |
| --- | --- | --- |
| boot-repair | At boot, after Docker starts | `omactl verify --all --repair --json` |
| nightly-backup | Daily, at a fixed minute inside `nightly_window` derived from a hash of `instance_id` | `omactl backup run --all --reason nightly` |
| update-check | Every 6 hours | `omactl update` (follows `updates`), then `omactl self-update` when `updates: auto` |
| verify | Hourly | `omactl verify --all --json`, then `omactl heartbeat` |

- `schedule install` on Linux as root writes `oma-<job>.service` and `oma-<job>.timer` to `/etc/systemd/system/` with `After=docker.service`. As non-root it writes user units and warns that lingering must be on (`loginctl enable-linger`).
- On macOS it writes `~/Library/LaunchAgents/agency.openmarketing.omactl.<job>.plist`.
- Scheduled runs log and journal like any other command. The global lock prevents overlap.

**doctor checks** (each `ok`, `warn` or `fail`, with a fix hint)

- OS, architecture and support tier.
- `docker` found, daemon reachable, Engine and Compose at or above the minimums, active context name.
- Free disk on Docker's data root and on OMA\_HOME: warn under 5 GB, fail under 1 GB.
- Available memory against the sum of installed apps' `resources.memory_mb`.
- Ingress ports free, or held by omactl's own Traefik.
- `oma_edge` present (after init).
- WSL2: warn if OMA\_HOME is under `/mnt/`; fail if systemd is off when scheduling is requested.
- Clock skew over 2 minutes, measured from the `Date` header of `release_url`.
- Backup repository reachable and initialized, when configured.

| Tier | Platforms | Tested in CI |
| --- | --- | --- |
| 1 | Linux x64 and arm64 with Docker Engine | Full e2e, plus a real reboot test |
| 2 | macOS with Docker Desktop or OrbStack; Windows through WSL2 | Install and verify |
| Unverified | Podman, rootless Docker, NAS systems, 32-bit ARM, anything else | Not tested; doctor warns |

## 10. Security and the agent contract

omactl treats the VM as the security boundary, keeps secrets out of logs and arguments, and makes every destructive step explicit.

**Permissions**

- omactl runs as a user with Docker access (in OMA Cloud, `ops` in the `docker` group). Docker access is root-equivalent on that VM.
- OMA's marketing agents never get Docker access or omactl. Only the maintenance agent does.
- omactl never calls `sudo`.

**Secrets**

- Generated with `crypto.getRandomValues` and stored in `.env` and `secrets/` with mode 0600.
- Passed to containers through env files, never as command-line arguments.
- Redacted from logs, journal and errors: every value marked `secret: true`, every secret `OMA_OUTPUT` value and everything in `secrets/`.
- Only `credentials` prints secrets.

**Destructive operations**: `remove --purge`, `restore`, `backup prune` and `self-update --rollback`. Each requires `--confirm <appId>` or `--confirm instance`. Each takes a backup first when data is involved. Without confirmation, each exits 8 with its plan.

**Agent contract** (ship as `docs/AGENT.md`; it becomes the maintenance agent's skill)

1. Start with `omactl doctor --json` and `omactl status --json`.
2. Run every change with `--plan --json` first and read the plan.
3. Apply it, then run `omactl verify <app> --json`.
4. Fix problems only in `compose.override.yml`, then run `omactl restart <app>` and `verify`. Never edit `compose.yml` or anything in `catalog/`.
5. Diagnose with `omactl logs`, `omactl exec` and `omactl history`.
6. Escalate to a human on exit 7, on exit 8, and before any destructive operation.
7. Report every override you create (`omactl overrides --json`) so the fix can move into the catalog.

## 11. Test app fixtures

One small purpose-built image runs as two catalog apps, `testapp` and `testclient`. Together they exercise every omactl feature: routing, secrets, setup outputs, dumps, file volumes, links, migrations and failure injection.

**Image** `omactl-testapp` (`fixtures/testapp/`)

- A Bun HTTP server in TypeScript on `oven/bun:<version>-alpine`, built for linux/amd64 and linux/arm64. Alpine provides `sh` and busybox `wget` for hooks.
- Tags `1.0.0` and `2.0.0`. CI builds them locally; fixture catalogs reference the local tags and pass lint with `--allow-local-images`.
- `MODE=server` (default) or `MODE=client`.
- Compose healthcheck: `wget -qO- http://localhost:3000/healthz`.

| Server endpoint | Behavior |
| --- | --- |
| `GET /healthz` | 200 when the database is reachable and migrations are applied; otherwise 503 |
| `POST /admin/bootstrap` with header `X-Bootstrap-Token` | First call creates the admin API key and returns it. Later calls return 200 with the same key (idempotent). |
| `POST /api/notes` (Bearer key) | Insert `{ body, tag }` (tag optional) and return its id |
| `GET /api/notes/:id`, `DELETE /api/notes/:id` | Read or delete a note |
| `PUT /api/files/:name`, `GET /api/files/:name` | Write or read a file under `/data/files` (volume `files`) |
| `GET /api/info` | `{ version, schema, notes }` |

| Client endpoint | Behavior |
| --- | --- |
| `GET /healthz` | 200 while running |
| `POST /sync` | Writes a note to the server through `NOTES_URL` with `NOTES_API_KEY`, reads it back, returns both |

**Versions and failure injection**

- `1.0.0`: schema 1, table `notes(id, body, created_at)`.
- `2.0.0`: migrates to schema 2 on startup (adds `notes.tag`); `/api/info` reports `schema: 2`.
- `FAIL_HEALTH=1`: `/healthz` always returns 503.
- `FAIL_MIGRATION=1`: the 2.0.0 migration exits non-zero.
- `SLOW_START_SECONDS=N`: delays readiness by N seconds.

**Catalog entries**

- `testapp`: services `testapp` (server) and `db` (`postgres:17-alpine`, pinned); volumes `files` (files), `pgdata` (skip) and `dump` (files); provides `notes.api`. Its manifest is the example in section 4.
- `testclient`: one service, `testclient` (client mode); consumes `notes.api` with `env_prefix: NOTES_`, `required: true` and `default_provider: testapp`.
- Bundle `notes-demo`: `[testapp, testclient]`.

**Hooks**

- `testapp/setup.sh`: wait for `/healthz`, call `/admin/bootstrap`, print `OMA_OUTPUT TESTAPP_API_KEY=<key>`.
- `testapp/verify.sh`: create a note tagged `oma-verify`, read it back and delete it; write and read a file. Fail on any mismatch. A 200 alone never passes.
- `testapp/dump.sh`: `pg_dump -Fc` to `/dump/db.dump`. `testapp/load.sh`: `pg_restore --clean --if-exists` from that file.
- `testclient/verify.sh`: call `POST /sync` and check that the note read back matches the note written.

**Fixture catalogs**: `fixtures/catalog-v1` (1.0.0), `fixtures/catalog-v2` (2.0.0) and `fixtures/catalog-v2-broken` (2.0.0 with `FAIL_MIGRATION=1`). Tests serve them as signed channel releases from a local HTTP server, using a test-only keypair in `fixtures/keys/`.

## 12. Test plan, CI and acceptance criteria

v1 is accepted when all 16 e2e scenarios below pass in CI on Linux x64 and arm64. Each scenario is an automated test.

**Unit tests** (`bun test`, no Docker): manifest validation, template rendering, install order, plan building, lock handling, journal, secret redaction, exit codes, signature checks, output schemas, and the platform adapter with mocks.

**E2E setup**: real Docker, fixture catalogs, a local release server, a local restic repository in a temp dir, and `--base-domain localhost --http-port 18080`. HTTP checks call `http://127.0.0.1:18080` with a `Host` header such as `testapp.localhost`.

1. `doctor --json` passes and reports the tier.
2. `init` with `fixtures/catalog-v1`: Traefik answers; a second `init` changes nothing.
3. `install testapp`: the setup output is stored, `/api/info` answers through Traefik, `verify` passes, and a second install changes nothing.
4. `setup testapp` twice: the API key does not change.
5. Backup and restore: create a note and a file; `backup run --app testapp`; delete both (variant: delete the `pgdata` volume entirely); `restore testapp --latest --confirm testapp`; both are back and `verify` passes.
6. Links: `install testclient` auto-links to testapp and its `verify` passes; `remove testapp` without `--force` fails.
7. Overrides: an override sets `SLOW_START_SECONDS=2`; `overrides --json` reports it; after an update to catalog-v2 it is still present and applied.
8. Update from v1 to v2: a `pre-update` snapshot exists, `/api/info` reports schema 2, and `verify` passes.
9. Failed update to v2-broken: exit 6; the app runs 1.0.0 with its data; `verify` passes.
10. Rollback failure: make the backup repository unreachable after the pre-update backup, then fail the update. Exit 7; the app is marked `needs_human`.
11. Reboot simulation: restart the Docker daemon (or `down` every app); `verify --all --repair` restores everything and `verify` passes. An app stopped on purpose stays stopped.
12. Two mutating commands at once: one waits, or exits 4.
13. `remove testapp --purge` without `--confirm`: exit 8 and nothing changes.
14. Self-update: a newer signed build installs, a tampered signature is refused, and `--rollback` restores the previous binary.
15. Every `--json` output from all scenarios validates against its JSON Schema.
16. No generated secret value appears anywhere in `logs/` or `state/ops/`.

| CI job | Runs on |
| --- | --- |
| Lint, typecheck, unit tests | Ubuntu x64, Ubuntu arm64, macOS arm64 |
| Build all six targets | Ubuntu x64 (cross-compile) |
| E2E scenarios 1 to 16 | Ubuntu x64 and Ubuntu arm64 |
| Real reboot test (nightly) | A cloud VM created per run |
| Tier 2 (after v1) | A self-hosted Mac mini with OrbStack, and a WSL2 runner |

## 13. Repo layout, build and milestones

Build v1 in five milestones, in order. Each one is done when its e2e scenarios from section 12 pass.

```text
omactl/
  src/
    cli/         commands (commander), output rendering, exit codes
    core/        plan/apply engine, lock, journal, git history, errors
    docker/      docker and compose wrapper: spawn, JSON parsing, timeouts, retries
    catalog/     load, validate, render templates, lint
    apps/        install, remove, lifecycle, links, domains, overrides
    backup/      restic runner, dumps, restore
    routing/     Traefik config rendering and sync
    update/      channels, signatures, catalog update, self-update
    platform/    paths, schedulers (systemd, launchd), tiers, doctor probes
    schemas/     zod schemas and JSON Schema export
  catalog/       dev catalog: system/traefik, apps/testapp, apps/testclient, bundles/
  fixtures/      testapp/, catalog-v1/, catalog-v2/, catalog-v2-broken/, keys/
  test/          unit/, e2e/
  scripts/       build.ts, release.ts, schemas.ts
  docs/          AGENT.md, CATALOG.md, ARCHITECTURE.md
  install.sh
```

**Build and release**: `bun run build` writes `dist/omactl-<os>-<arch>[-musl]` for all six targets. `bun run release` writes sha256 sums, signs the channel file with the Ed25519 key from CI secrets, and uploads the binaries, catalog tarball and channel files to GitHub Releases and the release host.

| Milestone | Scope | Scenarios |
| --- | --- | --- |
| M1 Skeleton | CLI, output envelope, exit codes, OMA\_HOME, config, lock, journal, git history, doctor, platform adapter, six-target build | 1 |
| M2 Apps | Catalog loading and lint, testapp image and catalog entries, init with Traefik, install, remove, lifecycle, status, logs, hooks, routing, verify | 2, 3, 4, 13 |
| M3 Wiring | Links, domains, overrides, verify --repair | 6, 7, 11 |
| M4 Backups | restic backup, list, check, prune and restore | 5, 16 |
| M5 Releases | Channels, signatures, catalog update with rollback, self-update, scheduler | 8, 9, 10, 12, 14, 15 |

**Definition of done**

- All 16 scenarios pass on Linux x64 and arm64.
- All six binaries build from one runner.
- `docs/AGENT.md` and `docs/CATALOG.md` exist, and adding an app needs only a new catalog folder.
- At runtime the host needs nothing but Docker.
