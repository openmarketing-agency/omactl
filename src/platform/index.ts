import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
export const tempDir = () => os.tmpdir();
export function homeDir() {
  return os.homedir();
}
export function omaHome(value?: string) {
  return path.resolve(value ?? process.env.OMA_HOME ?? path.join(homeDir(), '.oma'));
}
export const platformId = () => `${process.platform}-${process.arch}`;
export const binaryPath = () => process.execPath;
export const rootUser = () => process.getuid?.() === 0;
export function osKind() {
  return process.platform;
}
export function musl() {
  return (
    process.platform === 'linux' &&
    !!(process.report?.getReport() as any)?.header &&
    !(process.report?.getReport() as any).header.glibcVersionRuntime
  );
}
export async function supportTier(rootless = false): Promise<string> {
  if (rootless || !['x64', 'arm64'].includes(process.arch)) return 'unverified';
  if (process.platform === 'darwin') return '2';
  if (process.platform !== 'linux') return 'unverified';
  return /microsoft/i.test(await fs.readFile('/proc/version', 'utf8').catch(() => '')) ? '2' : '1';
}
export const isWsl = async () =>
  process.platform === 'linux' &&
  /microsoft/i.test(await fs.readFile('/proc/version', 'utf8').catch(() => ''));
export const systemdAvailable = () =>
  fs.stat('/run/systemd/system').then(
    () => true,
    () => false,
  );
export const memoryMb = () => os.freemem() / 1048576;
export function schedulerDir() {
  return process.platform === 'darwin'
    ? path.join(homeDir(), 'Library', 'LaunchAgents')
    : rootUser()
      ? '/etc/systemd/system'
      : path.join(homeDir(), '.config', 'systemd', 'user');
}
export async function smokeBinary(file: string, timeout: number) {
  // The only non-Docker application invocation: required by the self-update smoke-test protocol.
  const child = Bun.spawn([file, 'version', '--json'], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, OMA_HOME: process.env.OMA_HOME },
    timeout,
  });
  const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  if (code !== 0) throw new Error('New binary failed version smoke test');
  const data = JSON.parse(output);
  if (!data.ok || !data.data?.version) throw new Error('Invalid smoke-test output');
  return data.data.version as string;
}
