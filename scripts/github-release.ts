import { fs, path, hash } from '../src/core/fs';
export async function publishGithub(
  repository: string,
  token: string,
  tag: string,
  files: string[],
  fetcher: (url: string, options?: RequestInit) => Promise<Response> = fetch,
) {
  const api = `https://api.github.com/repos/${repository}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2026-03-10',
    'User-Agent': 'omactl-release',
  };
  async function request(url: string, options: RequestInit = {}) {
    const res = await fetcher(url, {
      ...options,
      headers: { ...headers, ...options.headers },
      signal: AbortSignal.timeout(300000),
    });
    if (!res.ok) throw new Error(`GitHub release ${options.method ?? 'GET'}: HTTP ${res.status}`);
    return res.status === 204 ? null : res.json();
  }
  const existing = await fetcher(`${api}/releases/tags/${encodeURIComponent(tag)}`, {
    headers,
    signal: AbortSignal.timeout(30000),
  });
  let release: any;
  if (existing.ok) release = await existing.json();
  else if (existing.status === 404)
    release = await request(`${api}/releases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag_name: tag, name: `omactl ${tag}`, draft: true }),
    });
  else throw new Error(`GitHub release lookup: HTTP ${existing.status}`);
  for (const file of files) {
    const name = path.basename(file),
      bytes = await fs.readFile(file),
      old = release.assets?.find((a: any) => a.name === name);
    if (old?.digest === `sha256:${hash(bytes)}`) continue;
    if (old) await request(`${api}/releases/assets/${old.id}`, { method: 'DELETE' });
    const url = release.upload_url.replace(/\{.*$/, '') + `?name=${encodeURIComponent(name)}`;
    await request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
  }
  if (release.draft)
    await request(`${api}/releases/${release.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft: false }),
    });
}
