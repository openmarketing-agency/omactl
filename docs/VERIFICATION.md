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

## Umami catalog addition

The Umami entry passed manifest loading, named-volume checks, shell and Node syntax checks, Compose configuration validation, type checking, portability lint, and the existing 23 unit tests. Registry indexes for Umami 3.5.0 and PostgreSQL 17 were checked for Linux amd64 and arm64. A Docker integration test was added for default-password replacement, repeated setup, pageview collection and reporting, cleanup, and recovery after PostgreSQL volume loss; CI runs it on both Linux architectures.

The local Docker integration attempt could not start Umami because the host disk was full and Docker's image store reported input/output errors while pulling the image. Full catalog lint also encountered those Docker storage errors. Runtime setup, analytics, and restore checks remain unverified locally; the new CI runs have not been executed in this workspace.
