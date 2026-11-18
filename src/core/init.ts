import { randomBytes } from 'node:crypto';
import { Context } from './context';
import { fs, path, exists, writeJson, hash, walk } from './fs';
import { doctor } from '../platform/doctor';
import { planFor, mutate } from './operation';
import { initGit } from './history';
import { docker } from '../docker';
import { catalogMetadata, listManifests, loadManifest, compareVersions } from '../catalog';
import { lintCatalog } from '../catalog/lint';
import { installOne } from '../apps';
import { fetchChannel } from '../update/channels';
import { stageCatalog, swapCatalog } from '../update';
import { assert } from './errors';
import { hostname } from '../apps';
import { VERSION } from './version';
export async function init(ctx: Context, options: any) {
  if (await exists(ctx.p('omactl.yml'))) {
    const config = await ctx.config();
    return { initialized: true, instance_id: config.instance_id, home: ctx.home };
  }
  const ingress = {
    http_port: Number(options.httpPort ?? 80),
    https_port: Number(options.httpsPort ?? 443),
    tls: options.tls ?? 'off',
    acme_email: options.acmeEmail ?? null,
  };
  assert(['off', 'acme'].includes(ingress.tls), 'INVALID_TLS', 'TLS must be off or acme', 2);
  assert(
    ingress.tls !== 'acme' || ingress.acme_email,
    'ACME_EMAIL_REQUIRED',
    '--acme-email is required with --tls acme',
    2,
  );
  assert(
    ['stable', 'canary', 'pinned'].includes(options.channel ?? 'stable'),
    'INVALID_CHANNEL',
    'Channel must be stable, canary or pinned',
    2,
  );
  const domain = hostname(options.baseDomain ?? 'localhost');
  return mutate(
    ctx,
    planFor(
      'init',
      ['instance'],
      [
        'Check Docker and platform',
        'Create instance config and git history',
        'Create oma_edge network',
        'Fetch and validate catalog',
        'Install and verify Traefik',
      ],
    ),
    options,
    async (op) => {
      // Recheck under the lock in case another init completed while we waited.
      if (await exists(ctx.p('omactl.yml'))) {
        const config = await ctx.config();
        return { initialized: true, instance_id: config.instance_id, home: ctx.home };
      }
      const result = await op.step('Doctor preflight', () => doctor(ctx, ingress));
      assert(
        !result.checks.some((c) => c.status === 'fail'),
        'DOCTOR_FAILED',
        'Doctor found blocking failures',
        3,
      );
      const id = 'inst_' + randomBytes(6).toString('hex');
      for (const dir of ['apps', 'system/traefik/dynamic', 'secrets', 'state/ops', 'logs'])
        await fs.mkdir(ctx.p(...dir.split('/')), { recursive: true, mode: 0o700 });
      await ctx.saveConfig({
        instance_id: id,
        base_domain: domain,
        ingress,
        channel: options.channel ?? 'stable',
        release_url: options.releaseUrl ?? 'https://releases.openmarketing.agency',
        updates: 'notify',
        backup: { repository: null, policy: 'self-managed', nightly_window: '01:00-05:00' },
        heartbeat: { url: null },
      });
      try {
        await initGit(ctx);
        const network = await docker(ctx, ['network', 'inspect', 'oma_edge', '--format', 'json'], {
          allowFailure: true,
        });
        if (network.exitCode !== 0)
          await docker(ctx, ['network', 'create', '--label', 'oma.managed=true', 'oma_edge']);
        if (options.catalog) {
          const source = path.resolve(options.catalog);
          await walk(source);
          const lint = await lintCatalog(ctx, source, true);
          assert(lint.valid, 'INVALID_CATALOG', 'Local catalog failed lint');
          const meta = await catalogMetadata(source);
          assert(
            compareVersions(VERSION, meta.min_omactl) >= 0,
            'NEW_BINARY_REQUIRED',
            `Catalog requires omactl ${meta.min_omactl}`,
          );
          await listManifests(source);
          await fs.cp(source, ctx.p('catalog'), { recursive: true });
          const files = [];
          for (const file of (await walk(source)).sort())
            files.push([file, hash(await fs.readFile(path.join(source, file)))]);
          await writeJson(ctx.p('state', 'catalog.lock.json'), {
            version: meta.version,
            channel: options.channel ?? 'stable',
            sha256: hash(JSON.stringify(files)),
            signature: false,
          });
          ctx.warn('LOCAL_CATALOG', 'Using a local catalog without a release signature');
        } else {
          const release = await fetchChannel(ctx);
          const dir = ctx.p('state', `catalog-new-${ctx.opId}`);
          await stageCatalog(ctx, release, dir);
          const lint = await lintCatalog(ctx, dir);
          assert(lint.valid, 'INVALID_CATALOG', 'Downloaded catalog failed lint', 3);
          await swapCatalog(ctx, dir, release);
        }
        await installOne(ctx, await loadManifest(ctx.p('catalog'), 'traefik'), op);
        const response = await fetch(`http://127.0.0.1:${ingress.http_port}`, {
          signal: AbortSignal.timeout(10000),
        });
        assert(response.status > 0, 'INGRESS_FAILED', 'Traefik did not answer on the ingress port');
      } catch (e) {
        await fs.rm(ctx.p('omactl.yml'), { force: true });
        throw e;
      }
      return { initialized: true, instance_id: id, home: ctx.home };
    },
  );
}
