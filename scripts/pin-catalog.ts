import { parse, stringify } from 'yaml';
import { fs, write, path } from '../src/core/fs';
const repository = process.env.OMA_FIXTURE_IMAGE;
const digest = process.env.OMA_FIXTURE_DIGEST;
if (!repository || !digest || !/^sha256:[a-f0-9]{64}$/.test(digest))
  throw new Error('OMA_FIXTURE_IMAGE and OMA_FIXTURE_DIGEST are required');
for (const app of ['testapp', 'testclient']) {
  const file = path.join('catalog', 'apps', app, 'compose.yml'),
    compose = parse(await fs.readFile(file, 'utf8'));
  compose.services[app].image = `${repository}:1.0.0@${digest}`;
  await write(file, stringify(compose));
}
