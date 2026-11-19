# Ghost

Ghost 6.78.0 with MySQL 8.0 and persistent content. Both images are pinned to multi-platform indexes for Linux amd64 and arm64. Traefik publishes the site and Ghost Admin; MySQL stays on the private app network. The entry follows the [official Ghost image's production deployment](https://hub.docker.com/_/ghost) with MySQL, rather than SQLite.

## Install

```sh
omactl init --catalog "$PWD/catalog" --http-port 18080
omactl install ghost --plan
omactl install ghost
omactl verify ghost
```

For an existing instance, apply a catalog release containing this entry first. Rerunning `init --catalog` does not refresh an initialized instance's catalog.

For the example above, open `http://ghost.localhost:18080/ghost/` and create the site owner using Ghost's signup screen. **Owner signup is a required browser step.** The setup hook checks readiness and reports whether an owner exists; it never creates or resets owner credentials. `omactl credentials ghost` exposes the generated database passwords, not the password chosen in Ghost Admin.

Choose the public URL, DNS, and TLS configuration before installing on a server. Production publishing and administration should use HTTPS. `PUBLIC_URL` is rendered from the web route, including any nonstandard ingress port, and is passed to Ghost as its canonical `url`. If the site address changes later, update the app environment and restart Ghost.

Ghost applies its database migrations at startup and seeds the content volume with the bundled theme. Repeated setup preserves users, settings, posts, themes, and uploads. Content stays at `/var/lib/ghost/content` for this pinned image; other image variants can use a different path and need a planned migration.

## Mail and optional services

Configure SMTP through a local Compose override before relying on staff sign-in verification emails, password resets, or member mail. Ghost's normal staff device verification remains enabled. Newsletter delivery has its own Ghost/Mailgun configuration. This entry does not provision email, ActivityPub, or a separate analytics service; it provides the publishing site and Ghost Admin.

## Verify

Verification works before and after owner signup. It reads Ghost's site title, writes and reads a row in a connection-local temporary MySQL table, then removes that table. It also writes and reads a temporary PNG as Ghost's `node` user and checks that Ghost serves those exact bytes over HTTP. The file is removed afterward. This checks database access, database writes, application filesystem permissions, persistence-volume access, and image serving; it does not exercise authenticated post authoring.

## Back up and restore

```sh
omactl backup init --repository "$HOME/oma-backups"
omactl backup run --app ghost
omactl restore ghost --latest --plan
omactl restore ghost --latest --confirm ghost
omactl verify ghost
```

The `content` volume is backed up as files and contains themes, images, files, and other Ghost content. MySQL's `dbdata` volume is skipped in favor of a logical SQL dump in the backed-up `dump` volume. Restore loads this dump before Ghost starts, including when the database volume has been lost. The database account and root account have independently generated passwords, passed through the service environment rather than command arguments.

Containers stop while file volumes are copied. For a fully quiescent backup under active traffic, stop Ghost first; omactl starts MySQL for the dump and preserves the stopped desired state. Take a backup before catalog upgrades, which run Ghost's database migrations at startup.
