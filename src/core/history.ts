import git from 'isomorphic-git';
import nodefs from 'node:fs';
import { fs, path, exists, write, walk } from './fs';
import type { Context } from './context';
export async function initGit(ctx: Context) {
  if (!(await exists(ctx.p('.git'))))
    await git.init({ fs: nodefs, dir: ctx.home, defaultBranch: 'main' });
  await write(ctx.p('.gitignore'), '.env\n**/.env\nsecrets/\nstate/\nlogs/\ncatalog/\n');
}
export async function commit(ctx: Context, message: string) {
  if (!(await exists(ctx.p('.git')))) return;
  const files = ['.gitignore', 'omactl.yml'];
  for (const file of await walk(ctx.p('apps')))
    if (/^[^/]+\/(compose(?:\.[^.]+)?\.yml|app\.lock\.json)$/.test(file))
      files.push(path.join('apps', file));
  for (const file of await walk(ctx.p('system'))) files.push(path.join('system', file));
  const tracked = await git.listFiles({ fs: nodefs, dir: ctx.home });
  for (const file of new Set([...files, ...tracked])) {
    if (await exists(ctx.p(file))) await git.add({ fs: nodefs, dir: ctx.home, filepath: file });
    else await git.remove({ fs: nodefs, dir: ctx.home, filepath: file });
  }
  const matrix = await git.statusMatrix({ fs: nodefs, dir: ctx.home });
  if (!matrix.some(([, head, work, stage]) => head !== work || head !== stage)) return;
  await git.commit({
    fs: nodefs,
    dir: ctx.home,
    message,
    author: { name: 'omactl', email: 'ops@openmarketing.agency' },
  });
}

export async function definitionFromGit(
  ctx: Context,
  id: string,
): Promise<Record<string, Uint8Array>> {
  const oid = await git.resolveRef({ fs: nodefs, dir: ctx.home, ref: 'HEAD' });
  const result: Record<string, Uint8Array> = {};
  for (const file of ['compose.yml', 'compose.generated.yml', 'app.lock.json']) {
    const blob = await git.readBlob({
      fs: nodefs,
      dir: ctx.home,
      oid,
      filepath: path.join('apps', id, file),
    });
    result[file] = blob.blob;
  }
  return result;
}
