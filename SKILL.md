---
name: omactl
description: Install and maintain self-hosted apps with omactl.
metadata:
  hermes:
    tags: [omactl, self-hosting, docker, maintenance]
---

# omactl for Hermes

## When to use

Use this skill to discover, install, operate, troubleshoot, back up, restore, update, or expose applications managed by Open Marketing Agency's `omactl` CLI. Use Hermes's `terminal` tool on the intended host. Prefer omactl over direct Docker changes so its desired state, journals, backup, and rollback handling stay consistent.

This skill is based on `docs/USER_GUIDE.md` in the omactl repository and follows `docs/AGENT.md`. When the checkout is available, consult those files and the relevant `catalog/apps/APP/README.md` for details. The installed CLI's command-specific `--help` is authoritative for available flags. Do not invent app IDs, catalog releases, or commands.

## Quick reference

Examples use `APP`, `CONSUMER`, `PROVIDER`, and `SNAPSHOT` as placeholders; substitute discovered IDs. Add the same `--home /absolute/path` to every command when selecting a nondefault instance. Preview every change with `--plan --json` before applying it, including commands listed below without a preview.

| Task | Command |
| --- | --- |
| Inspect host and instance | `omactl doctor --json`, `omactl status --json`, `omactl version --json` |
| Discover apps | `omactl catalog list --json`, `omactl catalog show APP --json` |
| Install | `omactl install APP --plan --json`, then `omactl install APP --json` |
| Start, stop, restart | `omactl start APP`, `omactl stop APP`, `omactl restart APP` |
| Functional verification | `omactl verify APP --json` |
| Repair desired-running apps | `omactl verify APP --repair` |
| Rerun idempotent setup | `omactl setup APP` |
| Bounded diagnostics | `omactl logs APP --tail 100 --since 30m --json` |
| Operation evidence | `omactl history --limit 10 --json`, `omactl history --op OP_ID --json` |
| Inspect local changes | `omactl overrides APP --json` |
| Temporary public HTTPS URL | `omactl tunnel APP` |
| Connect apps | `omactl link CONSUMER PROVIDER --capability NAME` |
| Extra hostnames | `omactl domain list APP --json`, `omactl domain add APP HOST`, `omactl domain remove APP HOST` |
| Backups | `omactl backup run --app APP`, `omactl backup list --app APP --json`, `omactl backup check` |
| Check releases | `omactl update APP --check --json`, `omactl self-update --check --json` |
| Native maintenance jobs | `omactl schedule status --json`, `omactl schedule install`, `omactl schedule remove` |

## Procedure

### Establish the instance

- Confirm the terminal backend targets the intended machine, OS account, and Docker context. A Hermes sandbox may be a different host. Do not mount a Docker socket or switch hosts merely to make a command work.
- Instance selection is `--home`, then `OMA_HOME`, then `~/.oma`. Keep it consistent. Avoid sudo as a permission workaround: it can select root's instance. One Docker daemon supports one OMA instance; another home directory does not isolate shared container, network, or volume names.
- Start with `omactl doctor --json` and `omactl status --json`. Diagnose missing prerequisites or an uninitialized instance before changing anything.
- Running the compiled CLI requires Docker Engine 24.0+ and Compose plugin 2.24+. Linux, macOS, and Windows through WSL2 are supported; native Windows is not. WSL2 state belongs on its Linux filesystem.
- If building/installing the CLI is requested, use Bun 1.4.4 from the source checkout. `bun run install:dev` installs locked dependencies, typechecks, builds and smoke-tests the native executable, and installs into `~/.local/bin`; `--check` adds lint and unit checks. It preserves a previous binary when replacing it and does not reset the instance. Do not provision a host just because lifecycle work was requested.

### Inspect, preview, apply, verify

1. Identify the requested apps and inspect current state and catalog definitions. Inspect dependencies and existing overrides as relevant. Use `--all` only for requested instance-wide work.
2. Run the intended mutation with `--plan --json`. Read its `targets`, `steps`, `destructive`, and `confirmation` fields, including plans returned in `error.details`. Plans do not change instance state, though release planning can download material into temporary storage.
3. Apply within the user's existing authorization. Routine requests authorize their corresponding non-destructive changes. Before destructive work, review exact targets and data effects with the human; reuse explicit approval already given for those effects. Exit 8 requires human review, not automatic insertion of `--confirm`. `--yes` does not replace destructive confirmation.
4. Read the exit code and JSON envelope: `ok`, `data`, `warnings`, `error`, and `op_id`. Inspect per-app results; some operations attempt multiple targets even if one fails.
5. Run `omactl verify APP --json` and inspect resulting status for affected running apps. Verification exercises functionality and can create test records. For an intentionally stopped or removed app, confirm that intended state instead of starting it to pass verification.

### Initialize and install

