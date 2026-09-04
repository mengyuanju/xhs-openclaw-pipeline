import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

import { patchBoundedSearchSource, patchInstalledBoundedSearch } from '../scripts/patch-openclaw-bounded-search.mjs';

const fixture = `
function buildPrivateCodexAppServerStartOptions(start, codexHome) {
  return {
    ...start,
    args: ["app-server", "--listen", "stdio://"],
    env: { ...start.env, CODEX_HOME: codexHome }
  };
}
`;

test('private bounded search disables plugins at process startup while preserving isolation', () => {
  const patched = patchBoundedSearchSource(fixture);
  const result = runInNewContext(patched + '\nbuildPrivateCodexAppServerStartOptions({ env: { SAFE: "kept" } }, "private-home")');
  assert.deepEqual(Array.from(result.args.slice(0, 2)), ['-c', 'features.plugins=false']);
  assert.equal(result.args[2], 'app-server');
  assert.equal(result.env.CODEX_HOME, 'private-home');
  assert.equal(result.env.SAFE, 'kept');
  assert.equal(patchBoundedSearchSource(patched), patched);
});

test('the patch refuses an unrecognized or ambiguous upstream implementation', () => {
  assert.throws(() => patchBoundedSearchSource('unrelated code'), /unsupported/iu);
  assert.throws(() => patchBoundedSearchSource(fixture + fixture), /unsupported/iu);
});

for (const packageName of ['openclaw', '@openclaw/codex']) {
  test(`patches the selected ${packageName} package with a dry run and recoverable backup`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'xhs-search-patch-'));
    const file = join(root, 'dist', 'bounded-turn-fixture.js');
    try {
      await mkdir(join(root, 'dist'));
      await writeFile(join(root, 'package.json'), JSON.stringify({ name: packageName, version: '2026.8.2' }));
      await writeFile(file, fixture);
      const preview = await patchInstalledBoundedSearch({ openclawRoot: root });
      assert.equal(preview.status, 'ready');
      assert.equal(preview.packageName, packageName);
      assert.equal(await readFile(file, 'utf8'), fixture);
      await assert.rejects(readFile(preview.backup), { code: 'ENOENT' });

      const result = await patchInstalledBoundedSearch({ openclawRoot: root, apply: true });
      assert.equal(result.status, 'patched');
      assert.equal(await readFile(result.backup, 'utf8'), fixture);
      assert.equal(await readFile(file, 'utf8'), patchBoundedSearchSource(fixture));
      const again = await patchInstalledBoundedSearch({ openclawRoot: root, apply: true });
      assert.equal(again.status, 'already-patched');
      assert.equal(again.packageName, packageName);
      assert.equal(await readFile(result.backup, 'utf8'), fixture);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('rejects unrelated packages even when their module has a matching name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xhs-search-patch-'));
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'unrelated' }));
    await assert.rejects(patchInstalledBoundedSearch({ openclawRoot: root, apply: true }), /not an OpenClaw/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
