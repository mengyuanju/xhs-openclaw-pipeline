import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DRIZZLE_DIRECTORY_PATTERN = /^\d{14}_[a-z0-9_]+$/u;

export function preserveTextPrimaryKeyNullability(sql) {
  return sql.replace(
    /(`[^`]+`\s+text\s+PRIMARY\s+KEY)(?!\s+NOT\s+NULL)/giu,
    '$1 NOT NULL',
  );
}

async function migrationDirectories(root) {
  return new Set((await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && DRIZZLE_DIRECTORY_PATTERN.test(entry.name))
    .map((entry) => entry.name));
}

function runDrizzleGenerate(cwd) {
  const drizzleEntry = fileURLToPath(import.meta.resolve('drizzle-kit'));
  const drizzleCli = resolve(dirname(drizzleEntry), 'bin.cjs');
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [drizzleCli, 'generate'], {
      cwd,
      shell: false,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`drizzle-kit generate failed (${signal ?? code ?? 'unknown'})`));
    });
  });
}

export async function generateMigration({ cwd = process.cwd() } = {}) {
  const drizzleRoot = resolve(cwd, 'drizzle');
  const d1Root = resolve(cwd, 'd1-migrations');
  const before = await migrationDirectories(drizzleRoot);
  await runDrizzleGenerate(cwd);
  const after = await migrationDirectories(drizzleRoot);
  const created = [...after].filter((name) => !before.has(name)).sort();
  await mkdir(d1Root, { recursive: true });
  for (const name of created) {
    const source = resolve(drizzleRoot, name, 'migration.sql');
    const sourceInfo = await stat(source);
    if (!sourceInfo.isFile() || sourceInfo.size === 0) {
      throw new Error(`generated migration ${name} has no SQL file`);
    }
    const sql = await readFile(source, 'utf8');
    const normalizedSql = preserveTextPrimaryKeyNullability(sql);
    if (normalizedSql !== sql) {
      await writeFile(source, normalizedSql, 'utf8');
    }
    await copyFile(source, resolve(d1Root, `${name}.sql`), constants.COPYFILE_EXCL);
  }
  if (created.length > 0) {
    console.log(`Synchronized ${created.length} migration(s) to the Cloudflare D1 directory.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generateMigration();
}
