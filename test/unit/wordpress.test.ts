import { test, expect } from 'bun:test';
import { loadManifest } from '../../src/catalog';
import { parse } from 'yaml';
import { fs } from '../../src/core/fs';
test('WordPress catalog pins images, isolates MariaDB, and declares complete backup/hook ownership', async () => {
  const m = await loadManifest('catalog', 'wordpress'),
    c = parse(await fs.readFile('catalog/apps/wordpress/compose.yml', 'utf8'));
  expect(m.main_service).toBe('wordpress');
  expect(m.requires).toContain('traefik');
  for (const [name, service] of Object.entries<any>(c.services)) {
    expect(service.image).toMatch(/:.+@sha256:[a-f0-9]{64}$/);
    expect(service.ports).toBeUndefined();
    expect(service.network_mode).toBeUndefined();
    if (name !== 'wpcli') expect(service.healthcheck).toBeDefined();
  }
  expect(c.services.wpcli.profiles).toContain('tools');
  expect(c.services.wpcli.user).toBe('33:33');
  expect(c.services.db.environment.MARIADB_PASSWORD).toBe('${WORDPRESS_DB_PASSWORD}');
  for (const v of m.volumes) expect(c.volumes[v.key].name).toBe(`oma_wordpress_${v.key}`);
  expect(m.volumes.find((v) => v.key === 'dbdata')?.backup).toBe('skip');
  expect(m.volumes.find((v) => v.key === 'html')?.backup).toBe('files');
  expect(m.volumes.find((v) => v.key === 'dump')?.backup).toBe('files');
  expect(m.hooks.pre_backup?.service).toBe('db');
  expect(m.hooks.post_restore?.service).toBe('db');
  expect(m.hooks.setup.service).toBe('wpcli');
  expect(m.hooks.migrate?.service).toBe('wordpress');
  for (const h of Object.values(m.hooks))
    if (h) expect(await Bun.file('catalog/apps/wordpress/' + h.script).exists()).toBe(true);
});
