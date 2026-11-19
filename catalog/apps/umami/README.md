# Umami

Umami 3.5.0 with PostgreSQL 17. Both images are pinned to multi-platform indexes for Linux amd64 and arm64. Traefik publishes the dashboard and tracking endpoints; PostgreSQL stays on the private app network. The image runs database migrations before starting the server, following [Umami's Docker installation](https://docs.umami.is/docs/install).

## Install

```sh
omactl init --catalog "$PWD/catalog" --http-port 18080
omactl install umami --plan
omactl install umami
omactl verify umami
omactl credentials umami
```

For an existing instance, apply a catalog release containing this entry first. Rerunning `init --catalog` does not refresh an initialized instance's catalog.

Open `http://umami.localhost:18080` for the example above. The username is `admin`; setup replaces the upstream default password with the generated `UMAMI_ADMIN_PASSWORD`. Database credentials and `APP_SECRET` are generated independently. Repeated setup logs in with the existing generated password and preserves users and analytics. It changes the default password only when Umami identifies the account as the untouched initial administrator.

If you change the administrator password in the dashboard, update `UMAMI_ADMIN_PASSWORD` in the app environment too so setup and verification can continue to authenticate. Enabling two-factor authentication requires configuring Umami's encryption key through an override and adapting the hooks to use a dedicated API credential. The catalog does not configure two-factor authentication.

## Track a website

Add a website in the dashboard and copy its tracking code into your site's HTML. For example, after replacing the website ID and deployment URL:

```html
<script defer src="https://umami.example.com/script.js" data-website-id="YOUR-WEBSITE-ID"></script>
```

Use an HTTPS address reachable by visitors for a public website. Arrange DNS and TLS for the `umami` host before adding the script. The catalog disables Umami's own telemetry.

## Verify

The hook authenticates as the configured administrator, fetches the tracking script, creates and reads a temporary website, sends a pageview, and checks that analytics reports one view and one visitor. It then deletes the temporary website and its analytics. Credentials and bearer tokens stay inside the hook process rather than command arguments or output.

## Back up and restore

```sh
omactl backup init --repository "$HOME/oma-backups"
omactl backup run --app umami
omactl restore umami --latest --plan
omactl restore umami --latest --confirm umami
omactl verify umami
```

All accounts, websites, and analytics live in PostgreSQL. The `pgdata` volume is skipped in file backups; the pre-backup hook writes a custom-format logical dump to the backed-up `dump` volume. The restore hook loads it with failure checking before Umami starts, including when the database volume has been lost. Keep the app environment with its original `APP_SECRET` for recovery.

Containers stop while file volumes are copied. For a fully quiescent backup under active traffic, stop Umami before backing up; omactl starts the database for the dump and preserves the stopped desired state. Catalog updates run the image's migrations at startup; take a backup before changing versions.
