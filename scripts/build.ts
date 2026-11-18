import { fs } from '../src/core/fs';
export const targets = [
  'bun-linux-x64',
  'bun-linux-arm64',
  'bun-darwin-x64',
  'bun-darwin-arm64',
  'bun-linux-x64-musl',
  'bun-linux-arm64-musl',
] as const;
export async function build(
  target: string,
  outfile: string,
  version?: string,
  keys: string[] = [],
) {
  const result = await Bun.build({
    entrypoints: ['src/cli/index.ts'],
    compile: { target: target as any, outfile },
    minify: true,
    define: {
      OMA_RELEASE_KEYS: JSON.stringify(keys),
      ...(version ? { OMA_BUILD_VERSION: JSON.stringify(version) } : {}),
    },
  });
  if (!result.success) throw new Error(result.logs.join('\n'));
}
if (import.meta.main) {
  await fs.mkdir('dist', { recursive: true });
  const keys = JSON.parse(process.env.OMA_RELEASE_PUBLIC_KEYS ?? '[]');
  for (const target of process.argv.includes('--current')
    ? [`bun-${process.platform}-${process.arch}`]
    : targets) {
    const out = `dist/omactl-${target.slice(4)}`;
    await build(target, out, process.env.OMA_BUILD_VERSION, keys);
    console.log(out);
  }
}
