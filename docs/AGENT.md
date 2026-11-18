# omactl maintenance agent contract

1. Start with `omactl doctor --json` and `omactl status --json`.
2. Run every change with `--plan --json` first and read the plan.
3. Apply it, then run `omactl verify <app> --json`.
4. Fix problems only in `apps/<app>/compose.override.yml`, then run `omactl restart <app>` and `omactl verify <app>`. Never edit `compose.yml` or anything in `catalog/`.
5. Diagnose with `omactl logs`, `omactl exec`, and `omactl history`.
6. Escalate to a human on exit 7, on exit 8, and before any destructive operation.
7. Report every override you create with `omactl overrides --json` so the fix can move upstream.

Use `--home` or `OMA_HOME` to select the single local instance. All commands emit the same JSON envelope: `ok`, `command`, `op_id`, `data`, `warnings`, `error`. Schemas are in `schemas/output/`. Plans have `targets`, `steps`, `destructive`, and `confirmation` fields. Read error `hint` and `details` before taking another action.

| Exit | Meaning                                      |
| ---- | -------------------------------------------- |
| 0    | Success                                      |
| 1    | Unexpected or execution failure              |
| 2    | Invalid usage                                |
| 3    | Precondition or policy failure               |
| 4    | Mutation lock timeout                        |
| 5    | Functional verification failed               |
| 6    | Change failed; rollback succeeded            |
| 7    | Rollback failed; human intervention required |
| 8    | Confirmation required; plan returned         |
| 9    | App, snapshot, or capability not found       |

Only `credentials` prints secrets. Do not copy its output into agent reports. Never put secrets into `exec` arguments; use the app environment and hook stdin. Use `backup init --env-file <secure-file>` for repository credentials. Destructive commands require a matching `--confirm <appId>` or `--confirm instance`; `--yes` does not bypass this.

Apps intentionally stopped by an operator remain stopped during `verify --all --repair`. Stop autonomous repair when an app is `needs_human` and escalate. A provider with consumers cannot be removed without `--force`; forced removal degrades its consumers.
