#!/usr/bin/env node
import { resolve } from 'node:path';

import { loadConfiguration, parseOptions, SERVER_ROOT } from './database-common.mjs';

const options = parseOptions(process.argv.slice(2), ['environment', 'help']);
if (options.help) {
  console.log('npm run env:status -- [--environment=development|production]');
} else {
  const config = loadConfiguration({ profile: options.environment });
  console.log(JSON.stringify({
    environment: config.profile,
    database: config.display,
    environmentFile: config.basePath,
    controlPlane: {
      host: config.environment.CONTROL_PLANE_HOST || '127.0.0.1',
      port: Number(config.environment.CONTROL_PLANE_PORT || 4310),
      storageRoot: resolve(SERVER_ROOT, config.environment.CONTROL_PLANE_STORAGE_ROOT || 'server-storage'),
    },
  }, null, 2));
}
