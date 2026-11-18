// Resolves Docker Hub's multi-platform index through its authenticated registry API.
export async function imageInfo(image: string) {
  const withoutDigest = image.split('@')[0];
  const split = withoutDigest.lastIndexOf(':');
  const repo = split > withoutDigest.indexOf('/') ? withoutDigest.slice(0, split) : withoutDigest;
  const tag = split > withoutDigest.indexOf('/') ? withoutDigest.slice(split + 1) : 'latest';
  const repository = repo.includes('/') ? repo : `library/${repo}`;
  const token = (await fetch(
    `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`,
  ).then((r) => r.json())) as any;
  const response = await fetch(`https://registry-1.docker.io/v2/${repository}/manifests/${tag}`, {
    headers: {
      Authorization: `Bearer ${token.token}`,
      Accept:
        'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json',
    },
  });
  if (!response.ok) throw new Error(`${image}: ${response.status} ${await response.text()}`);
  const index = (await response.json()) as any;
  return {
    image: `${withoutDigest}@${response.headers.get('docker-content-digest')}`,
    platforms:
      index.manifests?.map((m: any) => `${m.platform.os}/${m.platform.architecture}`) ?? [],
  };
}
if (import.meta.main)
  for (const img of process.argv.slice(2)) console.log(JSON.stringify(await imageInfo(img)));