Initialize only when setup is requested. Choose the base domain, ingress ports, and TLS mode first. A source build has no production release trust keys by default; initialize from the checkout's local catalog, for example:

```sh
omactl init --catalog "$PWD/catalog" --http-port 18080 --plan --json
omactl init --catalog "$PWD/catalog" --http-port 18080 --json
```

`LOCAL_CATALOG` is expected for an explicitly selected local catalog. Repeating `init` does not refresh an installed catalog or change ingress settings. DNS, public firewall access, and TLS prerequisites need separate configuration.

Discover available apps before installation. The guide includes WordPress, Listmonk, Umami, Ghost, and test fixtures; availability depends on the instance catalog. Use `--bundle` only for a discovered bundle. For ambiguous dependencies, select a discovered provider with `--link CAPABILITY=PROVIDER` and inspect every dependency in the plan.

Use `--set KEY=value` for supported non-secret initial settings. Only keys mapped by the catalog affect a service. An unchanged installation is a no-op for new settings and provider selections; use supported configuration or overrides for ongoing settings and `link` to change connections. Installation runs setup automatically.

App access details:

- WordPress: `/wp-admin/`; generated administrator credentials.
- Listmonk: `/admin`, administrator `oma-admin`; configure SMTP and sender settings before sending newsletters.
- Umami: administrator `admin` with a generated password replacing the upstream default; add a website and embed its tracking script to collect analytics.
- Ghost: `/ghost/`; the operator must create the site owner in a browser. Database credentials are not the owner login. Configure SMTP for verification and password-reset emails.
- Fixture apps expose APIs; a root-path 404 does not establish failure. Use functional verification and their documented endpoints.

### Public URLs and Hermes browser access

Only create public exposure when requested. Preview and apply `omactl tunnel APP` to run a pinned official cloudflared container and publish the app's first web route over temporary HTTPS. No Cloudflare account, domain, or separate cloudflared install is required; outbound Internet access is required.

- JSON returns `data.app`, `data.url`, and `data.reused`. Status also stores tunnel state. Repeating the command reuses a running tunnel.
- Applying a new URL changes supported app canonical URLs, recreates affected containers, updates routes, and verifies functionality. It retains credentials and local overrides. Existing aliases may redirect to the canonical public URL. A configured backup repository is used first; otherwise inspect the no-backup warning.
- Quick Tunnel addresses are temporary. After a stopped/exited tunnel or Docker/machine restart, rerun `tunnel APP` to obtain and apply a new address. `stop` and `remove` remove its tunnel container; `start` does not recreate it. Use a named Cloudflare Tunnel and domain for a stable address; this skill does not invent a CLI command for that setup.

For catalog entries declaring `browser_login`, omactl saves browser credentials through agent-browser's encrypted auth vault. WordPress, Listmonk, and Umami declare managed credentials. Inspect `browser_vault` in status for the exact `oma-<instance hash>-<appId>` profile name and synchronization status. Authenticate through the available browser integration's vault mechanism without printing passwords; consult its supported commands rather than inventing login flags.

Run omactl with the same OS account and encryption-key environment as Hermes's agent-browser. Install agent-browser on that host when browser access is requested; omactl never downloads it automatically. `OMA_AGENT_BROWSER` can select its executable or intended-runtime wrapper. Discovery also checks Hermes installations under `HERMES_HOME`, default `~/.hermes`.

`BROWSER_VAULT_SYNC_PENDING` means the app operation can succeed while browser synchronization remains incomplete. The prior profile may still contain an older URL. Resolve the missing dependency or credentials, then rerun `install APP`; unchanged installations retry synchronization. Tunnel creation/reuse and domain changes also update the profile. Domain add selects that login hostname; tunnel selects its public URL again. Plans never write the vault.

Ghost's `GHOST_ADMIN_EMAIL` and `GHOST_ADMIN_PASSWORD` are vault-only references; they do not create or reset an account. After browser signup, have the operator securely store the chosen credentials in Ghost's protected app `.env`, then retry installation. Passwords changed inside other apps likewise need their declared protected environment values updated before synchronization.

### Diagnose and repair

Read bounded logs, doctor output, operation history, and error `hint`/`details` before changing configuration. `exec APP --service SERVICE -- COMMAND` can mutate data, is journaled, and takes a pre-change backup when configured; preview it and use read-only diagnostics where possible. Never pass secrets in exec arguments. Do not combine `logs --follow` with `--json`.

For runtime fixes, preserve and edit only `INSTANCE_HOME/apps/APP/compose.override.yml`. Inspect `omactl overrides APP --json`, preview/apply restart, and verify. Report the effective override diff so the fix can move upstream. Do not edit managed `compose.yml`, `compose.generated.yml`, or the instance `catalog/`. Catalog authoring is a separate source-repository task.

Repair respects desired state: `verify --all --repair` leaves intentionally stopped apps stopped. Do not start them as a workaround. Stop automatic recovery for `needs_human` or exit 7. An exit 6 means the attempted change failed and rollback succeeded; diagnose before trying another change.

