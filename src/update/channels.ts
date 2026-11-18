import { verify as cryptoVerify, createPublicKey } from 'node:crypto';
import { z } from 'zod';
import { Context } from '../core/context';
import { OmaError, assert } from '../core/errors';
import { hash } from '../core/fs';
declare const OMA_RELEASE_KEYS: string[];
export const PUBLIC_KEYS: string[] =
  typeof OMA_RELEASE_KEYS === 'undefined' ? [] : OMA_RELEASE_KEYS;
const Asset = z.object({ url: z.url(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
export const Channel = z.object({
  channel: z.enum(['stable', 'canary', 'pinned']),
  published_at: z.iso.datetime(),
  omactl: z.object({ version: z.string(), assets: z.record(z.string(), Asset) }),
  catalog: Asset.extend({ version: z.string() }),
});
export type ChannelRelease = z.infer<typeof Channel>;
export function verifySignature(
  bytes: Uint8Array,
  signature: Uint8Array,
  keys: string[] = PUBLIC_KEYS,
) {
  return keys.some((key) => {
    try {
      return cryptoVerify(null, bytes, createPublicKey(key), signature);
    } catch {
      return false;
    }
  });
}
export async function download(url: string, timeout = 300000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!response.ok)
    throw new OmaError('DOWNLOAD_FAILED', `Download ${url} returned ${response.status}`, 3);
  return new Uint8Array(await response.arrayBuffer());
}
export async function checkedDownload(asset: { url: string; sha256: string }, timeout = 300000) {
  const data = await download(asset.url, timeout);
  assert(hash(data) === asset.sha256, 'HASH_MISMATCH', 'Downloaded asset failed its SHA-256 check');
  return data;
}
export async function fetchChannel(ctx: Context, options: { channel?: string; to?: string } = {}) {
  const config = await ctx.config();
  const channel = options.channel ?? config.channel;
  assert(
    channel !== 'pinned' || options.to,
    'PINNED_CHANNEL',
    'Pinned instances require --to <version>',
  );
  const url = options.to
    ? `${config.release_url}/versions/${encodeURIComponent(options.to)}.json`
    : `${config.release_url}/channels/${channel}.json`;
  const [bytes, sig] = await Promise.all([
    download(url, ctx.timeout),
    download(url + '.sig', ctx.timeout),
  ]);
  const text = Buffer.from(sig).toString().trim();
  const signature = sig.length === 64 ? sig : Buffer.from(text, 'base64');
  assert(
    verifySignature(bytes, signature),
    'INVALID_SIGNATURE',
    'Release channel has no valid trusted Ed25519 signature',
  );
  const release = Channel.parse(JSON.parse(Buffer.from(bytes).toString()));
  assert(
    options.to || release.channel === channel,
    'CHANNEL_MISMATCH',
    'Signed channel name does not match requested channel',
  );
  if (options.to)
    assert(
      release.catalog.version === options.to || release.omactl.version === options.to,
      'VERSION_MISMATCH',
      'Release does not match --to version',
    );
  return release;
}
