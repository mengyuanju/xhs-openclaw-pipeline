import { constants } from 'node:fs';
import { copyFile, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// OpenClaw 2026.8.2 disables plugins in thread/start, after app-server has already
// started a curated Git fetch in its temporary home. Apply the same restriction
// at startup; do not change auth, the ordinary harness, or hosted web search.
// Codex config: https://learn.chatgpt.com/docs/config-file/config-reference
export function patchBoundedSearchSource(source) {
  const functions = [...source.matchAll(/^function buildPrivateCodexAppServerStartOptions\(start, codexHome\) \{[\s\S]*?^\}/gm)];
  if (functions.length !== 1) throw new Error('Unsupported OpenClaw bounded-search implementation');
  const original = functions[0][0];
  if (/args: \[\s*"-c",\s*"features.plugins=false",\s*"app-server"/u.test(original)) return source;
  const argumentStart = /args: \[(\s*)"app-server"/gu;
  if ([...original.matchAll(argumentStart)].length !== 1) {
    throw new Error('Unsupported OpenClaw bounded-search startup arguments');
  }
  const patched = original.replace(argumentStart,
    'args: [$1"-c",$1"features.plugins=false",$1"app-server"');
  return source.slice(0, functions[0].index) + patched + source.slice(functions[0].index + original.length);
}

export async function patchInstalledBoundedSearch({ openclawRoot, apply = false }) {
  const root = await realpath(resolve(openclawRoot));
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (!['openclaw', '@openclaw/codex'].includes(metadata.name)) {
    throw new Error('Target is not an OpenClaw installation or its @openclaw/codex plugin');
  }
  const packageInfo = { packageName: metadata.name, version: metadata.version };
  const dist = await realpath(join(root, 'dist'));
  const names = (await readdir(dist)).filter((name) => /^bounded-turn-[\w-]+\.js$/u.test(name));
  if (names.length !== 1) throw new Error('Unsupported OpenClaw bounded-search module layout');
  const file = await realpath(join(dist, names[0]));
  if (dirname(file) !== dist) throw new Error('Bounded-search module escapes OpenClaw dist');
  const original = await readFile(file, 'utf8');
  const patched = patchBoundedSearchSource(original);
  const backup = `${file}.xhs-startup-plugins.bak`;
  if (patched === original) return { status: 'already-patched', ...packageInfo, file };
  if (!apply) return { status: 'ready', ...packageInfo, file, backup };
  // Never overwrite a prior backup, including one from a different package build.
  await copyFile(file, backup, constants.COPYFILE_EXCL);
  await writeFile(file, patched, 'utf8');
  return { status: 'patched', ...packageInfo, file, backup };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = process.argv.slice(2).find((arg) => arg.startsWith('--openclaw-root='))?.slice(16);
  if (!root) {
    console.error('Usage: node scripts/patch-openclaw-bounded-search.mjs --openclaw-root=<openclaw-or-@openclaw/codex-package> [--apply]');
    process.exitCode = 1;
  } else {
    try {
      console.log(JSON.stringify(await patchInstalledBoundedSearch({
        openclawRoot: root, apply: process.argv.includes('--apply'),
      }), null, 2));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
