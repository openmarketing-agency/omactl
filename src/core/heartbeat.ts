import { Context } from './context';
import { fs } from './fs';
import { VERSION } from './version';
import { supportTier } from '../platform';
import { doctor } from '../platform/doctor';
export async function heartbeat(ctx: Context) {
  const config = await ctx.config();
  if (!config.heartbeat.url) return { sent: false, enabled: false };
  const token = (
    await fs.readFile(ctx.p('secrets', 'heartbeat-token'), 'utf8').catch(() => '')
  ).trim();
  ctx.secrets.add(token);
  const payload = {
    instance_id: config.instance_id,
    omactl: VERSION,
    catalog: (await ctx.catalogLock()).version,
    support_tier: await supportTier(),
    doctor: await doctor(ctx),
    apps: (await ctx.apps()).map((a) => ({
      id: a.id,
      version: a.version,
      desired_state: a.desired_state,
      last_verify: a.last_verify,
      last_backup: a.last_backup?.at ?? null,
    })),
  };
  try {
    const result = await fetch(config.heartbeat.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    if (!result.ok) throw new Error(`HTTP ${result.status}`);
    return { sent: true, enabled: true };
  } catch (e) {
    ctx.warn('HEARTBEAT_FAILED', `Heartbeat failed: ${e}`);
    return { sent: false, enabled: true };
  }
}
