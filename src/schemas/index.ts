import { z } from 'zod';
export const AppId = z.string().regex(/^[a-z][a-z0-9-]{1,30}$/);
const Hook = z.object({
  service: AppId,
  script: z.string().regex(/^hooks\/[a-zA-Z0-9._/-]+\.sh$/),
  timeout: z.number().positive().default(120),
  one_off: z.boolean().default(false),
});
export const Manifest = z
  .object({
    id: AppId,
    name: z.string().min(1),
    version: z.string().min(1),
    description: z.string(),
    resources: z.object({ memory_mb: z.number().nonnegative(), disk_mb: z.number().nonnegative() }),
    requires: z.array(AppId).default([]),
    main_service: AppId,
    routes: z
      .array(
        z.object({
          name: z.string().regex(/^[a-z][a-z0-9-]*$/),
          service: AppId,
          port: z.number().int().min(1).max(65535),
          host: z.string(),
        }),
      )
      .default([]),
    volumes: z
      .array(
        z.object({
          key: z.string().regex(/^[a-z][a-z0-9_-]*$/),
          backup: z.enum(['files', 'skip']),
        }),
      )
      .default([]),
    stop_during_backup: z.boolean().default(false),
    env: z
      .array(
        z.object({
          name: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
          generate: z
            .string()
            .regex(/^(password|token):[1-9][0-9]{0,3}$/)
            .optional(),
          value: z.string().optional(),
          secret: z.boolean().default(false),
        }),
      )
      .default([]),
    config_files: z
      .array(
        z.object({ template: z.string().regex(/^files\//), volume: z.string(), path: z.string() }),
      )
      .default([]),
    provides: z
      .array(
        z.object({
          capability: z.string().regex(/^[a-z][a-z0-9_.-]+$/),
          outputs: z.record(z.string(), z.string()),
        }),
      )
      .default([]),
    consumes: z
      .array(
        z.object({
          capability: z.string(),
          required: z.boolean(),
          env_prefix: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
          default_provider: AppId.optional(),
        }),
      )
      .default([]),
    hooks: z.object({
      setup: Hook,
      verify: Hook,
      pre_backup: Hook.nullable().optional(),
      post_restore: Hook.nullable().optional(),
      migrate: Hook.nullable().optional(),
      on_link: Hook.nullable().optional(),
    }),
    ready_timeout: z.number().int().positive().default(180),
  })
  .strict()
  .superRefine((m, c) => {
    if (m.main_service !== m.id)
      c.addIssue({ code: 'custom', message: 'main_service must equal id', path: ['main_service'] });
    for (const field of ['env', 'routes', 'volumes'] as const) {
      const keys = m[field].map((v: any) => v.name ?? v.key);
      if (new Set(keys).size !== keys.length)
        c.addIssue({ code: 'custom', message: `Duplicate ${field} key`, path: [field] });
    }
  });
export type AppManifest = z.infer<typeof Manifest>;
export const Config = z.object({
  instance_id: z.string(),
  base_domain: z.string().min(1),
  ingress: z.object({
    http_port: z.number().int().min(1).max(65535),
    https_port: z.number().int().min(1).max(65535),
    tls: z.enum(['off', 'acme']),
    acme_email: z.string().nullable(),
  }),
  channel: z.enum(['stable', 'canary', 'pinned']),
  release_url: z.url(),
  updates: z.enum(['auto', 'notify', 'off']),
  backup: z.object({
    repository: z.string().nullable(),
    policy: z.enum(['self-managed', 'central']),
    nightly_window: z.string().regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/),
  }),
  heartbeat: z.object({ url: z.url().nullable() }),
});
export type InstanceConfig = z.infer<typeof Config>;
export const AppLock = z.object({
  id: AppId,
  version: z.string(),
  catalog: z.string(),
  fingerprint: z.string(),
  manifest: Manifest,
  desired_state: z.enum(['running', 'stopped']),
  state: z.enum(['running', 'stopped', 'failed', 'degraded', 'needs_human']),
  links: z.record(z.string(), AppId),
  domains: z.record(z.string(), z.array(z.string())),
  outputs: z.array(z.string()),
  installed_at: z.string(),
  updated_at: z.string(),
  last_verify: z.object({ ok: z.boolean(), at: z.string() }).nullable(),
  last_backup: z.object({ snapshot: z.string(), at: z.string(), size: z.number() }).nullable(),
});
export type InstalledApp = z.infer<typeof AppLock>;
export const Plan = z.object({
  command: z.string(),
  targets: z.array(z.string()),
  destructive: z.boolean(),
  confirmation: z.string().nullable(),
  steps: z.array(z.string()),
});
export type OperationPlan = z.infer<typeof Plan>;
export const Warning = z.object({ code: z.string(), message: z.string() });
export const ErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  hint: z.string().optional(),
  details: z.record(z.string(), z.unknown()),
});
const Check = z.object({
  name: z.string(),
  status: z.enum(['ok', 'warn', 'fail']),
  message: z.string(),
  hint: z.string().optional(),
});
const Result = z.object({
  app: z.string(),
  ok: z.boolean(),
  skipped: z.boolean().optional(),
  snapshot: z.string().optional(),
  error: z.string().optional(),
});
const Version = z.object({
  version: z.string(),
  catalog: z.string().nullable(),
  platform: z.string(),
  support_tier: z.string(),
});
const Changes = z.object({
  current: z.string().nullable(),
  available: z.string(),
  changed: z.array(
    z.object({
      app: z.string(),
      from: z.string(),
      to: z.string(),
      diff: z.record(z.string(), z.unknown()),
    }),
  ),
});
export const dataSchemas = {
  version: Version,
  doctor: z.object({ support_tier: z.string(), checks: z.array(Check) }),
  init: z.object({ initialized: z.boolean(), instance_id: z.string(), home: z.string() }),
  'catalog list': z.object({
    version: z.string(),
    apps: z.array(Manifest),
    bundles: z.array(z.string()),
  }),
  'catalog show': Manifest,
  'catalog lint': z.object({ valid: z.boolean(), errors: z.array(z.string()), apps: z.number() }),
  install: z.object({ results: z.array(Result) }),
  remove: z.object({ app: z.string(), purged: z.boolean() }),
  start: z.object({ results: z.array(Result) }),
  stop: z.object({ results: z.array(Result) }),
  restart: z.object({ results: z.array(Result) }),
  status: z.object({
    apps: z.array(
      AppLock.extend({
        containers: z.array(z.record(z.string(), z.unknown())),
        override: z.boolean(),
      }),
    ),
    orphaned_volumes: z.array(z.string()),
  }),
  logs: z.object({ app: z.string(), logs: z.string() }),
  verify: z.object({ results: z.array(Result) }),
  setup: z.object({ app: z.string(), outputs: z.array(z.string()) }),
  link: z.object({ consumer: z.string(), provider: z.string(), capability: z.string() }),
  unlink: z.object({ consumer: z.string(), provider: z.string(), capability: z.string() }),
  'domain add': z.object({ app: z.string(), domains: z.record(z.string(), z.array(z.string())) }),
  'domain remove': z.object({
    app: z.string(),
    domains: z.record(z.string(), z.array(z.string())),
  }),
  'domain list': z.object({ app: z.string(), domains: z.record(z.string(), z.array(z.string())) }),
  credentials: z.object({ app: z.string(), values: z.record(z.string(), z.string()) }),
  exec: z.object({
    app: z.string(),
    stdout: z.string(),
    stderr: z.string(),
    exit_code: z.number(),
  }),
  overrides: z.object({
    apps: z.array(
      z.object({
        app: z.string(),
        base: z.string(),
        effective: z.string(),
        diff: z.record(z.string(), z.unknown()),
      }),
    ),
  }),
  'backup init': z.object({ repository: z.string(), initialized: z.boolean() }),
  'backup run': z.object({ results: z.array(Result) }),
  'backup list': z.object({ snapshots: z.array(z.record(z.string(), z.unknown())) }),
  'backup check': z.object({ checked: z.boolean(), output: z.string() }),
  'backup prune': z.object({ pruned: z.boolean(), output: z.string() }),
  restore: z.object({ app: z.string(), snapshot: z.string(), verified: z.boolean() }),
  update: Changes.extend({
    results: z.array(Result).optional(),
    scheduled: z.boolean().optional(),
  }),
  'self-update': z.object({
    current: z.string(),
    available: z.string(),
    updated: z.boolean(),
    rolled_back: z.boolean().optional(),
  }),
  'schedule install': z.object({ jobs: z.array(z.record(z.string(), z.unknown())) }),
  'schedule remove': z.object({ jobs: z.array(z.record(z.string(), z.unknown())) }),
  'schedule status': z.object({ jobs: z.array(z.record(z.string(), z.unknown())) }),
  history: z.object({ operations: z.array(z.record(z.string(), z.unknown())) }),
  heartbeat: z.object({ sent: z.boolean(), enabled: z.boolean() }),
} satisfies Record<string, z.ZodType>;
export type CommandName = keyof typeof dataSchemas;
export function envelopeSchema(command: CommandName) {
  const base = z.object({
    command: z.literal(command),
    op_id: z.string().nullable(),
    warnings: z.array(Warning),
  });
  return z.discriminatedUnion('ok', [
    base.extend({
      ok: z.literal(true),
      data: z.union([dataSchemas[command], Plan]),
      error: z.null(),
    }),
    base.extend({ ok: z.literal(false), data: Plan.nullable(), error: ErrorSchema }),
  ]);
}
