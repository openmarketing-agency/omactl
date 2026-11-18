import { parse } from 'yaml';
import { Manifest, AppId, type AppManifest } from '../schemas';
import { Context } from '../core/context';
import { fs, path, exists, hash, walk, safePath, json } from '../core/fs';
import { OmaError, assert } from '../core/errors';
export async function appPath(root: string, id: string) {
  AppId.parse(id);
  for (const category of ['system', 'apps']) {
    const dir = path.join(root, category, id);
    if (await exists(path.join(dir, 'manifest.yml'))) return dir;
  }
  throw new OmaError('CATALOG_APP_NOT_FOUND', `App ${id} not in catalog`, 9);
}
export async function loadManifest(root: string, id: string) {
  return Manifest.parse(
    parse(await fs.readFile(path.join(await appPath(root, id), 'manifest.yml'), 'utf8')),
  );
}
export async function listManifests(root: string) {
  const list: AppManifest[] = [];
  for (const category of ['system', 'apps'])
    for (const id of await fs.readdir(path.join(root, category)).catch(() => []))
      list.push(await loadManifest(root, id));
  return list.sort((a, b) => a.id.localeCompare(b.id));
}
export async function fingerprint(root: string, id: string) {
  const dir = await appPath(root, id);
  const data = [];
  for (const name of (await walk(dir)).sort())
    data.push([name, (await fs.readFile(path.join(dir, name))).toString('base64')]);
  return hash(JSON.stringify(data));
}
export async function catalogMetadata(root: string) {
  const meta = await json(root + path.sep + 'catalog.json');
  assert(
    typeof meta.version === 'string' && typeof meta.min_omactl === 'string',
    'INVALID_CATALOG',
    'Invalid catalog.json',
  );
  return meta as { version: string; min_omactl: string };
}
export function compareVersions(a: string, b: string) {
  const aa = a
      .replace(/^v/, '')
      .split(/[.-]/)
      .map((v) => (/^\d+$/.test(v) ? Number(v) : v)),
    bb = b
      .replace(/^v/, '')
      .split(/[.-]/)
      .map((v) => (/^\d+$/.test(v) ? Number(v) : v));
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const x = aa[i] ?? 0,
      y = bb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}
export async function resolveOrder(
  ctx: Context,
  targets: string[],
  selections: Record<string, string> = {},
) {
  const root = ctx.p('catalog'),
    installed = await ctx.apps(),
    order: AppManifest[] = [],
    visiting = new Set<string>(),
    done = new Set<string>();
  async function visit(id: string) {
    if (done.has(id)) return;
    if (visiting.has(id)) throw new OmaError('DEPENDENCY_CYCLE', `Dependency cycle at ${id}`, 3);
    visiting.add(id);
    const m = await loadManifest(root, id);
    for (const required of m.requires) await visit(required);
    for (const consume of m.consumes) {
      if (!consume.required && !selections[consume.capability]) continue;
      const providers = [...installed.map((a) => a.manifest), ...order].filter(
        (p) => p.id !== id && p.provides.some((v) => v.capability === consume.capability),
      );
      const unique = [...new Set(providers.map((p) => p.id))];
      const selected = selections[consume.capability];
      if (!selected && unique.length > 1)
        throw new OmaError(
          'AMBIGUOUS_PROVIDER',
          `Several apps provide ${consume.capability}`,
          3,
          `Pass --link ${consume.capability}=<appId>`,
        );
      const provider = selected ?? unique[0] ?? consume.default_provider;
      if (!provider)
        throw new OmaError('MISSING_PROVIDER', `No provider for ${consume.capability}`, 3);
      const pm = await loadManifest(root, provider);
      assert(
        pm.provides.some((p) => p.capability === consume.capability),
        'INVALID_PROVIDER',
        `${provider} does not provide ${consume.capability}`,
      );
      await visit(provider);
    }
    visiting.delete(id);
    done.add(id);
    order.push(m);
  }
  for (const id of targets) await visit(id);
  return order;
}
