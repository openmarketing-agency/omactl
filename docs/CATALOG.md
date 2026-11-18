# Authoring catalog apps

An app is a folder at `apps/<appId>/` (or `system/<appId>/`) containing `manifest.yml`, `compose.yml`, `hooks/`, optional `files/`, and a README. No changes to the CLI are needed. The schema in `schemas/manifest.schema.json` is the format reference. `catalog/` and `fixtures/catalog-v1/` contain complete examples.

The manifest's `id` and `main_service` must be identical and match `^[a-z][a-z0-9-]{1,30}$`. Declare dependencies in `requires`, all resources, every volume's backup policy, and both setup and functional verify hooks. Each long-running Compose service needs a healthcheck. Images must be pinned by tag **and** multi-platform index digest with `linux/amd64` and `linux/arm64` variants. Databases stay on the private project network. omactl attaches the main service to `oma_edge`.

Every volume uses an explicit `name: oma_<appId>_<key>` and a corresponding manifest entry with `backup: files` or `backup: skip`. A database data volume may use `skip` only when a `pre_backup` hook dumps into a `files` volume and `post_restore` loads that dump. No host mounts, Docker sockets, privileged containers, host namespaces, fixed container names, or published ports are permitted. Traefik alone publishes ports through the generated layer.

`env` entries have `name`, optional `value` or `generate: password:N|token:N`, and `secret`. Generated values persist for the lifetime of the app's environment. `.env` is for Compose interpolation; explicitly map values into only the services that require them. Values supplied through `install --set` are never logged.

Templates support `{appId}`, `{base_domain}`, `{url:<route>}`, `{host:<route>}`, `{env:<NAME>}`, `{output:<NAME>}`, and `{link:<capability>.<key>}`. Unknown variables fail. The route URL includes a nonstandard ingress port. Config templates in `files/` are rendered and streamed into named volumes; they never become host bind mounts.

Hooks are POSIX shell scripts streamed to `sh -s` inside the declared service. They receive `OMA_APP_ID`, `OMA_HOOK`, `OMA_OP_ID`, and `OMA_BASE_URL`. A running service uses Compose `exec -T`; a tool service in the `tools` profile or explicit `one_off: true` hook uses `run --rm -T`. Set a finite `timeout` in seconds. Scripts must be idempotent. Setup can emit `OMA_OUTPUT NAME=value`. All captured outputs are treated as secrets, kept in `.env`, and injected into later hooks over stdin. Only output names appear in app locks. Never print a secret elsewhere.

A functional verify must exercise real behavior and check results. The test fixture creates, reads and deletes a database note and writes and reads a file. An HTTP 200 or a running container alone is insufficient.

Providers declare `provides: [{ capability, outputs }]`; consumers declare `consumes: [{ capability, required, env_prefix, default_provider }]`. Output names become uppercase environment keys under `env_prefix`. For example `notes.api` outputs `url` and `api_key` become `NOTES_URL` and `NOTES_API_KEY`. Multiple providers require `install --link notes.api=<appId>`. Bundle files use `{ id, apps }`.

Validate with:

```sh
bun run dev -- catalog lint catalog --allow-local-images --json
```

The local-image exception is for fixture catalogs only. Release lint without the exception checks registries for both architectures. `bun run fixtures` regenerates the three test catalogs and the development catalog. Build the fixture image with:

```sh
docker build --build-arg APP_VERSION=1.0.0 -t omactl-testapp:1.0.0 fixtures/testapp
docker build --build-arg APP_VERSION=2.0.0 -t omactl-testapp:2.0.0 fixtures/testapp
```

A release archive contains `catalog.json`, `system/`, `apps/`, and `bundles/` directly at its root. It must contain regular files/directories only, with no symlinks, absolute paths, or traversal. Release CI validates the catalog before signing it.
