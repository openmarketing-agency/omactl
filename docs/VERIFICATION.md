# Verification

Validated locally on 2026-11-18 with Bun 1.4.4, macOS arm64, Docker Desktop Engine 29.5.3 and Compose 5.1.4.

| Check                                           | Result                                          |
| ----------------------------------------------- | ----------------------------------------------- |
| TypeScript type checking                        | Passed                                          |
| Portability lint                                | Passed                                          |
| Unit tests, macOS arm64                         | 22 passed                                       |
| Unit tests, Linux arm64 container               | 22 passed                                       |
| Unit tests, Linux x64 container under emulation | 22 passed                                       |
| Required Docker acceptance scenarios            | All 16 passed                                   |
| Build targets                                   | All six compiled from this runner               |
| Linux x64/arm64, glibc/musl binary smoke tests  | All four executed `version --json` successfully |
| Native macOS arm64 binary                       | Executed `version --json` successfully          |

The acceptance suite runs real PostgreSQL, fixture app, Traefik and restic containers. It validates functional notes/files operations, data recovery after loss of the database volume, configuration restore, capability wiring, domains, retained-volume reinstalls with original credentials, persistent overrides, signed updates, successful and failed rollback, boot repair, intentionally stopped apps, two concurrent CLI mutations, destructive confirmation, binary self-update/rollback, JSON Schema compliance and secret redaction.

Commands:

```sh
bun run typecheck
bun run lint
bun test test/unit
bun run build
OMA_E2E=1 bun run test:e2e
bun scripts/smoke-targets.ts
```

Full acceptance on native Linux x64/arm64 CI, a physical reboot, macOS x64 execution, and WSL2 have not been run in this workspace. CI contains Linux x64/arm64 acceptance jobs and a conditional cloud-VM reboot workflow. Cloud testing needs the repository's AWS/AMI/SSH settings; release publication needs production signing keys, GitHub credentials and release-host settings. Tests use a deliberately public fixture keypair that default builds do not trust. No release was published during development.

## WordPress catalog addition

The WordPress entry was checked with 23 passing unit tests, catalog lint, type checking, and portability lint. A separate real-Docker integration test passed on macOS arm64/Docker Desktop: install, functional REST/database/upload checks, repeated setup with stable credentials, core-file migration preserving content, and recovery of a persistent post and upload after deletion of the MariaDB data volume. The test also checked generated secrets against operation journals and logs. The Linux x64/arm64 CI matrix now includes this WordPress integration test; those new CI runs have not been executed in this workspace.

## Ghost catalog addition

The Ghost entry passed manifest loading, named-volume and hook-service checks, shell and Node syntax checks, Compose configuration validation, type checking, portability lint, and the existing 23 unit tests. Registry indexes for Ghost 6.78.0 Alpine and MySQL 8.0 were checked for Linux amd64 and arm64. A Docker integration test was added to the Linux x64/arm64 CI matrix for repeated setup, database writes, image serving, temporary-file cleanup, and recovery of settings and content after database-volume loss.

The host still had only about 203 MB free after Docker storage errors, so Ghost images were not pulled and the runtime integration test was not run locally. Full Docker-backed catalog lint and the new CI runs remain pending. Ghost owner signup is intentionally a browser step and is not automated or covered by this integration test.
