import { gunzipSync, gzipSync } from 'node:zlib';
import { fs, safePath, walk, write } from './fs';
import path from 'node:path';
import { OmaError } from './errors';
export function tar(files: Record<string, string | Uint8Array>, mode = 0o600) {
  const chunks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    if (Buffer.byteLength(name) > 100 || name.startsWith('/') || name.split('/').includes('..'))
      throw new OmaError('UNSAFE_ARCHIVE', `Invalid archive path ${name}`, 3);
    const bytes = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name);
    header.write(mode.toString(8).padStart(7, '0') + '\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136);
    header.fill(32, 148, 156);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    const sum = header.reduce((s, n) => s + n, 0);
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    chunks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}
export function untar(input: Uint8Array) {
  const data = Buffer.from(input);
  const files: Record<string, Buffer> = {};
  for (let offset = 0; offset + 512 <= data.length; ) {
    const h = data.subarray(offset, offset + 512);
    if (h.every((v) => v === 0)) break;
    const string = (s: number, n: number) =>
      h
        .subarray(s, s + n)
        .toString()
        .split('\0')[0];
    const sum = parseInt(string(148, 8).trim(), 8);
    const actual = h.reduce((s, n, i) => s + (i >= 148 && i < 156 ? 32 : n), 0);
    if (actual !== sum) throw new OmaError('INVALID_ARCHIVE', 'Archive checksum mismatch', 3);
    let name = string(0, 100);
    const prefix = string(345, 155);
    if (prefix) name = prefix + '/' + name;
    const size = parseInt(string(124, 12).trim() || '0', 8);
    const type = string(156, 1);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > data.length)
      throw new OmaError('INVALID_ARCHIVE', 'Truncated archive', 3);
    name = name.replace(/^\.\//, '');
    if (name.startsWith('/') || name.includes('\\') || name.split('/').includes('..'))
      throw new OmaError('UNSAFE_ARCHIVE', `Unsafe path ${name}`, 3);
    if (type === '0' || type === '')
      files[name] = Buffer.from(data.subarray(offset + 512, offset + 512 + size));
    else if (type !== '5')
      throw new OmaError('UNSAFE_ARCHIVE', `Unsupported archive entry type ${type}`, 3);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}
export async function archiveDir(dir: string) {
  const files: Record<string, Buffer> = {};
  for (const p of await walk(dir))
    files[p.split(path.sep).join('/')] = await fs.readFile(path.join(dir, p));
  return gzipSync(tar(files));
}
export async function extractArchive(data: Uint8Array, dir: string) {
  const bytes = Buffer.from(data);
  const files = untar(bytes[0] === 31 && bytes[1] === 139 ? gunzipSync(bytes) : bytes);
  for (const [name, content] of Object.entries(files)) await write(safePath(dir, name), content);
}
