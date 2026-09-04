import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';
import { createInterface } from 'node:readline';
import pg from 'pg';

export const SERVER_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const quoteId = (name) => '"' + String(name).replaceAll('"', '""') + '"';
export const tableName = (table) => `${quoteId(table.schema)}.${quoteId(table.name)}`;

export function parseOptions(args, allowed) {
  const options = {};
  for (const arg of args) {
    const match = /^--([a-z-]+)(?:=(.*))?$/u.exec(arg);
    if (!match || !allowed.includes(match[1]) || Object.hasOwn(options, match[1])) throw new Error(`Unknown/duplicate option: ${arg}`);
    if (['apply', 'help'].includes(match[1])) {
      if (match[2] !== undefined) throw new Error(`--${match[1]} does not accept a value`);
      options[match[1]] = true;
    } else {
      if (!match[2]) throw new Error(`Use --${match[1]}=VALUE`);
      options[match[1]] = match[2];
    }
  }
  return options;
}

export function configuration(environment = process.env) {
  const url = new URL(environment.DATABASE_URL || 'missing:');
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Configure DATABASE_URL in server/.env');
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!/^[a-zA-Z0-9_-]{1,63}$/u.test(database)) throw new Error('Database name must contain 1–63 letters, digits, underscores or hyphens');
  const env = { ...environment, PGHOST: url.hostname, PGPORT: url.port || '5432',
    PGDATABASE: database, PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGCONNECT_TIMEOUT: '10' };
  const parameters = { sslmode: 'PGSSLMODE', sslrootcert: 'PGSSLROOTCERT', sslcert: 'PGSSLCERT', sslkey: 'PGSSLKEY', connect_timeout: 'PGCONNECT_TIMEOUT' };
  for (const [key, value] of url.searchParams) {
    if (!parameters[key]) throw new Error(`Unsupported DATABASE_URL parameter: ${key}`);
    env[parameters[key]] = value;
  }
  return { connectionString: url.toString(), database, environment: env, pgBin: environment.PG_BIN,
    display: `${url.hostname}:${url.port || '5432'}/${database}` };
}

export function loadConfiguration() {
  try { loadEnvFile(join(SERVER_ROOT, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return configuration();
}

export const connectDatabase = (config) => new pg.Client({ connectionString: config.connectionString, connectionTimeoutMillis: 10_000 });

export async function pgTool(name, config) {
  const executable = process.platform === 'win32' ? `${name}.exe` : name;
  if (config.pgBin) {
    const path = resolve(config.pgBin, executable);
    await access(path);
    return path;
  }
  if (process.platform === 'win32') {
    const root = join(process.env.ProgramFiles || 'C:\\Program Files', 'PostgreSQL');
    const versions = await readdir(root).catch(() => []);
    for (const version of versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
      const path = join(root, version, 'bin', executable);
      if (await access(path).then(() => true, () => false)) return path;
    }
  }
  return executable;
}

export function safeError(error, config) {
  let message = String(error?.message ?? error);
  for (const secret of [config?.connectionString, config?.environment?.PGPASSWORD]) {
    if (secret) message = message.split(secret).join('[redacted]');
  }
  return message.replace(/postgres(?:ql)?:\/\/[^\s]+/gu, '[database URL redacted]');
}

export async function runPg(name, args, config) {
  const executable = await pgTool(name, config);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, env: config.environment, stdio: ['ignore', 'ignore', 'pipe'] });
    let errorText = '';
    child.stderr.on('data', (chunk) => { errorText = (errorText + chunk.toString()).slice(-8000); });
    child.once('error', (error) => reject(new Error(safeError(error, config) + ' (install PostgreSQL client tools or set PG_BIN in server/.env)')));
    child.once('close', (code) => {
      if (code !== 0) reject(new Error(safeError(`${name} exited ${code}: ${errorText}`, config)));
      else { if (errorText.trim()) console.warn(safeError(errorText, config)); resolvePromise(); }
    });
  });
}

export async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export function packagePath(root, path) {
  if (typeof path !== 'string' || isAbsolute(path) || /^[A-Za-z]:|^[\\/]/u.test(path)) throw new Error('Invalid backup file path');
  const target = resolve(root, path.replaceAll('\\', '/'));
  const rel = relative(resolve(root), target);
  if (!rel || rel.startsWith('..') || rel.includes(':')) throw new Error('Backup file path escaped package');
  return target;
}

export async function readBackup(folder) {
  const root = resolve(folder);
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  if (manifest.format !== 'xhs-control-plane-backup' || manifest.version !== 1 || !Array.isArray(manifest.tables) || !Array.isArray(manifest.migrations)) {
    throw new Error('Unsupported/incomplete backup package');
  }
  for (const file of [manifest.archive, manifest.sql, ...manifest.tables, ...manifest.migrations]) {
    if (await hashFile(packagePath(root, file.file)) !== file.sha256) throw new Error(`Backup checksum mismatch: ${file.file}`);
  }
  const migrations = await Promise.all(manifest.migrations.map(async (entry) => ({
    id: entry.id, sha256: entry.sha256, sql: await readFile(packagePath(root, entry.file), 'utf8'),
  })));
  if (new Set(migrations.map((m) => m.id)).size !== migrations.length
    || migrations.some((m, i) => !/^\d{4}_[a-z0-9_-]+$/u.test(m.id) || (i > 0 && m.id <= migrations[i - 1].id))) throw new Error('Invalid migration order');
  return { root, manifest, migrations };
}

export async function listTables(client) {
  const { rows } = await client.query(`
    SELECT n.nspname AS schema, c.relname AS name,
      (SELECT json_agg(json_build_object('name', a.attname, 'type', format_type(a.atttypid,a.atttypmod),
        'generated', a.attgenerated, 'identity', a.attidentity) ORDER BY a.attnum)
       FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns,
      COALESCE((SELECT json_agg(a.attname ORDER BY k.ordinality) FROM pg_index i
        CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum, ordinality)
        JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum WHERE i.indrelid=c.oid AND i.indisprimary), '[]') AS "primaryKey"
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','p') AND NOT c.relispartition
      AND n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
    ORDER BY n.nspname,c.relname`);
  return rows;
}

export async function* rowBatches(path, size = 500) {
  const input = createReadStream(path);
  const lines = createInterface({ input, crlfDelay: Infinity });
  let batch = [];
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      batch.push(line);
      if (batch.length >= size) { yield batch; batch = []; }
    }
    if (batch.length) yield batch;
  } finally { lines.close(); input.destroy(); }
}

export function isMain(url) { return process.argv[1] && fileURLToPath(url) === resolve(process.argv[1]); }
