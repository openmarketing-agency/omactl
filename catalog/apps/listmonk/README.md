# Listmonk

Listmonk 6.2.0 with PostgreSQL 17, persistent uploads, and a temporary Bun service for setup and functional verification. All images are pinned to multi-platform digests for Linux amd64 and arm64. Traefik publishes the web interface; PostgreSQL stays on the private app network.

## Install

```sh
omactl init --catalog "$PWD/catalog" --http-port 18080
omactl install listmonk --plan
omactl install listmonk
omactl verify listmonk
omactl credentials listmonk
```

For an existing instance, apply a catalog release containing this entry first. Rerunning `init --catalog` does not refresh an initialized instance's catalog.

Open `http://listmonk.localhost:18080/admin` for the example above. The default administrator username is `oma-admin`; the administrator and database passwords are generated independently. Set `LISTMONK_ADMIN_USER` during installation to choose another username. Setup uses the rendered public URL, including the ingress port, as Listmonk's initial root URL. Choose the deployment domain and TLS settings before installing.

The startup command performs an idempotent database installation and applies migrations before serving requests, following [Listmonk's Docker installation](https://listmonk.app/docs/installation/). Repeated setup preserves users, passwords, lists, and customized settings. Password changes made in Listmonk must also be reflected in the app environment if the verification hook is to continue logging in. Two-factor authentication on the bootstrap account also requires adapting verification to use a separate API account.

## Mail and media settings

Configure your SMTP provider, sender address, and sending limits in **Settings** before sending campaigns. Installation does not configure a mail provider or send mail. In Media settings, the filesystem upload path should remain `uploads` (resolved to `/listmonk/uploads`) to use the persistent volume. Review the root URL in Settings if the public address changes later.

## Verify

The hook logs in as the configured administrator, creates and reads a private list and an enabled subscriber through the API, then deletes both. It also writes, reads, and removes a temporary file in the uploads volume. The subscriber uses `example.invalid` and preconfirmed subscriptions; verification does not send campaigns or opt-in messages. Secrets are read from the service environment rather than command arguments.

## Back up and restore

```sh
omactl backup init --repository "$HOME/oma-backups"
omactl backup run --app listmonk
omactl restore listmonk --latest --plan
omactl restore listmonk --latest --confirm listmonk
omactl verify listmonk
```

The `uploads` volume is copied as files. PostgreSQL's `pgdata` volume is skipped in favor of a custom-format logical dump in the backed-up `dump` volume. Restore loads that dump with failure checking before starting Listmonk, including when the database volume has been lost. Containers stop while file volumes are copied. For a fully quiescent backup during active sending, stop the app before backing up; omactl starts the database for the dump and preserves the stopped desired state.

Catalog-driven upgrades run Listmonk's database migrations at startup. Take a backup before changing versions.
