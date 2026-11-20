import { publishGithub } from './github-release';
import { sign, createPublicKey, verify } from 'node:crypto';
import { fs, path, hash, write } from '../src/core/fs';
import { archiveDir } from '../src/core/tar';
import { VERSION } from '../src/core/version';
import { targets } from './build';
import { archiveLinuxPackage } from './package-linux';
const key = process.env.OMA_RELEASE_PRIVATE_KEY;
if (!key) throw new Error('OMA_RELEASE_PRIVATE_KEY (PEM Ed25519) is required');
const trusted: string[] = JSON.parse(process.env.OMA_RELEASE_PUBLIC_KEYS ?? '[]');
const probe = Buffer.from('omactl-release-key-check'),
  signature = sign(null, probe, key);
if (
  !trusted.some((pem) => {
    try {
      return verify(null, probe, createPublicKey(pem), signature);
    } catch {
      return false;
    }
  })
)
  throw new Error('Release signing key must match a compiled OMA_RELEASE_PUBLIC_KEYS entry');
const base = process.env.OMA_RELEASE_ASSET_URL;
if (!base) throw new Error('OMA_RELEASE_ASSET_URL is required');
const channel = process.env.OMA_RELEASE_CHANNEL ?? 'stable',
  metadata = await Bun.file('catalog/catalog.json').json();
const assets: Record<string, { url: string; sha256: string }> = {};
const sums = [];
for (const target of targets) {
  const platform = target.slice(4),
    name = `omactl-${platform}`,
    bytes = await fs.readFile(path.join('dist', name));
  assets[platform] = { url: `${base}/${name}`, sha256: hash(bytes) };
  sums.push(`${hash(bytes)}  ${name}`);
}
const catalogName = `catalog-${metadata.version}.tar.gz`,
  catalog = await archiveDir('catalog');
await write(path.join('dist', catalogName), catalog);
sums.push(`${hash(catalog)}  ${catalogName}`);
const linuxPackage = await archiveLinuxPackage();
sums.push(linuxPackage.checksum);
const release = {
  channel,
  published_at: new Date().toISOString(),
  omactl: { version: process.env.OMA_BUILD_VERSION ?? VERSION, assets },
  catalog: { version: metadata.version, url: `${base}/${catalogName}`, sha256: hash(catalog) },
};
const bytes = Buffer.from(JSON.stringify(release, null, 2) + '\n');
await write(`dist/${channel}.json`, bytes);
await write(`dist/${channel}.json.sig`, sign(null, bytes, key).toString('base64') + '\n');
await write('dist/SHA256SUMS', sums.join('\n') + '\n');
// Publish assets before moving the signed channel on the release host.
const releaseFiles = [
  ...Object.keys(assets).map((p) => 'omactl-' + p),
  catalogName,
  linuxPackage.name,
  `${channel}.json`,
  `${channel}.json.sig`,
  'SHA256SUMS',
];
if (process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY)
  await publishGithub(
    process.env.GITHUB_REPOSITORY,
    process.env.GITHUB_TOKEN,
    process.env.GITHUB_REF_NAME ?? `v${release.omactl.version}`,
    releaseFiles.map((name) => path.join('dist', name)),
  );
if (process.env.OMA_RELEASE_UPLOAD_URL) {
  for (const name of releaseFiles) {
    const res = await fetch(
      `${process.env.OMA_RELEASE_UPLOAD_URL}/${name === channel + '.json' || name === channel + '.json.sig' ? 'channels/' : ''}${name}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${process.env.OMA_RELEASE_UPLOAD_TOKEN ?? ''}` },
        body: await fs.readFile(path.join('dist', name)),
      },
    );
    if (!res.ok) throw new Error(`Upload ${name}: ${res.status}`);
  }
}
if (process.env.OMA_RELEASE_UPLOAD_URL) {
  for (const version of new Set([release.catalog.version, release.omactl.version]))
    for (const [suffix, body] of [
      ['.json', bytes],
      ['.json.sig', Buffer.from(sign(null, bytes, key).toString('base64') + '\n')],
    ] as const) {
      const res = await fetch(
        `${process.env.OMA_RELEASE_UPLOAD_URL}/versions/${version}${suffix}`,
        {
          method: 'PUT',
          headers: { Authorization: `Bearer ${process.env.OMA_RELEASE_UPLOAD_TOKEN ?? ''}` },
          body,
        },
      );
      if (!res.ok) throw new Error(`Upload version ${version}: ${res.status}`);
    }
}
console.log(`Signed release artifacts written to dist/ for ${channel}.`);
