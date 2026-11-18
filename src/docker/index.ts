import { exists, path } from '../core/fs';
import { Context } from '../core/context';
import { OmaError } from '../core/errors';
export const MINIMUM = { engine: '24.0.0', compose: '2.24.0' };
export type ProcessResult = { stdout: string; stderr: string; exitCode: number };
export async function docker(
  ctx: Context,
  args: string[],
  options: {
    cwd?: string;
    input?: string | Uint8Array;
    timeout?: number;
    allowFailure?: boolean;
  } = {},
): Promise<ProcessResult> {
  if (
    ['run', 'create'].includes(args[0]) &&
    !(args.includes('--pull') && args[args.indexOf('--pull') + 1] === 'never')
  ) {
    const image = args.find((arg) => /@sha256:[a-f0-9]{64}$/.test(arg));
    if (image) await ensureImage(ctx, image);
  }
  const started = Date.now();
  let child;
  try {
    child = Bun.spawn(['docker', ...args], {
      cwd: options.cwd,
      stdin: options.input !== undefined ? 'pipe' : 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: options.timeout ?? ctx.timeout,
    });
  } catch {
    throw new OmaError(
      'DOCKER_UNAVAILABLE',
      'Docker CLI is not available',
      3,
      'Install Docker with Compose v2 and enable daemon access',
    );
  }
  const feed =
    options.input !== undefined
      ? (async () => {
          try {
            child.stdin!.write(options.input!);
            await child.stdin!.end();
          } catch {}
        })()
      : Promise.resolve();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
    feed,
  ]).then((v) => [v[0], v[1], v[2]] as const);
  if (ctx.opts.verbose && !ctx.opts.quiet)
    process.stderr.write(
      `[docker ${args.slice(0, 3).join(' ')}] exit ${exitCode} in ${Date.now() - started}ms\n`,
    );
  if (exitCode !== 0 && !options.allowFailure)
    throw new OmaError(
      'DOCKER_FAILED',
      `docker ${args.slice(0, 3).join(' ')} failed: ${ctx.secrets.redact(stderr || stdout)}`,
      1,
      undefined,
      { exit_code: exitCode, timed_out: child.signalCode === 'SIGKILL' },
    );
  return { stdout, stderr, exitCode };
}
const availableImages = new Set<string>();
async function ensureImage(ctx: Context, image: string) {
  if (availableImages.has(image)) return;
  const inspected = await docker(ctx, ['image', 'inspect', image, '--format', 'json'], {
    allowFailure: true,
  });
  if (inspected.exitCode !== 0) {
    for (let attempt = 0; ; attempt++) {
      try {
        await docker(ctx, ['pull', image]);
        break;
      } catch (error) {
        if (attempt === 2) throw error;
        await Bun.sleep(250 * 2 ** attempt);
      }
    }
  }
  availableImages.add(image);
}
export async function composeArgs(ctx: Context, app: string, override = true) {
  const cwd = ctx.appDir(app);
  const args = [
    'compose',
    '-p',
    `oma-${app}`,
    '--env-file',
    '.env',
    '-f',
    'compose.yml',
    '-f',
    'compose.generated.yml',
  ];
  if (override && (await exists(path.join(cwd, 'compose.override.yml'))))
    args.push('-f', 'compose.override.yml');
  return args;
}
export async function compose(
  ctx: Context,
  app: string,
  args: string[],
  options: Parameters<typeof docker>[2] & { override?: boolean } = {},
) {
  return docker(ctx, [...(await composeArgs(ctx, app, options.override)), ...args], {
    ...options,
    cwd: ctx.appDir(app),
  });
}
export async function pull(ctx: Context, app: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await compose(ctx, app, ['pull', '--policy', 'missing']);
    } catch (error) {
      if (attempt === 2) throw error;
      await Bun.sleep(250 * 2 ** attempt);
    }
  }
}
export async function up(ctx: Context, app: string, services: string[] = []) {
  const installed = await ctx.app(app);
  return compose(
    ctx,
    app,
    ['up', '-d', '--wait', '--wait-timeout', String(installed.manifest.ready_timeout), ...services],
    { timeout: Math.max(ctx.timeout, (installed.manifest.ready_timeout + 15) * 1000) },
  );
}
export function parseDockerJson(text: string): any[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const data = JSON.parse(trimmed);
    return Array.isArray(data) ? data : [data];
  } catch {
    return trimmed
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}
export async function containers(ctx: Context, app: string) {
  return parseDockerJson((await compose(ctx, app, ['ps', '--all', '--format', 'json'])).stdout);
}
export async function ensureVolume(ctx: Context, name: string) {
  await docker(ctx, ['volume', 'create', '--label', 'oma.managed=true', name]);
}

export async function followLogs(ctx: Context, app: string, args: string[]) {
  const child = Bun.spawn(
    ['docker', ...(await composeArgs(ctx, app)), 'logs', '--follow', ...args],
    { cwd: ctx.appDir(app), stdout: 'pipe', stderr: 'pipe', timeout: ctx.timeout },
  );
  const stop = () => child.kill();
  process.once('SIGINT', stop);
  const stream = async (input: ReadableStream<Uint8Array>, output: NodeJS.WriteStream) => {
    let carry = '';
    const decoder = new TextDecoder();
    for await (const chunk of input) {
      carry += decoder.decode(chunk, { stream: true });
      const lines = carry.split('\n');
      carry = lines.pop()!;
      for (const line of lines) output.write(ctx.secrets.redact(line) + '\n');
    }
    carry += decoder.decode();
    if (carry) output.write(ctx.secrets.redact(carry));
  };
  try {
    await Promise.all([
      stream(child.stdout, process.stdout),
      stream(child.stderr, process.stderr),
      child.exited,
    ]);
  } finally {
    process.removeListener('SIGINT', stop);
  }
}
