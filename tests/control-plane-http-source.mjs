import { readFile, readdir } from 'node:fs/promises';

// Source contract checks span the public HTTP entry point and its domain
// modules, just as runtime tests continue to import createControlPlaneApp.
export async function readControlPlaneHttpSource() {
  const directory = new URL('../server/src/', import.meta.url);
  const files = (await readdir(directory)).filter(name => /^http-.*\.mjs$/u.test(name)).sort();
  return (await Promise.all(files.map(name => readFile(new URL(name, directory), 'utf8')))).join('\n');
}
