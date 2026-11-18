import { randomBytes } from 'node:crypto';
import { Context } from './context';
import { acquireLock } from './lock';
import { writeJson, fs, now, exists } from './fs';
import { commit } from './history';
import { OmaError, asError } from './errors';
import type { OperationPlan } from '../schemas';
export class Operation {
  journal: any;
  file: string;
  constructor(
    public ctx: Context,
    public plan: OperationPlan,
    public args: unknown,
  ) {
    ctx.opId = `op_${now()
      .replace(/[-:]/g, '')
      .replace(/\.\d+Z$/, 'Z')}_${randomBytes(2).toString('hex')}`;
    this.file = ctx.p('state', 'ops', `${ctx.opId}.json`);
    this.journal = {
      id: ctx.opId,
      command: plan.command,
      args,
      plan,
      started_at: now(),
      steps: [],
      events: [],
      warnings: ctx.warnings,
      snapshots: [],
      result: null,
    };
  }
  async save() {
    await writeJson(this.file, this.ctx.secrets.redact(this.journal), 0o600);
  }
  async log(event: string, details: unknown) {
    this.journal.events.push({ at: now(), event, details });
    await this.save();
    await fs.mkdir(this.ctx.p('logs'), { recursive: true, mode: 0o700 });
    await fs.appendFile(
      this.ctx.p('logs', 'omactl.jsonl'),
      JSON.stringify(this.ctx.secrets.redact({ at: now(), op_id: this.ctx.opId, event, details })) +
        '\n',
      { mode: 0o600 },
    );
  }
  async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const step: any = { name, status: 'running', started_at: now() };
    this.journal.steps.push(step);
    await this.save();
    try {
      const value = await fn();
      step.status = 'success';
      return value;
    } catch (e) {
      step.status = 'failed';
      step.error = asError(e).message;
      throw e;
    } finally {
      step.finished_at = now();
      await this.save();
    }
  }
  async snapshot(id: string) {
    this.journal.snapshots.push(id);
    await this.save();
  }
}
export async function mutate<T>(
  ctx: Context,
  plan: OperationPlan,
  args: unknown,
  fn: (op: Operation) => Promise<T>,
): Promise<T | OperationPlan> {
  if (ctx.opts.plan) return plan;
  if (plan.confirmation && ctx.opts.confirm !== plan.confirmation)
    throw new OmaError(
      'CONFIRMATION_REQUIRED',
      `Requires --confirm ${plan.confirmation}`,
      8,
      `Review with --plan, then pass --confirm ${plan.confirmation}`,
      { plan },
    );
  const op = new Operation(ctx, plan, args);
  const release = await acquireLock(
    ctx.home,
    { pid: process.pid, opId: ctx.opId!, command: plan.command, started_at: now() },
    Number(ctx.opts.lockTimeout ?? 120) * 1000,
    (owner) => {
      ctx.warn('STALE_LOCK', `Took over lock from dead pid ${owner.pid}`);
    },
  );
  try {
    await ctx.loadSecrets();
    await op.save();
    await op.log('started', { command: plan.command, args, warnings: ctx.warnings });
    const result = await fn(op);
    op.journal.result = { ok: true, data: result };
    await commit(
      ctx,
      ctx.secrets.redact(
        `${plan.command} ${JSON.stringify(ctx.secrets.redact(args))} [${ctx.opId}]`,
      ),
    );
    return result;
  } catch (error) {
    const e = asError(error);
    op.journal.result = {
      ok: false,
      code: e.code,
      exit_code: e.exitCode,
      message: e.message,
      details: e.details,
    };
    await commit(ctx, `${plan.command} failed [${ctx.opId}]`).catch(() => {});
    throw e;
  } finally {
    try {
      op.journal.finished_at = now();
      await op.save();
      await op.log('finished', op.journal.result);
    } finally {
      await release();
    }
  }
}
export const planFor = (
  command: string,
  targets: string[],
  steps: string[],
  confirmation: string | null = null,
): OperationPlan => ({ command, targets, steps, destructive: confirmation !== null, confirmation });
