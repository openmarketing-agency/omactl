import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { OmaError } from './errors';
export { fs, path };
export const exists = async (p: string) => !!(await fs.stat(p).catch(() => null));
export async function write(p: string, value: string | Uint8Array, mode = 0o644) {
  await fs.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.tmp-${randomBytes(6).toString('hex')}`;
  await fs.writeFile(tmp, typeof value === 'string' ? value.replace(/\r\n/g, '\n') : value, {
    mode,
  });
  await fs.chmod(tmp, mode);
  await fs.rename(tmp, p);
}
export const json = async <T = any>(p: string): Promise<T> =>
  JSON.parse(await fs.readFile(p, 'utf8'));
export const writeJson = (p: string, value: unknown, mode = 0o644) =>
  write(p, JSON.stringify(value, null, 2) + '\n', mode);
export const hash = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
export const now = () => new Date().toISOString();
export function safePath(root: string, relative: string) {
  const result = path.resolve(root, relative);
  if (
    path.isAbsolute(relative) ||
    relative.includes('\\') ||
    !result.startsWith(path.resolve(root) + path.sep)
  )
    throw new OmaError('UNSAFE_PATH', `Unsafe path: ${relative}`, 3);
  return result;
}
export async function walk(root: string, prefix = ''): Promise<string[]> {
  const entries = await fs
    .readdir(path.join(root, prefix), { withFileTypes: true })
    .catch(() => []);
  return (
    await Promise.all(
      entries.map(async (e) => {
        const p = path.join(prefix, e.name);
        if (e.isSymbolicLink())
          throw new OmaError('UNSAFE_PATH', `Symlinks are not allowed: ${p}`, 3);
        return e.isDirectory() ? walk(root, p) : [p];
      }),
    )
  ).flat();
}
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2];
    out[match[1]] = value.startsWith('"')
      ? JSON.parse(value).replace(/\$\$/g, '$')
      : value.startsWith("'")
        ? value.slice(1, -1)
        : value;
  }
  return out;
}
export async function readEnv(file: string) {
  return parseEnv(await fs.readFile(file, 'utf8').catch(() => ''));
}
export function envText(values: Record<string, string>) {
  return (
    Object.entries(values)
      .map(([k, v]) => `${k}='${v.replace(/'/g, "'\\''")}'`)
      .join('\n') + '\n'
  );
}
export async function saveEnv(file: string, values: Record<string, string>) {
  // Double quoted Compose env values support escaped newlines and quotes. Escape $ to prevent interpolation.
  await write(
    file,
    Object.entries(values)
      .map(([k, v]) => `${k}=${JSON.stringify(v).replace(/\$/g, '$$$$')}`)
      .join('\n') + '\n',
    0o600,
  );
}
