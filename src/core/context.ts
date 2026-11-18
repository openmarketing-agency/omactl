import { parse, stringify } from 'yaml';
import { fs, path, json, write, writeJson, readEnv, exists, now } from './fs';
import { Secrets } from './secrets';
import { Config, AppLock, AppId, type InstanceConfig, type InstalledApp } from '../schemas';
import { OmaError } from './errors';
import { omaHome } from '../platform';
export type Options = {
  json?: boolean;
  home?: string;
  plan?: boolean;
  yes?: boolean;
  confirm?: string;
  lockTimeout?: string;
  timeout?: string;
  verbose?: boolean;
  quiet?: boolean;
};
export class Context {
  home: string;
  secrets = new Secrets();
  warnings: { code: string; message: string }[] = [];
  opId: string | null = null;
  constructor(public opts: Options) {
    this.home = omaHome(opts.home);
  }
  p(...parts: string[]) {
    return path.join(this.home, ...parts);
  }
  appDir(id: string) {
    AppId.parse(id);
    return this.p('apps', id);
  }
  get timeout() {
    return Number(this.opts.timeout ?? 300) * 1000;
  }
  warn(code: string, message: string) {
    this.warnings.push({ code, message });
  }
  async config(): Promise<InstanceConfig> {
    if (!(await exists(this.p('omactl.yml'))))
      throw new OmaError('NOT_INITIALIZED', 'Instance is not initialized', 3, 'Run: omactl init');
    return Config.parse(parse(await fs.readFile(this.p('omactl.yml'), 'utf8')));
  }
  async saveConfig(config: InstanceConfig) {
    await write(this.p('omactl.yml'), stringify(Config.parse(config)));
  }
  async catalogLock() {
    return json<{ version: string; channel: string; sha256: string; signature: boolean }>(
      this.p('state', 'catalog.lock.json'),
    );
  }
  async app(id: string): Promise<InstalledApp> {
    const file = path.join(this.appDir(id), 'app.lock.json');
    if (!(await exists(file))) throw new OmaError('APP_NOT_FOUND', `App ${id} is not installed`, 9);
    return AppLock.parse(await json(file));
  }
  async apps(): Promise<InstalledApp[]> {
    const ids = await fs.readdir(this.p('apps')).catch(() => []);
    const apps = [];
    for (const id of ids)
      if (await exists(this.p('apps', id, 'app.lock.json'))) apps.push(await this.app(id));
    return apps;
  }
  async saveApp(app: InstalledApp) {
    app.updated_at = now();
    await writeJson(path.join(this.appDir(app.id), 'app.lock.json'), AppLock.parse(app));
  }
  async loadSecrets() {
    for (const app of await this.apps()) {
      const values = await readEnv(path.join(this.appDir(app.id), '.env'));
      for (const [key, value] of Object.entries(values)) {
        if (
          app.outputs.includes(key) ||
          app.manifest.env.some((e) => e.name === key && e.secret) ||
          app.manifest.consumes.some((e) => key.startsWith(e.env_prefix))
        )
          this.secrets.add(value.replace(/\$\$/g, '$'));
      }
    }
    for (const file of await fs.readdir(this.p('secrets')).catch(() => [])) {
      const content = await fs.readFile(this.p('secrets', file), 'utf8');
      for (const value of Object.values(await readEnv(this.p('secrets', file))))
        this.secrets.add(value);
      this.secrets.add(content.trim());
    }
  }
}
