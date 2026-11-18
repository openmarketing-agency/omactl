import { parse } from 'yaml';
import { Context } from '../core/context';
import { fs, path, safePath, walk } from '../core/fs';
import { listManifests, appPath, catalogMetadata, loadManifest } from './index';
import { templateVariables } from './templates';
import { docker } from '../docker';
import { HELPER_IMAGE } from '../docker/images';
import { tar } from '../core/tar';
export async function registryPlatforms(image: string): Promise<string[]> {
  const at = image.indexOf('@');
  const reference = image.slice(at + 1);
  let repo = image.slice(0, at).replace(/:[^/:]+$/, '');
  let registry = 'registry-1.docker.io';
  if (repo.split('/')[0].includes('.') || repo.split('/')[0].includes(':')) {
    registry = repo.split('/').shift()!;
    repo = repo.slice(registry.length + 1);
  } else if (!repo.includes('/')) repo = 'library/' + repo;
  const url = `https://${registry}/v2/${repo}/manifests/${reference}`;
  const headers: Record<string, string> = {
    Accept:
      'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json',
  };
  let res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  if (res.status === 401) {
    const challenge = res.headers.get('www-authenticate') ?? '';
    const parts = Object.fromEntries(
      [...challenge.matchAll(/(\w+)="([^"]+)"/g)].map((m) => [m[1], m[2]]),
    );
    const auth = new URL(parts.realm);
    auth.searchParams.set('service', parts.service);
    auth.searchParams.set('scope', parts.scope);
    const token: any = await fetch(auth, { signal: AbortSignal.timeout(20000) }).then((r) =>
      r.json(),
    );
    headers.Authorization = `Bearer ${token.token ?? token.access_token}`;
    res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  }
  if (!res.ok) throw new Error(`Registry returned ${res.status}`);
  const data: any = await res.json();
  return (data.manifests ?? []).map((m: any) => `${m.platform?.os}/${m.platform?.architecture}`);
}
export async function lintCatalog(ctx: Context, root: string, allowLocal = false) {
  const errors: string[] = [];
  let count = 0;
  const images = new Set<string>();
  try {
    await catalogMetadata(root);
  } catch (e) {
    errors.push(String(e));
  }
  for (const category of ['system', 'apps'])
    for (const id of await fs.readdir(path.join(root, category)).catch(() => [])) {
      try {
        const m = await loadManifest(root, id);
        count++;
        if (m.id !== id) throw new Error('Folder id does not match manifest id');
        const dir = await appPath(root, id);
        await walk(dir);
        const c: any = parse(await fs.readFile(path.join(dir, 'compose.yml'), 'utf8'));
        const volumes = c.volumes ?? {};
        if (!c.services?.[id]) errors.push(`${id}: main service missing`);
        for (const [key, v] of Object.entries<any>(volumes))
          if (!m.volumes.some((v) => v.key === key) || v?.name !== `oma_${id}_${key}`)
            errors.push(`${id}: undeclared or incorrectly named volume ${key}`);
        for (const v of m.volumes)
          if (!volumes[v.key]) errors.push(`${id}: missing compose volume ${v.key}`);
        for (const [name, s] of Object.entries<any>(c.services ?? {})) {
          if (
            s.network_mode === 'host' ||
            s.privileged ||
            s.devices ||
            s.pid === 'host' ||
            s.ipc === 'host' ||
            s.cap_add?.some((c: string) => c.toUpperCase() === 'ALL') ||
            s.container_name ||
            (s.ports && id !== 'traefik')
          )
            errors.push(`${id}/${name}: forbidden container privilege, ports or namespace`);
          for (const mount of s.volumes ?? []) {
            const source = typeof mount === 'string' ? mount.split(':')[0] : mount.source;
            if (
              (typeof mount === 'object' && mount.type === 'bind') ||
              !source ||
              !volumes[source] ||
              String(mount.target ?? mount).includes('docker.sock')
            )
              errors.push(`${id}/${name}: host or undeclared mount forbidden`);
          }
          if (!s.profiles?.includes('tools') && !s.healthcheck)
            errors.push(`${id}/${name}: healthcheck required`);
          if (s.image) {
            images.add(s.image);
            if (!allowLocal && !/:[^/@]+@sha256:[a-f0-9]{64}$/.test(s.image))
              errors.push(`${id}/${name}: image must have tag and digest`);
          } else errors.push(`${id}/${name}: image required`);
        }
        const templates = [
          ...m.env.map((e) => e.value ?? ''),
          ...m.routes.map((r) => r.host),
          ...m.provides.flatMap((p) => Object.values(p.outputs)),
        ];
        for (const file of m.config_files) {
          if (!m.volumes.some((v) => v.key === file.volume))
            errors.push(`${id}: config volume missing`);
          safePath(dir, file.template);
          safePath(dir, file.path);
          templates.push(await fs.readFile(safePath(dir, file.template), 'utf8'));
        }
        for (const text of templates)
          for (const v of templateVariables(text)) {
            const [kind, ...parts] = v.split(':');
            const key = parts.join(':');
            if (['appId', 'base_domain'].includes(v)) continue;
            if (
              (['url', 'host'].includes(kind) && m.routes.some((r) => r.name === key)) ||
              (kind === 'env' && m.env.some((e) => e.name === key)) ||
              (kind === 'output' && /^[A-Z][A-Z0-9_]*$/.test(key)) ||
              (kind === 'link' && m.consumes.some((c) => key.startsWith(c.capability + '.')))
            )
              continue;
            errors.push(`${id}: unknown template {${v}}`);
          }
        const scripts: Record<string, string> = {};
        for (const h of Object.values(m.hooks))
          if (h) {
            if (!c.services?.[h.service]) errors.push(`${id}: hook service ${h.service} missing`);
            scripts[h.script] = await fs.readFile(safePath(dir, h.script), 'utf8');
          }
        // Parse shell inside the helper container: the host never needs sh.
        const syntax = await docker(
          ctx,
          [
            'run',
            '--rm',
            '-i',
            '--network',
            'none',
            HELPER_IMAGE,
            'sh',
            '-c',
            'mkdir -p /tmp/hooks; tar -xf - -C /tmp/hooks; for f in /tmp/hooks/hooks/*.sh; do sh -n "$f" || exit 1; done',
          ],
          { input: tar(scripts), allowFailure: true },
        );
        if (syntax.exitCode) errors.push(`${id}: hook syntax: ${syntax.stderr}`);
        const values = Object.fromEntries(
          m.env.map((e) => [e.name, e.value ?? 'lint-placeholder']),
        );
        const config = await docker(ctx, ['compose', '-f', '-', 'config', '--format', 'json'], {
          cwd: dir,
          input: JSON.stringify({
            ...c,
            services: Object.fromEntries(
              Object.entries<any>(c.services ?? {}).map(([n, s]) => [
                n,
                { ...s, environment: { ...s.environment, ...{} } },
              ]),
            ),
          }).replace(/\$\{([A-Z_0-9]+)(?::[^}]*)?\}/g, (_, k) => values[k] ?? 'lint-placeholder'),
          allowFailure: true,
        });
        if (config.exitCode) errors.push(`${id}: compose config: ${config.stderr}`);
      } catch (e) {
        errors.push(`${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  if (!allowLocal)
    for (const image of images)
      try {
        const platforms = await registryPlatforms(image);
        for (const p of ['linux/amd64', 'linux/arm64'])
          if (!platforms.includes(p)) errors.push(`${image}: missing ${p}`);
      } catch (e) {
        errors.push(`${image}: ${e}`);
      }
  // Dependency cycles and missing required apps are static catalog errors.
  try {
    const manifests = await listManifests(root);
    const map = new Map(manifests.map((m) => [m.id, m]));
    const visit = (id: string, stack: string[]) => {
      if (stack.includes(id)) throw new Error(`Dependency cycle: ${[...stack, id].join(' -> ')}`);
      const m = map.get(id);
      if (!m) throw new Error(`Missing dependency ${id}`);
      for (const dep of [
        ...m.requires,
        ...m.consumes
          .filter((c) => c.required && c.default_provider)
          .map((c) => c.default_provider!),
      ])
        visit(dep, [...stack, id]);
    };
    for (const m of manifests) visit(m.id, []);
  } catch (e) {
    errors.push(String(e));
  }
  return { valid: errors.length === 0, errors, apps: count };
}
