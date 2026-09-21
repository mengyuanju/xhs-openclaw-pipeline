import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const SERVER_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const SERVER_ENVIRONMENTS = Object.freeze(['development', 'production']);

export function serverEnvironmentProfile(args = [], environment = process.env) {
  const options = args.filter((arg) => arg.startsWith('--environment'));
  if (options.some((arg) => !/^--environment=[a-z]+$/u.test(arg)) || options.length > 1) {
    throw new Error('Use at most one --environment=development|production option.');
  }
  const requested = options[0]?.slice('--environment='.length)
    || environment.XHS_SERVER_ENV?.trim()
    || 'development';
  if (!SERVER_ENVIRONMENTS.includes(requested)) {
    throw new Error('XHS_SERVER_ENV/--environment must be development or production.');
  }
  return requested;
}

function readEnvironmentFile(path) {
  return existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
}

export function loadServerEnvironment({
  args = [],
  environment = process.env,
  profile,
  serverRoot = SERVER_ROOT,
} = {}) {
  const selectedProfile = profile ?? serverEnvironmentProfile(args, environment);
  if (!SERVER_ENVIRONMENTS.includes(selectedProfile)) {
    throw new Error('Server environment must be development or production.');
  }

  const basePath = join(serverRoot, '.env');
  const base = readEnvironmentFile(basePath);
  const combined = { ...base, ...environment };
  if (selectedProfile === 'production' && !combined.XHS_PRODUCTION_DATABASE_URL?.trim()) {
    throw new Error(`XHS_PRODUCTION_DATABASE_URL must be configured in ${basePath} or the process environment.`);
  }

  const effective = { ...combined, XHS_SERVER_ENV: selectedProfile };
  if (selectedProfile === 'production') {
    effective.DATABASE_URL = combined.XHS_PRODUCTION_DATABASE_URL;
    if (combined.XHS_PRODUCTION_STORAGE_ROOT?.trim()) {
      effective.CONTROL_PLANE_STORAGE_ROOT = combined.XHS_PRODUCTION_STORAGE_ROOT;
    }
  }

  return {
    profile: selectedProfile,
    basePath,
    environment: effective,
  };
}

export function applyServerEnvironment(environment, target = process.env) {
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value === 'string') target[key] = value;
  }
  return target;
}
