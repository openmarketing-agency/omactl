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
