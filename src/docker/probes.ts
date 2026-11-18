import type { Context } from '../core/context';
import { docker } from './index';
import { HELPER_IMAGE } from './images';
export async function capacity(ctx: Context, allowPull = false) {
  const r = await docker(
    ctx,
    [
      'run',
      '--pull',
      allowPull ? 'missing' : 'never',
      '--rm',
      '--read-only',
      '--network',
      'none',
      HELPER_IMAGE,
      'sh',
      '-c',
      `set -- $(df -Pk / | tail -1); disk=$4; memory=$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo); printf '{"disk_mb":%s,"memory_mb":%s}' "$((disk / 1024))" "$((memory / 1024))"`,
    ],
    { allowFailure: true, timeout: 30000 },
  );
  return r.exitCode === 0 ? (JSON.parse(r.stdout) as { disk_mb: number; memory_mb: number }) : null;
}
