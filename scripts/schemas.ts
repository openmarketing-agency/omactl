import { z } from 'zod';
import {
  Manifest,
  Config,
  AppLock,
  dataSchemas,
  envelopeSchema,
  type CommandName,
} from '../src/schemas';
import { writeJson } from '../src/core/fs';
for (const [name, schema] of Object.entries({
  manifest: Manifest,
  config: Config,
  'app-lock': AppLock,
}))
  await writeJson(`schemas/${name}.schema.json`, z.toJSONSchema(schema, { target: 'draft-7' }));
for (const command of Object.keys(dataSchemas) as CommandName[])
  await writeJson(
    `schemas/output/${command.replace(/ /g, '-')}.schema.json`,
    z.toJSONSchema(envelopeSchema(command), { target: 'draft-7' }),
  );
console.log('Exported manifest, configuration, state, and all command envelope schemas.');
