# WordPress

WordPress 7.1.4 on Apache/PHP 8.3 with MariaDB 11.4 and an on-demand WP-CLI service. All three images use multi-architecture index digests for Linux amd64 and arm64. Only the main `wordpress` service joins `oma_edge`; MariaDB stays private. Traefik publishes the site.

## Install

For a new instance, run from the omactl repository:

```sh
omactl init --catalog "$PWD/catalog" --http-port 18080
omactl install wordpress --plan
omactl install wordpress \
  --set WORDPRESS_ADMIN_EMAIL=you@example.com \
  --set 'WORDPRESS_SITE_TITLE=My WordPress Site'
omactl verify wordpress
omactl credentials wordpress
```

On an already initialized instance, first apply a catalog release containing this entry. `init --catalog` is a no-op for existing instances and does not refresh their catalog. No CLI rebuild is required to load this app definition.

The default site is `http://wordpress.localhost:18080` for the example above; sign in at `/wp-admin/`. Replace `localhost` with your instance's base domain for a server deployment and arrange DNS. Choose a public URL and TLS configuration before installation. Extra domains do not change WordPress's canonical site URL automatically.

## Credentials and settings

| Variable | Default / purpose |
| --- | --- |
| `WORDPRESS_ADMIN_USER` | `oma-admin` |
| `WORDPRESS_ADMIN_EMAIL` | `admin@wordpress.<base_domain>`; set a real email during installation |
| `WORDPRESS_SITE_TITLE` | `OMA WordPress` |
| `PUBLIC_URL` | Rendered web route URL, including nonstandard ingress port |
| `WORDPRESS_ADMIN_PASSWORD` | Generated once; retrieve through `credentials` |
| `WORDPRESS_DB_PASSWORD` | Generated once for the WordPress database user |
| `MARIADB_ROOT_PASSWORD` | Separate generated database root password |
| `WORDPRESS_*_KEY`, `WORDPRESS_*_SALT` | Eight independently generated authentication secrets |

Setup installs WordPress only when it is not installed, then applies database upgrades. Repeated setup does not reset administrator passwords, change site URLs, or overwrite content. Changing a password in WordPress does not update the original bootstrap password recorded in `.env`.

WordPress's normal web login is available after setup. This catalog does not create an application password or automatically connect a preinstalled Hermes agent. Authenticated REST integrations need their own WordPress application password and endpoint configuration; use HTTPS for remote administration.

## Verify

The verify hook checks that WordPress is installed and the configured administrator exists, creates a draft through the WordPress REST controller, reads back its contents, writes and reads an upload, and checks that Apache serves a real REST index. The temporary post and file are removed in a `finally` block. This exercises WordPress authorization, database persistence, filesystem writes, and HTTP serving.

WP-CLI runs as UID/GID `33:33` to match the Debian Apache image's `www-data` user. It is an ephemeral `tools` profile service rather than an additional daemon.

## Back up and restore

```sh
omactl backup init --repository "$HOME/oma-backups"
omactl backup run --app wordpress
omactl backup list --app wordpress
omactl restore wordpress --latest --plan
omactl restore wordpress --latest --confirm wordpress
omactl verify wordpress
```

| Volume | Backup mode | Contents |
| --- | --- | --- |
| `oma_wordpress_html` | files | WordPress files, configuration, plugins, themes, uploads |
| `oma_wordpress_dbdata` | skip | MariaDB data, covered through a logical dump |
| `oma_wordpress_dump` | files | `wordpress.sql`, created by `mariadb-dump` |

The dump uses the database user's password through an environment variable, never a process argument. Site containers are stopped while restic copies file volumes and brought back up afterward. For a fully quiescent backup under active traffic, stop the app first; omactl starts the database needed for the dump and leaves the desired state stopped afterward. Restore loads the SQL dump before starting WordPress, including when the database volume has been lost.

## Updates

WordPress automatic core updates are disabled so omactl can back up and roll back catalog-driven core upgrades. The migration hook copies core files from the pinned Apache image while preserving `wp-content` and `wp-config.php`; setup then runs the database upgrade. Plugins and themes remain site-owned persistent content. Dashboard plugin/theme changes require their own backup discipline.

The local `WORDPRESS_CONFIG_EXTRA` defaults also disable the dashboard file editor. Review any plugins you add, and take a backup before modifying the site.
