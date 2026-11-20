import { tmpdir } from 'node:os';
import { fs, path, hash, write } from '../src/core/fs';
import { VERSION } from '../src/core/version';
import { publishGithub } from './github-release';

export async function archiveLinuxPackage() {
  const name = 'omactl-linux-x64.tar.gz';
  const archivePath = path.resolve('dist', name);
  const staging = await fs.mkdtemp(path.join(tmpdir(), 'omactl-package-'));
  try {
    const bin = path.join(staging, 'bin');
    await fs.mkdir(bin);
    await fs.copyFile('dist/omactl-linux-x64', path.join(bin, 'omactl'));
    await fs.chmod(path.join(bin, 'omactl'), 0o755);
    const archive = Bun.spawn(
      [
        'tar',
        '-czf',
        archivePath,
        '--sort=name',
        '--mtime=@0',
        '--owner=0',
        '--group=0',
        '-C',
        staging,
        'bin/omactl',
        '-C',
        process.cwd(),
        'catalog',
        'LICENSE',
      ],
      { stderr: 'inherit' },
    );
    if ((await archive.exited) !== 0) throw new Error(`Could not create ${name}`);
    return { name, checksum: `${hash(await fs.readFile(archivePath))}  ${name}` };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const linuxPackage = await archiveLinuxPackage();
  await write('dist/SHA256SUMS', linuxPackage.checksum + '\n');
  const { GITHUB_REPOSITORY, GITHUB_TOKEN, GITHUB_REF_NAME, OMA_BUILD_VERSION } = process.env;
  if (GITHUB_REPOSITORY && GITHUB_TOKEN)
    await publishGithub(
      GITHUB_REPOSITORY,
      GITHUB_TOKEN,
      GITHUB_REF_NAME ?? `v${OMA_BUILD_VERSION ?? VERSION}`,
      [`dist/${linuxPackage.name}`, 'dist/SHA256SUMS'],
    );
  console.log(`Linux release package written to dist/${linuxPackage.name}.`);
}
