import { readFile, readdir } from 'node:fs/promises';

export async function readRepositorySource() {
  const directory = new URL('../../src/', import.meta.url);
  const files = (await readdir(directory)).filter(name => name === 'postgres-repository.mjs'
    || /^repository-.*\.mjs$/u.test(name)).sort();
  return (await Promise.all(files.map(name => readFile(new URL(name, directory), 'utf8')))).join('\n');
}
