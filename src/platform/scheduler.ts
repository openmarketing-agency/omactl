import { createHash } from 'node:crypto';
import { Context } from '../core/context';
import { fs, path, write, exists } from '../core/fs';
import { schedulerDir, osKind, rootUser, binaryPath, isWsl, systemdAvailable } from './index';
import { OmaError, assert } from '../core/errors';
export const JOBS = ['boot-repair', 'nightly-backup', 'update-check', 'verify'] as const;
export function nightlyMinute(instance: string, window: string) {
  const [a, b] = window.split('-').map((t) => {
    const [h, m] = t.split(':').map(Number);
    assert(h < 24 && m < 60, 'INVALID_WINDOW', 'Invalid nightly backup window', 2);
    return h * 60 + m;
  });
  const duration = (b - a + 1440) % 1440;
  assert(duration > 0, 'INVALID_WINDOW', 'Nightly window must have a nonzero duration', 2);
  return (a + (createHash('sha256').update(instance).digest().readUInt32BE(0) % duration)) % 1440;
}
const xml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unitArg = (s: string) =>
  '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%') + '"';
export function systemdUnits(
  job: string,
  home: string,
  minute: number,
  binary: string,
  env: Record<string, string> = {},
) {
  const args = [binary, '--home', home, '--json', 'scheduled', job].map(unitArg).join(' ');
  const service = `[Unit]\nDescription=OMA ${job}\nAfter=docker.service\n\n[Service]\nType=oneshot\nExecStart=${args}\n${Object.entries(
    env,
  )
    .map(([k, v]) => `Environment=${unitArg(k + '=' + v)}\n`)
    .join('')}TimeoutStartSec=3600\n`;
  const calendar =
    job === 'nightly-backup'
      ? `*-*-* ${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00`
      : job === 'update-check'
        ? '*-*-* 00/6:00:00'
        : 'hourly';
  const timer = `[Unit]\nDescription=OMA ${job}\n\n[Timer]\n${job === 'boot-repair' ? 'OnBootSec=2min' : `OnCalendar=${calendar}\nPersistent=true`}\nUnit=oma-${job}.service\n\n[Install]\nWantedBy=timers.target\n`;
  return { service, timer };
}
export function launchPlist(
  job: string,
  home: string,
  minute: number,
  binary: string,
  env: Record<string, string> = {},
) {
  const args = [binary, '--home', home, '--json', 'scheduled', job];
  const schedule =
    job === 'boot-repair'
      ? '<key>RunAtLoad</key><true/>'
      : job === 'nightly-backup'
        ? `<key>StartCalendarInterval</key><dict><key>Hour</key><integer>${Math.floor(minute / 60)}</integer><key>Minute</key><integer>${minute % 60}</integer></dict>`
        : `<key>StartInterval</key><integer>${job === 'verify' ? 3600 : 21600}</integer>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>agency.openmarketing.omactl.${job}</string><key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join('')}</array>${schedule}<key>EnvironmentVariables</key><dict>${Object.entries(
    env,
  )
    .map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`)
    .join(
      '',
    )}</dict><key>StandardOutPath</key><string>${xml(path.join(home, 'logs', job + '.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(home, 'logs', job + '.log'))}</string></dict></plist>\n`;
}
async function controller(args: string[], allowFailure = false): Promise<boolean> {
  const command = osKind() === 'darwin' ? 'launchctl' : 'systemctl';
  try {
    const child = Bun.spawn([command, ...args], { stdout: 'pipe', stderr: 'pipe', timeout: 30000 });
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (exit !== 0 && !allowFailure)
      throw new OmaError('SCHEDULER_FAILED', `${command}: ${stderr}`, 3);
    return exit === 0;
  } catch (e) {
    if (allowFailure) return false;
    throw e;
  }
}
export type SchedulerRuntime = {
  kind: string;
  dir: string;
  binary: string;
  root: boolean;
  uid: number;
  wsl: boolean;
  systemd: boolean;
  run: (args: string[], allowFailure?: boolean) => Promise<boolean>;
};
export async function schedule(
  ctx: Context,
  command: 'install' | 'remove' | 'status',
  overrides: Partial<SchedulerRuntime> = {},
) {
  const runtime: SchedulerRuntime = {
    kind: osKind(),
    dir: schedulerDir(),
    binary: binaryPath(),
    root: rootUser(),
    uid: process.getuid?.() ?? 0,
    wsl: await isWsl(),
    systemd: await systemdAvailable(),
    run: controller,
    ...overrides,
  };
  assert(
    ['linux', 'darwin'].includes(runtime.kind),
    'UNSUPPORTED_PLATFORM',
    'Scheduling requires Linux, WSL2 or macOS',
    3,
  );
  const config = await ctx.config(),
    dir = runtime.dir,
    minute = nightlyMinute(config.instance_id, config.backup.nightly_window),
    mac = runtime.kind === 'darwin';
  const jobs = JOBS.map((job) => ({
    job,
    files: mac
      ? [path.join(dir, `agency.openmarketing.omactl.${job}.plist`)]
      : [path.join(dir, `oma-${job}.service`), path.join(dir, `oma-${job}.timer`)],
  }));
  const flags = runtime.root ? [] : ['--user'];
  const domain = `gui/${runtime.uid}`;
  if (command === 'status')
    return {
      jobs: await Promise.all(
        jobs.map(async (j) => ({
          ...j,
          installed: (await Promise.all(j.files.map(exists))).every(Boolean),
          active: await runtime.run(
            mac
              ? ['print', `${domain}/agency.openmarketing.omactl.${j.job}`]
              : [...flags, 'is-active', `oma-${j.job}.timer`],
            true,
          ),
        })),
      ),
    };
  assert(
    !/^(bun|node)(?:\.exe)?$/.test(path.basename(runtime.binary)),
    'COMPILED_BINARY_REQUIRED',
    'Install schedules using a compiled omactl binary',
  );
  if (runtime.wsl)
    assert(runtime.systemd, 'SYSTEMD_DISABLED', 'Enable systemd before installing schedules');
  const env: Record<string, string> = { PATH: process.env.PATH ?? '' };
  for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG'])
    if (process.env[key]) env[key] = process.env[key]!;
  await fs.mkdir(ctx.p('logs'), { recursive: true, mode: 0o700 });
  for (const { job, files } of jobs) {
    if (command === 'install') {
      if (mac) await write(files[0], launchPlist(job, ctx.home, minute, runtime.binary, env));
      else {
        const units = systemdUnits(job, ctx.home, minute, runtime.binary, env);
        await write(
          files[0],
          runtime.root
            ? units.service.replace(
                'After=docker.service',
                'After=docker.service\nWants=docker.service',
              )
            : units.service,
        );
        await write(files[1], units.timer);
      }
    }
    if (mac) {
      const loaded = await runtime.run(
        ['print', `${domain}/agency.openmarketing.omactl.${job}`],
        true,
      );
      if (loaded) await runtime.run(['bootout', domain, files[0]]);
      if (command === 'install') await runtime.run(['bootstrap', domain, files[0]]);
    } else if (command === 'install') {
      await runtime.run([...flags, 'daemon-reload']);
      await runtime.run([...flags, 'enable', '--now', `oma-${job}.timer`]);
    } else if (await exists(files[1]))
      await runtime.run([...flags, 'disable', '--now', `oma-${job}.timer`]);
    if (command === 'remove') for (const file of files) await fs.rm(file, { force: true });
  }
  if (!mac) {
    await runtime.run([...flags, 'daemon-reload']);
    if (!runtime.root)
      ctx.warn(
        'LINGERING_REQUIRED',
        'User timers need lingering: ask an administrator to run loginctl enable-linger for this user',
      );
  }
  return { jobs: jobs.map((j) => ({ ...j, installed: command === 'install' })) };
}
