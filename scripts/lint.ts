import { fs, walk, path } from '../src/core/fs';
const errors: string[] = [];
for (const file of await walk('src')) {
  if (!file.endsWith('.ts')) continue;
  const source = await fs.readFile(path.join('src', file), 'utf8');
  if (!file.startsWith('platform' + path.sep) && /process\.platform/.test(source))
    errors.push(`${file}: OS checks belong in platform/`);
  if (/node:child_process|from ['"]child_process/.test(source))
    errors.push(`${file}: use Bun.spawn through Docker or platform adapters`);
  if (/\r/.test(source)) errors.push(`${file}: CRLF line ending`);
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else console.log('Portability checks passed.');
