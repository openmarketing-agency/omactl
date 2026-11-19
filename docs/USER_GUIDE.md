# omactl user guide

omactl manages the self-hosted apps in one Open Marketing Agency (OMA) instance. It installs apps from a catalog, runs functional checks, manages routing and connections between apps, takes backups, restores data, and applies updates with rollback.

This guide covers the v1 tool in this repository. The current catalog contains Traefik, [WordPress](../catalog/apps/wordpress/README.md), [Listmonk](../catalog/apps/listmonk/README.md), and two test fixtures, `testapp` and `testclient`. WordPress provides a website and admin dashboard. Listmonk manages newsletters and mailing lists. The fixtures expose HTTP APIs.

## Contents

- [Requirements](#requirements)
- [Build and install](#build-and-install)
- [First setup](#first-setup)
- [Everyday operations](#everyday-operations)
- [Connect apps and manage domains](#connect-apps-and-manage-domains)
- [Backups and restore](#backups-and-restore)
- [Local overrides](#local-overrides)
- [Updates and rollback](#updates-and-rollback)
- [Scheduled maintenance](#scheduled-maintenance)
- [Configuration and stored data](#configuration-and-stored-data)
- [JSON and automation](#json-and-automation)
- [Remove apps](#remove-apps)
- [Troubleshooting](#troubleshooting)
- [Command reference](#command-reference)

## Requirements

To run an installed binary, you need Docker access and a running Docker daemon with:

| Component             | Minimum |
| --------------------- | ------- |
| Docker Engine         | 24.0    |
| Docker Compose plugin | 2.24    |

Docker Desktop, OrbStack, Colima, and Docker Engine are accessed through the Docker CLI's active context. omactl does not need a particular Docker socket location.

Building from source also requires **Bun 1.4.4**. Bun, Git, restic, PostgreSQL tools, curl, jq, and Python are not required on the host to run the compiled tool. Backup and app-specific tools run inside containers.

Linux x64 and arm64 are the primary targets. macOS and Windows through WSL2 are also supported targets; there is no native Windows binary. On WSL2, keep instance state on the Linux filesystem rather than under `/mnt/` and enable systemd before installing schedules.

One Docker daemon hosts one OMA instance. Changing `--home` does not create an isolated second instance: Compose project names, app volume names, and the `oma_edge` network are shared names on that daemon.

## Build and install

Run these commands from the repository directory:

```sh
bun --version
bun install --frozen-lockfile
bun run build --current
```

The first command should report `1.4.4`. The build writes an executable under `dist/` for the machine running Bun. To build all six targets instead, use `bun run build`.

Choose the executable for your system:

| System                                            | Executable                     |
| ------------------------------------------------- | ------------------------------ |
| Apple Silicon Mac                                 | `dist/omactl-darwin-arm64`     |
| Intel Mac                                         | `dist/omactl-darwin-x64`       |
| Linux x64, including an x64 WSL2 installation     | `dist/omactl-linux-x64`        |
| Linux arm64, including an arm64 WSL2 installation | `dist/omactl-linux-arm64`      |
| Linux x64 with musl                               | `dist/omactl-linux-x64-musl`   |
| Linux arm64 with musl                             | `dist/omactl-linux-arm64-musl` |

`build --current` selects the OS and CPU target. For a musl build, use the full six-target build and select the corresponding musl executable.

For your Apple Silicon Mac, install into your user account:

```sh
mkdir -p "$HOME/.local/bin"
install -m 755 dist/omactl-darwin-arm64 "$HOME/.local/bin/omactl"
export PATH="$HOME/.local/bin:$PATH"
omactl version
omactl --help
```

On another system, substitute its executable from the table. Add the following line once to your shell startup file to retain the PATH setting in new terminals:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Use `~/.zshrc` for zsh, `~/.bashrc` for an interactive Bash shell, or your shell's equivalent startup file.

After changing source code, repeat the build and `install` commands to replace your installed executable. This manual replacement does not create the `omactl.prev` file used by the signed self-update rollback command.

## First setup

Keep the terminal in the repository directory for this walkthrough so the `catalog` and `fixtures/testapp` paths resolve correctly.

### 1. Start Docker and choose the instance directory

Start your Docker environment. You can inspect its versions with:

```sh
docker version --format json
docker compose version --format json
```

The default instance directory is `~/.oma`. To choose another location, set `OMA_HOME` before initialization and retain the setting for later commands:

```sh
export OMA_HOME="$HOME/oma-instance"
```

This setting is optional. A command's `--home` flag takes precedence over `OMA_HOME`:

```sh
omactl --home "$HOME/oma-instance" status
```

Use the same instance directory consistently, including for backup, restore, and scheduled maintenance.

### 2. Initialize from the local catalog

The default build does not contain production release signing keys. Use the repository's local catalog for this setup:

```sh
omactl init --catalog "$PWD/catalog" --http-port 18080 --plan
omactl init --catalog "$PWD/catalog" --http-port 18080
omactl doctor
```

Initialization creates the instance configuration and history, creates `oma_edge`, installs Traefik, and checks the ingress port. A `LOCAL_CATALOG` warning is expected: you explicitly selected an unsigned development catalog.

Choose the base domain, ports, and TLS mode before the first initialization. The walkthrough uses `localhost`, HTTP on port `18080`, and TLS off. Without flags, HTTP defaults to port `80`.

**Running `init` again is a no-op**, including when you pass different domain or port flags. It reports the existing instance. It does not reconfigure ingress.

A pre-initialization `doctor` checks default ingress settings. If it reports that port 80 is occupied, initialization with `--http-port 18080` runs its own checks against that chosen port.

For a new instance with a public domain, the initial options can instead include:

```sh
omactl init \
  --catalog "$PWD/catalog" \
  --base-domain apps.example.com \
  --tls acme \
  --acme-email ops@example.com
```

Replace the example domain and email with yours. ACME uses HTTP-01: DNS and inbound HTTP access must reach Traefik. `domain add` and `init` do not create DNS records or configure your firewall. For TLS off behind another HTTPS proxy, arrange HTTPS at that proxy.

### 3. Build the fixture image and install the demo

The local development catalog references a locally built fixture image:

```sh
docker build --build-arg APP_VERSION=1.0.0 \
  -t omactl-testapp:1.0.0 fixtures/testapp

omactl install --bundle notes-demo --plan
omactl install --bundle notes-demo
omactl verify --all
omactl status
```

`notes-demo` installs `testapp` and `testclient` in dependency order. `testapp` stores notes in PostgreSQL and files in a named volume. `testclient` automatically links to its `notes.api` capability. Verification creates and checks actual notes and files; it is more than a container health check.

Traefik routes the fixture hosts at:

- `http://testapp.localhost:18080`
- `http://testclient.localhost:18080`

These are API services. A 404 at the root URL does not mean verification failed. `testapp` has authenticated endpoints under `/api/`; `testclient` exposes `POST /sync`. If your client does not resolve the `.localhost` names, provide local DNS or hosts-file entries pointing the names to `127.0.0.1`. The functional checks inside containers do not require that client-side DNS setup.

### 4. Configure backups

Create a local repository and take your first snapshots:

```sh
omactl backup init --repository "$HOME/oma-backups"
omactl backup run --all
omactl backup list
omactl backup check
```

This repository location is separate from the instance directory. It remains on the same machine, so also arrange protection against loss of that machine, such as an off-machine repository.

The first initialization and installation can run before a backup repository exists. Some later changes report a `BACKUP_NOT_CONFIGURED` warning in that situation. **Updates, app removal, and restore require a configured backup repository.**

## Everyday operations

A useful sequence for a change is: inspect, preview, apply, then verify.

```sh
omactl doctor
omactl status testapp
omactl restart testapp --plan
omactl restart testapp
omactl verify testapp
```

### Inspect the catalog and installed apps

```sh
omactl catalog list
omactl catalog show testapp
omactl status
omactl status testapp --json
```

The catalog describes available apps. Status describes installed apps, including their versions, desired state, container health, latest verification, latest backup, local overrides, links, domains, and orphaned volumes. Use JSON when you need all fields.

Install one app, several apps, or a bundle:

```sh
omactl install testapp --plan
omactl install testapp
omactl install testapp testclient
omactl install --bundle notes-demo
```

Dependencies are installed automatically. Installing an app whose definition is unchanged is a no-op. An installed app with a changed definition follows an update flow with backup and rollback.

Initial settings and extra hostnames can be supplied when installing:

```sh
omactl install testapp \
  --set PUBLIC_URL=http://testapp.localhost:18080 \
  --domain notes.localhost
```

`.env` supplies Compose interpolation; an environment key affects a service only when that service's catalog definition maps it. Repeating an unchanged installation does not apply new `--set` values. Use the app's supported configuration mechanism or a local Compose override for ongoing container settings.

### Install WordPress

Once the instance catalog includes the WordPress entry:

```sh
omactl install wordpress --plan
omactl install wordpress --set WORDPRESS_ADMIN_EMAIL=you@example.com
omactl verify wordpress
omactl credentials wordpress
```

The site uses the `wordpress` host under your instance base domain; its admin login is `/wp-admin/`. Read the [WordPress catalog guide](../catalog/apps/wordpress/README.md) for settings, credentials, backups, and upgrades. Existing instances need a catalog release containing the new entry; rerunning `init --catalog` does not refresh them.

### Install Listmonk

Once the instance catalog includes the Listmonk entry:

```sh
omactl install listmonk --plan
omactl install listmonk
omactl verify listmonk
omactl credentials listmonk
```

Open `/admin` on the `listmonk` host under your instance base domain. The default administrator is `oma-admin` with a generated password. Configure SMTP and the sender address in Settings before sending mail. Read the [Listmonk catalog guide](../catalog/apps/listmonk/README.md) for settings, verification, and backup details.

### Start, stop, and restart

```sh
omactl stop testclient
omactl start testclient
omactl restart testapp
omactl restart testapp testclient
omactl stop --all
omactl start --all
```

These commands update `desired_state`. An intentionally stopped app stays stopped during repair. Restart waits for container readiness; run `verify` afterward to check the app's functionality.

### Verify, repair, and rerun setup

```sh
omactl verify testapp
omactl verify --all
omactl verify --all --repair
omactl setup testapp
```

Repair brings missing or unhealthy containers up for apps whose desired state is `running`. If verification still fails, it reruns the idempotent setup hook and verifies again. An unrepaired failure returns exit code 5.

`setup` reruns the catalog's setup hook. The fixture's repeated setup returns the same API key. Start an intentionally stopped app before rerunning setup on it.

### Read logs and inspect a service

```sh
omactl logs testapp --tail 100
omactl logs testapp --service db --since 30m --tail 200
omactl logs testapp --follow --timeout 3600
omactl logs testapp --json
omactl exec testapp --service db -- pg_isready -U oma -d oma
```

`exec` runs inside the named service, or the app's main service when `--service` is omitted. It is journaled and takes a pre-change backup when backups are configured, because an arbitrary command may change data. `--plan` previews it without executing it.

Log following is bounded by `--timeout` and cannot be combined with `--json`. For automation, use a bounded `--tail` or `--since` request.

### View credentials

```sh
omactl credentials testapp
```

This intentionally prints the app's environment values and captured setup outputs, including secrets. It is the only command intended to expose secrets. Keep its output out of shared logs, screenshots, issue reports, and shell command arguments. Ordinary logs, errors, journals, and JSON output redact known secrets.

## Connect apps and manage domains

### Capability links

A provider advertises a capability, such as `notes.api`. A consumer uses the provider's URL and credentials through environment keys declared in its manifest.

```sh
omactl install testclient
omactl status testclient --json
omactl verify testclient
```

A required capability links automatically when one installed provider exists. With no provider, its declared default provider is installed. With several providers, choose one explicitly during installation:

```sh
omactl install testclient --link notes.api=testapp
```

Manage a link on an installed app:

```sh
omactl link testclient testapp --capability notes.api --plan
omactl link testclient testapp --capability notes.api
omactl verify testclient

omactl unlink testclient testapp --capability notes.api
omactl link testclient testapp --capability notes.api
```

The order is **consumer, then provider**. Use the `link` command to change an existing connection; an unchanged `install` is a no-op even when you supply a different provider selection. Linking updates the consumer environment, recreates its containers, runs its link hook, and verifies it. Unlinking a required capability marks the consumer `degraded`; relinking can return it to its desired state.

### Extra hostnames

```sh
omactl domain add testapp notes.localhost --route web --plan
omactl domain add testapp notes.localhost --route web
omactl domain list testapp
omactl domain list testapp --route web
omactl domain remove testapp notes.localhost --route web
```

If `--route` is omitted, add and remove use the app's first route. Listing shows configured extra hostnames; the default `<appId>.<base_domain>` host is rendered separately and remains in place. These commands configure Traefik routing, not DNS.

## Backups and restore

### Repository credentials

For a local repository, use the `backup init` command from the walkthrough. For an S3-compatible repository, prepare a private environment file containing your credentials:

```dotenv
AWS_ACCESS_KEY_ID=replace-with-your-access-key
AWS_SECRET_ACCESS_KEY=replace-with-your-secret-key
AWS_DEFAULT_REGION=replace-with-your-region
```

Use single-line `KEY=value` entries. Set the file's permissions to `0600`, then supply it to initialization:

```sh
chmod 600 "$HOME/oma-backup-credentials.env"

omactl backup init \
  --repository 's3:https://YOUR_ENDPOINT/YOUR_BUCKET/YOUR_INSTANCE_PREFIX' \
  --env-file "$HOME/oma-backup-credentials.env" \
  --policy self-managed
```

Replace the uppercase repository placeholders and credential values with the settings from your storage service. Use a repository or prefix dedicated to the instance. The restic repository password is generated when absent and stored with the credentials in `OMA_HOME/secrets/backup.env`.

Keep a protected copy of the original `omactl.yml` and `secrets/backup.env` separately from the machine. They preserve the instance identity, repository location, and password needed to locate and decrypt its snapshots. An encrypted backup repository alone does not replace possession of its password.

With Docker Desktop, a local repository directory must be available through Docker's file sharing. If initialization reports a bind-mount error, check that directory's sharing and permissions.

### Create and inspect snapshots

```sh
omactl backup run --app testapp
omactl backup run --app testapp testclient
omactl backup run --all --reason manual
omactl backup list --app testapp
omactl backup list --app testapp --reason pre-update --json
omactl backup check
```

Each app gets its own snapshot. Backups run the app's pre-backup hook, capture file-policy volumes and app configuration, and record a snapshot ID. PostgreSQL fixture backups include a database dump; its raw database volume is covered through that dump rather than copied live.

Supported reasons are `manual`, `nightly`, `pre-update`, `pre-remove`, and `pre-restore`. A failure for one app does not prevent attempts for the other selected apps; inspect the command's results or operation journal.

### Restore an installed app

Restore replaces the selected app's backed-up volume contents. Preview the operation first:

```sh
omactl backup list --app testapp
omactl restore testapp --latest --plan
omactl restore testapp --latest --confirm testapp
omactl verify testapp
```

To choose a particular snapshot, replace `SNAPSHOT_ID` below with an ID from `backup list`:

```sh
omactl restore testapp --snapshot SNAPSHOT_ID --plan
omactl restore testapp --snapshot SNAPSHOT_ID --confirm testapp
```

Before restoring, omactl snapshots the current state, stops the app, replaces backed-up file-volume data, runs any post-restore database load, starts the app, and verifies it. If its desired state was stopped, it stops the app again after verification.

The default keeps the current app configuration. To also recover the snapshot's Compose files, environment, hooks, and app lock:

```sh
omactl restore testapp --latest --with-config --plan
omactl restore testapp --latest --with-config --confirm testapp
```

`--with-config` can replace or remove local overrides to match the snapshot. It differs from an update, which preserves the current override. It can also restore an older app definition, so review the snapshot before applying it.

The app must be installed, and the instance identity and repository credentials must remain available. This is an app-level restore command; v1 has no single command for recovering an entire lost machine or instance directory.

### Retention and pruning

```sh
omactl backup prune --plan
omactl backup prune --confirm instance
```

Pruning applies only with `backup.policy: self-managed`. It keeps 7 daily, 4 weekly, and 6 monthly snapshots and protects pre-update snapshots younger than 14 days.

With `policy: central`, the command exits 3; retention is managed centrally. Pruning requires `--confirm instance`, and `--yes` cannot substitute for that confirmation.

## Local overrides

Place local Compose changes in the installed app's `compose.override.yml`. For the default instance location, this fixture example is `~/.oma/apps/testapp/compose.override.yml`:

```yaml
services:
  testapp:
    environment:
      SLOW_START_SECONDS: '2'
```

If you selected another home, use that instance directory instead. Inspect and apply the change:

```sh
omactl overrides testapp --json
omactl restart testapp --plan
omactl restart testapp
omactl verify testapp
```

`overrides` reports the configuration with and without the override and an effective diff. Restart reapplies the Compose configuration; when settings change, Compose recreates the affected containers.

Updates preserve this file. If an override no longer merges with a new definition, the update fails and attempts rollback. Report useful fixes upstream so they can become catalog changes.

Do not edit the installed `compose.yml`, `compose.generated.yml`, or the instance's `catalog/` as local fixes. omactl owns and replaces those files. To retire a local override, remove or revise that override file, then inspect, restart, and verify the app again.

## Updates and rollback

### Release configuration is required

Network updates require a release server and a binary compiled with the publisher's trusted production public keys. The default build from this repository has no supplied production trust root; it refuses untrusted network releases. The local catalog walkthrough does not configure release publication.

Until your release distribution is configured, continue using the local catalog and rebuild/install the executable manually when needed. Do not add the public fixture test key to production builds. Build and release configuration is described in [ARCHITECTURE.md](ARCHITECTURE.md).

### Update catalog apps

Once a trusted release service is configured:

```sh
omactl update --check
omactl update --plan
omactl update
omactl verify --all
```

Limit application changes to selected installed apps:

```sh
omactl update testapp --check
omactl update testapp --plan
omactl update testapp
omactl verify testapp
```

The catalog release itself is replaced as a whole; the app arguments limit which installed apps are updated. Each changed app gets a pre-update snapshot. omactl applies the new definition, waits for readiness, runs migration and setup hooks, and verifies it. Existing environment values and local overrides are retained.

If an app update fails, omactl attempts to recover its previous definition and snapshot:

| Exit | Outcome                                          | Next step                                       |
| ---- | ------------------------------------------------ | ----------------------------------------------- |
| 0    | Update succeeded                                 | Verify the resulting apps                       |
| 6    | Update failed; rollback succeeded                | Inspect history and logs before another attempt |
| 7    | Update and rollback failed; app is `needs_human` | Stop automatic retries and get operator help    |

### Channels and update policy

The instance configuration contains `channel` and `updates`:

| Setting           | Behavior                                                                    |
| ----------------- | --------------------------------------------------------------------------- |
| `channel: stable` | Read the stable release channel                                             |
| `channel: canary` | Read the canary release channel                                             |
| `channel: pinned` | Require an explicit `--to` version for release changes                      |
| `updates: notify` | Scheduled update jobs check and record availability                         |
| `updates: auto`   | Scheduled update jobs apply app updates and then check/apply binary updates |
| `updates: off`    | Scheduled update jobs skip release checks                                   |

The update policy controls scheduled jobs. An explicit `omactl update` still requests an update. Use `--check` for an explicit read-only check.

For an explicit release, replace `CATALOG_VERSION` with the release's catalog version:

```sh
omactl update --to CATALOG_VERSION --check
omactl update --to CATALOG_VERSION --plan
omactl update --to CATALOG_VERSION
```

### Update the executable

```sh
omactl self-update --check
omactl self-update --plan
omactl self-update
omactl version
```

Self-update checks the signed release and asset hash, smoke-tests the new executable, and replaces the current binary. It requires a compiled executable in a directory writable by its user. The previous executable is saved alongside it as `omactl.prev`.

Roll back that executable with:

```sh
omactl self-update --rollback --plan
omactl self-update --rollback --confirm instance
omactl version
```

Binary rollback changes the executable. It does not roll back app data or catalog updates. App data recovery uses `restore`.

## Scheduled maintenance

First configure backups and verify that manual backup and verification succeed. For a local development build without a production release service, change the existing `updates` value in your instance's `omactl.yml` to `off` before enabling schedules. Keep the rest of that configuration file intact.

```sh
omactl schedule install --plan
omactl schedule install
omactl schedule status
```

Use the installed, compiled binary. Scheduler installation from a Bun source invocation is refused.

| Job            | Schedule                                      | Work                                                           |
| -------------- | --------------------------------------------- | -------------------------------------------------------------- |
| Boot repair    | Boot/startup                                  | Wait for Docker and repair apps whose desired state is running |
| Nightly backup | A fixed minute inside `backup.nightly_window` | Back up all apps and run a repository data-subset check        |
| Update check   | Every 6 hours                                 | Follow the configured update policy                            |
| Verify         | Hourly                                        | Verify apps, then send a heartbeat when enabled                |

The nightly minute is derived from the instance ID. The default window is `01:00-05:00`. Change the existing `backup.nightly_window` value and reinstall schedules if you want a different window.

On macOS, jobs use per-user LaunchAgents. Docker must still be installed and able to start for that user. On Linux, root installation uses system units; non-root installation uses user units and reports that lingering must be enabled for unattended startup. An administrator can arrange lingering as indicated by the warning. WSL2 scheduling requires systemd.

Remove maintenance schedules without removing apps:

```sh
omactl schedule remove --plan
omactl schedule remove
```

Overlapping mutations are serialized through the global instance lock.

## Configuration and stored data

omactl resolves the instance directory in this order: `--home`, then `OMA_HOME`, then `~/.oma`.

| Location under the instance directory | Purpose                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| `omactl.yml`                          | Instance identity, initial routing settings, release policy, backup settings, heartbeat URL |
| `catalog/`                            | Current catalog definitions owned by omactl                                                 |
| `apps/<appId>/compose.yml`            | Installed catalog Compose definition                                                        |
| `apps/<appId>/compose.generated.yml`  | Generated labels, networking, restart policy, and system ingress settings                   |
| `apps/<appId>/compose.override.yml`   | Your local Compose changes                                                                  |
| `apps/<appId>/.env`                   | App settings, secrets, and captured outputs; mode 0600                                      |
| `apps/<appId>/app.lock.json`          | Installed version, desired state, links, domains, verification and backup metadata          |
| `system/traefik/`                     | Rendered ingress configuration and routes                                                   |
| `secrets/backup.env`                  | Repository credentials and password; mode 0600                                              |
| `state/ops/`                          | Operation journals                                                                          |
| `logs/omactl.jsonl`                   | Structured, redacted operation logs                                                         |
| `.git/`                               | Local configuration history managed by omactl                                               |

App data is stored in **named Docker volumes**, not inside the app's host directory. Copying `apps/testapp/` alone is not a data backup. Configuration history also excludes `.env` and the secrets directory, so it does not replace encrypted snapshots and protected credential storage.

### Optional heartbeats

Heartbeats are off by default. To enable them, set the existing `heartbeat.url` in `omactl.yml` to your endpoint and place its bearer token in `secrets/heartbeat-token` with mode `0600`.

```sh
omactl heartbeat --json
```

A heartbeat includes instance and version information, support tier, doctor results, and per-app verification and backup status. Failed delivery reports a warning rather than turning a successful maintenance job into a failure.

## JSON and automation

Every command supports `--json`. A typical maintenance sequence is:

```sh
omactl doctor --json
omactl status --json
omactl restart testapp --plan --json
omactl restart testapp --json
omactl verify testapp --json
```

Read the plan before applying it. `--plan` does not change instance state, although release plans can download and validate release material in temporary storage.

A response has this shape; actual data depends on the command:

```json
{
  "ok": true,
  "command": "heartbeat",
  "op_id": null,
  "data": { "sent": false, "enabled": false },
  "warnings": [],
  "error": null
}
```

Mutating operations normally return an `op_id` that you can find in `history`. Read `error.code`, `error.hint`, and `error.details` on failure. JSON Schemas are supplied in `schemas/output/`; the agent operating contract is [AGENT.md](AGENT.md).

| Exit code | Meaning                                                         |
| --------- | --------------------------------------------------------------- |
| 0         | Success                                                         |
| 1         | Unexpected or execution failure                                 |
| 2         | Invalid arguments or usage                                      |
| 3         | Failed prerequisite or policy check                             |
| 4         | Another mutation holds the lock past the timeout                |
| 5         | Functional verification failed                                  |
| 6         | Change failed; rollback succeeded                               |
| 7         | Rollback failed; human intervention required                    |
| 8         | Required destructive confirmation is missing; plan returned     |
| 9         | Requested app, snapshot, capability, or operation was not found |

Global flags:

| Flag                          | Use                                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `--json`                      | Emit the structured envelope                                                                                |
| `--home <path>`               | Select the instance directory                                                                               |
| `--plan`                      | Preview a mutation without applying it                                                                      |
| `--confirm <appId\|instance>` | Explicitly confirm the matching destructive operation                                                       |
| `--yes`                       | Accept non-destructive prompts; does not replace `--confirm`                                                |
| `--lock-timeout <seconds>`    | Wait for the global lock; default 120; use 0 for no waiting                                                 |
| `--timeout <seconds>`         | General Docker/HTTP timeout; default 300; hooks, readiness, and backups also have operation-specific limits |
| `--verbose`                   | Include Docker timing diagnostics on stderr                                                                 |
| `--quiet`                     | Suppress readable output; JSON envelopes and exit status remain available                                   |

The destructive confirmations are `remove --purge`, `restore`, `backup prune`, and `self-update --rollback`. Confirmation targets are case-sensitive app IDs, or `instance` for prune and binary rollback.

## Remove apps

A backup repository must be configured before removal. Default removal deletes the app's containers, routes, and installed folder while retaining its named volumes:

```sh
omactl remove testclient --plan
omactl remove testclient
```

Retained volumes appear as orphaned in `status`. Reinstalling an app with retained volumes retrieves its saved credentials from the instance's backup repository so it can use those volumes again.

A provider with consumers cannot be removed normally. Remove consumers first, or deliberately use `--force` to leave the consumers marked `degraded`:

```sh
omactl remove testapp --force --plan
omactl remove testapp --force
```

`--force` permits removing an in-use provider. It does not delete volumes or replace destructive confirmation.

To also delete a data-bearing app's volumes, take account of its consumers first, then preview and confirm the purge:

```sh
omactl remove testapp --purge --plan
omactl remove testapp --purge --confirm testapp
```

If consumers still exist and you intend to remove their provider anyway, add `--force` to the confirmed command. Purge takes a final backup before deleting volumes. Existing backup snapshots remain in the repository and follow the separate retention policy. The system Traefik app cannot be removed through `remove`.

## Troubleshooting

Start with these commands, keeping ordinary output visible:

```sh
omactl doctor --json
omactl status --json
omactl logs testapp --tail 200
omactl history --limit 10 --json
```

Use `history --op` with an operation ID returned by a command to inspect that operation's plan, steps, results, diagnostics, and snapshots. The on-disk journal is `state/ops/<opId>.json`.

| Symptom                                  | What to do                                                                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `omactl: command not found`              | Confirm the executable is in `~/.local/bin`, add that directory to PATH, and open a new terminal                                         |
| Docker unavailable or daemon unreachable | Start your Docker environment; inspect `docker version --format json` and the active context                                             |
| `NOT_INITIALIZED`                        | Use the correct `--home`/`OMA_HOME`, or initialize that instance with a catalog                                                          |
| `ORPHANED_DATA` during installation      | Existing app volumes need their saved credentials; restore access to the original instance configuration and backup repository           |
| Ingress port occupied                    | Choose a free port during first initialization; changing flags on a later `init` is a no-op                                              |
| Root URL returns 404                     | The fixtures are API services; use `verify` and the documented API routes rather than expecting a homepage                               |
| App unhealthy or verification fails      | Read service logs and history, then try `verify <app> --repair` if that app should be running                                            |
| Stopped app is skipped by repair         | This is intentional; run `start <app>` before verifying it                                                                               |
| Ambiguous provider or capability         | Select `--link capability=app` during installation, or `--capability` for explicit link/unlink                                           |
| `BACKUP_NOT_CONFIGURED`                  | Run `backup init`, then `backup run` and `backup check`                                                                                  |
| Backup repository unreachable            | Check Docker access to a local path, storage connectivity, credentials, and the repository password; do not delete the password to retry |
| `SNAPSHOT_NOT_FOUND`                     | List snapshots for the app; check the instance identity, selected repository, and snapshot ID                                            |
| `SNAPSHOT_VOLUME_MISMATCH`               | Review the snapshot's app version; `--with-config` restores its matching definition when that is the intended recovery                   |
| `INVALID_SIGNATURE`                      | Check the release server and compiled trusted keys; do not bypass the check or trust the fixture key in production                       |
| `LOCK_HELD` / exit 4                     | Inspect the active operation, wait, or increase `--lock-timeout`; dead-PID locks are reclaimed automatically                             |
| Exit 6 after update                      | The old version was recovered; inspect the failed update and fix its cause before retrying                                               |
| `needs_human` / exit 7                   | Stop automatic retries and preserve journals and backup information for an operator                                                      |
| Exit 8                                   | Review the returned plan; provide the exact matching `--confirm` only if you intend that destructive action                              |
| Schedule install fails from source       | Invoke the installed compiled binary instead of `bun run dev`                                                                            |
| Linux user jobs do not run after reboot  | Check user lingering and systemd availability                                                                                            |
| WSL2 scheduling fails                    | Enable systemd and keep instance state on the WSL Linux filesystem                                                                       |

When reporting a problem, include the binary/catalog versions, doctor result, affected app, operation ID, and redacted logs or override diff. Do not include credential output, `.env`, or `secrets/backup.env`.

## Command reference

Run `omactl --help` for the full command list and `omactl <command> --help` for flags. For nested commands, use forms such as `omactl backup run --help`.

| Command                                                        | Purpose                                                                          |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `init`                                                         | Initialize one instance and install Traefik                                      |
| `doctor`                                                       | Check platform, Docker, resources, ports, clock, network, and configured backups |
| `catalog list` / `catalog show <app>`                          | Browse app definitions                                                           |
| `catalog lint <path>`                                          | Validate a catalog; `--allow-local-images` is for development fixtures           |
| `install [apps...]` / `install --bundle <id>`                  | Install with dependencies, setup, links, routing, and verification               |
| `remove <app>`                                                 | Back up and remove an app; retain volumes unless confirmed purge is requested    |
| `start`, `stop`, `restart`                                     | Manage app lifecycle and desired state; accept app IDs or `--all`                |
| `status [app]`                                                 | Inspect installed state and orphaned volumes                                     |
| `logs <app>`                                                   | Read service logs; optionally follow outside JSON mode                           |
| `verify [apps...]`                                             | Run functional checks; `--repair` attempts recovery of desired-running apps      |
| `setup <app>`                                                  | Rerun its idempotent setup hook                                                  |
| `link <consumer> <provider>` / `unlink`                        | Manage capability connections                                                    |
| `domain add`, `domain remove`, `domain list`                   | Manage extra hostnames per app route                                             |
| `credentials <app>`                                            | Intentionally display app secrets and outputs                                    |
| `exec <app> -- <command...>`                                   | Execute inside an app service                                                    |
| `overrides [app]`                                              | Inspect local overrides and their effective differences                          |
| `backup init`                                                  | Configure, initialize, and check the backup repository                           |
| `backup run` / `backup list` / `backup check` / `backup prune` | Create snapshots, inspect them, check integrity, and apply retention             |
| `restore <app>`                                                | Restore an installed app from a chosen or latest snapshot                        |
| `update`                                                       | Check or apply a signed catalog release and transactional app updates            |
| `self-update`                                                  | Check or replace the executable; supports confirmed binary rollback              |
| `schedule install` / `schedule status` / `schedule remove`     | Manage native maintenance jobs                                                   |
| `history`                                                      | Inspect operation journals                                                       |
| `heartbeat`                                                    | Send optional status to the configured endpoint                                  |
| `version`                                                      | Print binary/catalog versions, platform, and support tier                        |

For catalog authoring, read [CATALOG.md](CATALOG.md). For implementation and release distribution, read [ARCHITECTURE.md](ARCHITECTURE.md). For the tested environments and current validation scope, read [VERIFICATION.md](VERIFICATION.md).
