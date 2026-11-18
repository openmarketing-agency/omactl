import { path } from '../src/core/fs';
const debian =
  'debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc';
const alpine =
  'oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a';
for (const arch of ['arm64', 'x64'])
  for (const musl of [false, true]) {
    const target = `linux-${arch}${musl ? '-musl' : ''}`;
    const child = Bun.spawn(
      [
        'docker',
        'run',
        '--rm',
        '--platform',
        `linux/${arch === 'x64' ? 'amd64' : 'arm64'}`,
        '--mount',
        `type=bind,source=${path.resolve('dist')},target=/binaries,readonly`,
        musl ? alpine : debian,
        `/binaries/omactl-${target}`,
        'version',
        '--json',
      ],
      { stdout: 'pipe', stderr: 'pipe', timeout: 180000 },
    );
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (status !== 0) throw new Error(`${target}: ${stderr}`);
    const result = JSON.parse(stdout);
    if (!result.ok || result.data.platform !== `linux-${arch}`)
      throw new Error(`${target}: ${stdout}`);
    console.log(`${target}: version smoke test passed`);
  }
