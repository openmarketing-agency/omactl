import { fs, path, json, writeJson, now } from './fs';
import { OmaError } from './errors';
export type LockOwner = { pid: number; opId: string; command: string; started_at: string };
export function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code !== 'ESRCH';
  }
}
export async function acquireLock(
  home: string,
  owner: LockOwner,
  timeout: number,
  stale: (owner: LockOwner) => void = () => {},
) {
  const file = path.join(home, 'state', 'lock');
  const started = Date.now();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      await fs.mkdir(file, { mode: 0o700 });
      await writeJson(path.join(file, 'owner.json'), owner, 0o600);
      break;
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
    }
    const held = await json<LockOwner>(path.join(file, 'owner.json')).catch(() => null);
    const stat = await fs.stat(file).catch(() => null);
    if ((held && !alive(held.pid)) || (!held && stat && Date.now() - stat.mtimeMs > 5000)) {
      const moved = `${file}.stale-${owner.opId}`;
      try {
        await fs.rename(file, moved);
        if (held) stale(held);
        await fs.rm(moved, { recursive: true, force: true });
        continue;
      } catch {}
    }
    if (Date.now() - started >= timeout)
      throw new OmaError(
        'LOCK_HELD',
        'Another operation holds the mutation lock',
        4,
        'Inspect omactl history or increase --lock-timeout',
        { owner: held },
      );
    await Bun.sleep(Math.min(100, Math.max(1, timeout - (Date.now() - started))));
  }
  return async () => {
    const held = await json<LockOwner>(path.join(file, 'owner.json')).catch(() => null);
    if (held?.opId === owner.opId) await fs.rm(file, { recursive: true, force: true });
  };
}