### Back up, restore, and remove

Updates, removal, and restore require a configured backup repository. Inspect the current configuration first. Initialize only at a user-selected location, for example `omactl backup init --repository /absolute/path`, after its plan. For remote credentials use `--env-file /secure/path` with a protected file, never secret command arguments. Retain the original instance identity and repository password; do not generate replacements to fix access to an existing repository.

Take app snapshots with `backup run --app APP`, inspect snapshot IDs with `backup list`, and check repository integrity with `backup check`. Backups may briefly stop containers. Data lives in named Docker volumes; copying the app directory or configuration history alone is insufficient. A same-machine repository does not protect against loss of the machine. Preserve protected copies of `omactl.yml` and `secrets/backup.env` separately.

Restore requires an installed app. Select an explicit snapshot so preview and application target the same data:

```sh
omactl restore APP --snapshot SNAPSHOT --plan --json
# After human review and authorization of the replacement:
omactl restore APP --snapshot SNAPSHOT --confirm APP --json
```

Default restore keeps current configuration. `--with-config` also restores the snapshot's definition, environment, hooks, and lock, and can replace or remove overrides. Review those effects before using it. There is no single v1 command to recover an entire lost machine.

Default `remove APP` takes a final backup and retains named volumes. Reinstallation with retained volumes needs saved credentials from the original backup repository; never purge volumes just to clear `ORPHANED_DATA`. Removing a provider with consumers needs `--force` and leaves consumers degraded; review that effect. Traefik cannot be removed through `remove`.

Destructive confirmations are case-sensitive:

| Operation | Confirmation |
| --- | --- |
| `remove APP --purge` | `--confirm APP` |
| `restore APP` | `--confirm APP` |
| `backup prune` | `--confirm instance` |
| `self-update --rollback` | `--confirm instance` |

Prune is available only with self-managed backup policy: retention keeps 7 daily, 4 weekly, and 6 monthly snapshots and protects pre-update snapshots younger than 14 days. Central policy rejects local pruning. Never prune or purge to make health checks pass.

### Update, connect, and schedule

- Check releases before planning updates. Network updates require a trusted production release server and compiled public keys; do not bypass signature validation or trust fixture keys. A source binary rebuild does not update the installed catalog or running apps automatically. App-targeted updates still replace the catalog release as a whole. CLI self-update is separate and requires a writable install directory.
- Links use consumer then provider; inspect advertised capabilities first. Unlinking a required capability degrades its consumer. Verify affected apps after changing a connection.
- Domain commands manage Traefik hostnames, not DNS, firewall access, or necessarily app canonical URLs. Browser-vault login hostname selection is separate from application redirects. Use an app's supported URL configuration when needed.
- Install native schedules only for requested recurring maintenance, after successful manual backup and verification. Inspect `schedule status` first. For a local build without a trusted release service, preserve configuration while setting the existing instance `omactl.yml` field `updates` to `off` before schedule installation. Avoid duplicate Hermes cron jobs.
- Schedules require the compiled executable. macOS uses per-user LaunchAgents; Linux uses root system units or non-root user units, with lingering needed for unattended user startup. WSL2 requires systemd. Docker must be available for the scheduled account.

## Pitfalls and exit handling

`credentials APP` intentionally prints secrets. Keep its output and whole `.env` or `secrets/backup.env` files out of model context, reports, and logs. Prefer generated credentials, protected files, and vault authentication. Do not place secrets in `--set`, shell arguments, or chat. Lifecycle management alone does not authorize content changes, newsletters, or browser actions inside an app.

| Exit | Response |
| --- | --- |
| 0 | Inspect warnings and per-target results, then verify the intended outcome. |
| 1 | Diagnose execution failure using bounded logs and history. |
| 2 | Inspect command help and correct usage. |
| 3 | Resolve the stated prerequisite or policy condition. |
| 4 | Inspect concurrent work and wait or retry after it completes; never delete a live lock. Dead-PID locks are reclaimed automatically. |
| 5 | Diagnose functional failure; repair only within the requested scope. |
| 6 | Report failed change and successful rollback; investigate before retrying. |
| 7 | Stop automatic repair and escalate with redacted operation evidence. |
| 8 | Review the returned plan with the human before supplying confirmation. |
| 9 | Recheck app, snapshot, capability, or operation IDs; do not invent replacements. |

Stop repeating an operation when the same failure recurs without new evidence. Preserve operation IDs and give a concrete next step.

## Verification and reporting

Report affected apps and versions, intended versus actual state, functional verification results, relevant URLs, backup/snapshot IDs, operation IDs, and material warnings. Distinguish a pending browser-vault sync from a failed installation and a recovered rollback from a successful update. Include redacted diagnostics and any effective override diff. Confirm intentionally stopped or removed apps remain in their requested state.
