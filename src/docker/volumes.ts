import { Context } from '../core/context';
import { docker, ensureVolume } from './index';
import { HELPER_IMAGE } from './images';
import { tar } from '../core/tar';
export async function writeVolume(
  ctx: Context,
  volume: string,
  files: Record<string, string | Uint8Array>,
  clear = false,
) {
  await ensureVolume(ctx, volume);
  await docker(
    ctx,
    [
      'run',
      '--rm',
      '-i',
      '--network',
      'none',
      '-v',
      `${volume}:/target`,
      HELPER_IMAGE,
      'sh',
      '-c',
      `${clear ? 'find /target -mindepth 1 -maxdepth 1 -exec rm -rf {} +; ' : ''}tar -xf - -C /target`,
    ],
    { input: tar(files, 0o644) },
  );
}

export async function syncRouteVolume(ctx: Context, files: Record<string, string>) {
  await ensureVolume(ctx, 'oma_traefik_dynamic');
  await docker(
    ctx,
    [
      'run',
      '--rm',
      '-i',
      '--network',
      'none',
      '-v',
      'oma_traefik_dynamic:/target',
      HELPER_IMAGE,
      'sh',
      '-c',
      'mkdir -p /tmp/routes; tar -xf - -C /tmp/routes; for f in /tmp/routes/*.yml; do [ -f "$f" ] || continue; name=${f##*/}; cp "$f" "/target/$name.tmp"; mv "/target/$name.tmp" "/target/$name"; done; for f in /target/*.yml; do [ -f "$f" ] || continue; name=${f##*/}; [ -f "/tmp/routes/$name" ] || rm "$f"; done; true',
    ],
    { input: tar(files, 0o644) },
  );
}
