import { readFile, writeFile } from 'node:fs/promises';

const configPath = process.argv[2];
if (!configPath) {
  throw new Error('Expected the generated Wrangler config path.');
}

const config = JSON.parse(await readFile(configPath, 'utf8'));

function uniqueBindings(bindings) {
  const seen = new Set();
  return (bindings ?? []).filter(({ binding }) => {
    if (seen.has(binding)) return false;
    seen.add(binding);
    return true;
  });
}

config.d1_databases = uniqueBindings(config.d1_databases);
config.r2_buckets = uniqueBindings(config.r2_buckets);
config.dev = {
  ...(config.dev ?? {}),
  local_protocol: 'https',
  upstream_protocol: 'https',
};

await writeFile(configPath, `${JSON.stringify(config)}\n`, 'utf8');
