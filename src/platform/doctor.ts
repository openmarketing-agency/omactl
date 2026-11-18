import net from 'node:net';
import { Context } from '../core/context';
import { docker, MINIMUM, parseDockerJson } from '../docker';
import { capacity } from '../docker/probes';
import { compareVersions } from '../catalog';
import { fs, path, exists } from '../core/fs';
import { supportTier, platformId, isWsl, systemdAvailable } from './index';
export type DoctorCheck = {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
  hint?: string;
};
export async function probePort(port: number) {
  return new Promise<'ok' | 'warn' | 'fail'>((resolve) => {
    const s = net.createServer();
    s.once('error', (e: NodeJS.ErrnoException) =>
      resolve(e.code === 'EADDRINUSE' ? 'fail' : 'warn'),
    );
    s.listen(port, () => s.close(() => resolve('ok')));
  });
}
export async function doctor(
  ctx: Context,
  ports?: { http_port: number; https_port: number; tls: string },
  scheduling = false,
) {
  const checks: DoctorCheck[] = [];
  const add = (name: string, status: DoctorCheck['status'], message: string, hint?: string) =>
    checks.push({ name, status, message, ...(hint ? { hint } : {}) });
  let info: any = null,
    rootless = false;
  try {
    const version = JSON.parse(
      (await docker(ctx, ['version', '--format', 'json'], { timeout: 10000 })).stdout,
    );
    add(
      'docker',
      compareVersions(version.Server.Version, MINIMUM.engine) >= 0 ? 'ok' : 'fail',
      `Docker Engine ${version.Server.Version}`,
      'Use Engine ' + MINIMUM.engine + ' or later',
    );
    const compose = JSON.parse(
      (await docker(ctx, ['compose', 'version', '--format', 'json'], { timeout: 10000 })).stdout,
    );
    add(
      'compose',
      compareVersions(compose.version, MINIMUM.compose) >= 0 ? 'ok' : 'fail',
      `Compose ${compose.version}`,
      'Use Compose ' + MINIMUM.compose + ' or later',
    );
    info = JSON.parse((await docker(ctx, ['info', '--format', 'json'], { timeout: 10000 })).stdout);
    rootless = info.SecurityOptions?.some((v: string) => v.includes('rootless')) ?? false;
    add('context', 'ok', version.Client.Context ?? 'default');
    if (/podman/i.test(JSON.stringify(info))) rootless = true;
  } catch (e) {
    add(
      'docker',
      'fail',
      e instanceof Error ? e.message : String(e),
      'Install Docker, start its daemon, and grant this user access',
    );
  }
  const tier = await supportTier(rootless);
  add('platform', tier === 'unverified' ? 'warn' : 'ok', `${platformId()}; support tier ${tier}`);
  let probe = ctx.home;
  while (!(await exists(probe)) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  try {
    const disk = await fs.statfs(probe);
    const gb = (disk.bavail * disk.bsize) / 1e9;
    add(
      'home_disk',
      gb < 1 ? 'fail' : gb < 5 ? 'warn' : 'ok',
      `${gb.toFixed(1)} GB free on OMA_HOME filesystem`,
      'Free at least 5 GB',
    );
  } catch {
    add('home_disk', 'warn', 'Unable to measure OMA_HOME free disk');
  }
  if (info) {
    const limits = await capacity(ctx);
    if (limits) {
      const gb = limits.disk_mb / 1000;
      add(
        'docker_disk',
        gb < 1 ? 'fail' : gb < 5 ? 'warn' : 'ok',
        `${gb.toFixed(1)} GB free in Docker data filesystem`,
        'Free Docker disk space',
      );
    } else
      add(
        'docker_disk',
        'warn',
        'Free Docker disk probe unavailable until the pinned helper image is installed',
      );
    const required = (await ctx.apps()).reduce((s, a) => s + a.manifest.resources.memory_mb, 0);
    const available = limits?.memory_mb ?? info.MemTotal / 1048576;
    add(
      'memory',
      available < required ? 'fail' : 'ok',
      `${available.toFixed(0)} MB available Docker memory; ${required} MB declared by installed apps`,
      'Increase Docker memory',
    );
    const config = await ctx.config().catch(() => null);
    const ingress = ports ?? config?.ingress ?? { http_port: 80, https_port: 443, tls: 'off' };
    const own =
      parseDockerJson(
        (await docker(ctx, ['ps', '--filter', 'label=oma.app=traefik', '--format', 'json'])).stdout,
      ).length > 0;
    for (const port of [ingress.http_port, ...(ingress.tls === 'acme' ? [ingress.https_port] : [])])
      add(
        `port_${port}`,
        own ? 'ok' : await probePort(port),
        `Ingress port ${port} ${own ? 'owned by Traefik' : 'checked'}`,
        'Choose a free port with init --http-port / --https-port',
      );
    if (config) {
      const network = await docker(ctx, ['network', 'inspect', 'oma_edge', '--format', 'json'], {
        allowFailure: true,
      });
      add(
        'network',
        network.exitCode === 0 ? 'ok' : 'fail',
        'oma_edge network',
        'Run omactl init on a fresh instance or recreate oma_edge',
      );
    }
    if (config?.backup.repository) {
      try {
        const { restic } = await import('../backup');
        await restic(ctx, ['snapshots', '--json'], [], { timeout: 15000 });
        add('backup', 'ok', 'Backup repository reachable and initialized');
      } catch (e) {
        add('backup', 'fail', String(e), 'Check backup credentials and repository connectivity');
      }
    }
  }
  if (await isWsl()) {
    if (ctx.home.startsWith('/mnt/'))
      add(
        'wsl_home',
        'warn',
        'OMA_HOME is on a Windows mounted filesystem',
        'Move it into the WSL2 Linux filesystem',
      );
    if (scheduling && !(await systemdAvailable()))
      add(
        'wsl_systemd',
        'fail',
        'systemd is disabled',
        'Enable systemd in /etc/wsl.conf and restart WSL2',
      );
  }
  const release =
    (await ctx.config().catch(() => null))?.release_url ?? 'https://releases.openmarketing.agency';
  try {
    const response = await fetch(release, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
    const date = response.headers.get('date');
    if (date) {
      const skew = Math.abs(Date.parse(date) - Date.now());
      add(
        'clock',
        skew > 120000 ? 'fail' : 'ok',
        `Clock skew ${Math.round(skew / 1000)} seconds`,
        'Synchronize the system clock',
      );
    } else add('clock', 'warn', 'Release server returned no Date header');
  } catch {
    add('clock', 'warn', 'Release server unavailable for clock probe');
  }
  return { support_tier: tier, checks };
}
