import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import sharp from 'sharp';
import { createCodexClient } from '../src/codex.mjs';
import { parseCodexOutput } from '../src/codex-protocol.mjs';

const IMAGE_PROMPT = 'Generate a clear portrait infographic for this page.';

function imageBytes(color = '#aabbcc') {
  return sharp({ create: { width: 24, height: 32, channels: 3, background: color } }).png().toBuffer();
}

async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'xhs-image-reception-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function codexSuccess(images) {
  return { status: 0, stderr: '', stdout: [
    { type: 'thread.started', thread_id: 'reception-test' },
    ...images.map((item) => ({ type: 'item.completed', item })),
    { type: 'turn.completed' },
  ].map(JSON.stringify).join('\n') };
}

function nativeImage(id, path) {
  return { type: 'image_generation', id, status: 'completed', saved_path: path };
}

function codexFixture(t, root, runner) {
  const invocationDirectories = new Set();
  t.after(async () => {
    for (const directory of invocationDirectories) {
      const child = relative(resolve(tmpdir()), directory);
      assert.ok(child && !child.startsWith('..') && basename(directory).startsWith('xhs-codex-'));
      await rm(directory, { recursive: true, force: true });
    }
  });
  return createCodexClient({
    executable: 'fake-codex', environment: { CODEX_HOME: root, XHS_WEB_SEARCH_PROVIDER: 'CODEX' },
    runtime: { run: (operation) => operation({ onSpawn() {} }), assertAvailable() {} },
    runner: () => assert.fail('image tests must not start the real Codex CLI'),
    asyncRunner: async (command, args, options) => {
      invocationDirectories.add(resolve(options.cwd));
      return runner(command, args, options);
    },
    fetchImpl: () => assert.fail('image tests must not access model APIs'),
  });
}

test('Codex protocol deduplicates repeated native completion of the same id and path', () => {
  const item = nativeImage('image-1', resolve('native-image.png'));
  const parsed = parseCodexOutput(codexSuccess([item, { ...item }]).stdout, { requireText: false });
  assert.deepEqual(parsed.images, [{ id: item.id, path: item.saved_path }]);
});

test('Codex receives a valid image despite a duplicate native completion event', async (t) => {
  const root = await temporaryRoot(t);
  const bytes = await imageBytes();
  let calls = 0;
  const client = codexFixture(t, root, async (_command, _args, options) => {
    calls += 1;
    const path = join(options.cwd, 'native.png');
    await writeFile(path, bytes);
    const item = nativeImage('image-1', path);
    return codexSuccess([item, { ...item }]);
  });
  const outputPath = join(root, 'page-1.png');
  await client.runImage({ prompt: IMAGE_PROMPT, outputPath });
  assert.equal(calls, 1);
  assert.deepEqual(await readFile(outputPath), bytes);
});

for (const sameId of [false, true]) {
  test(`Codex rejects different native candidate paths with ${sameId ? 'conflicting' : 'distinct'} ids and preserves both`, async (t) => {
    const root = await temporaryRoot(t);
    const bytes = [await imageBytes('#112233'), await imageBytes('#ffeedd')];
    let calls = 0;
    let candidates;
    const client = codexFixture(t, root, async (_command, _args, options) => {
      calls += 1;
      candidates = [join(options.cwd, 'candidate-1.png'), join(options.cwd, 'candidate-2.png')];
      await Promise.all(candidates.map((path, index) => writeFile(path, bytes[index])));
      return codexSuccess(candidates.map((path, index) => nativeImage(sameId ? 'image-1' : `image-${index + 1}`, path)));
    });
    const outputPath = join(root, 'page-1.png');
    await assert.rejects(client.runImage({ prompt: IMAGE_PROMPT, outputPath }), { code: 'CODEX_IMAGE_UNVERIFIED' });
    assert.equal(calls, 1);
    await assert.rejects(readFile(outputPath), { code: 'ENOENT' });
    for (const [index, path] of candidates.entries()) assert.deepEqual(await readFile(path), bytes[index]);
  });
}

test('Codex retains the native image on publishing I/O failure without replaying the model', async (t) => {
  const root = await temporaryRoot(t);
  const bytes = await imageBytes();
  const outputPath = join(root, 'occupied.png');
  await mkdir(outputPath);
  let calls = 0;
  let candidate;
  const client = codexFixture(t, root, async (_command, _args, options) => {
    calls += 1;
    candidate = join(options.cwd, 'native.png');
    await writeFile(candidate, bytes);
    return codexSuccess([nativeImage('image-1', candidate)]);
  });
  await assert.rejects(client.runImage({ prompt: IMAGE_PROMPT, outputPath }), { code: 'CODEX_IMAGE_UNVERIFIED' });
  assert.equal(calls, 1);
  assert.deepEqual(await readFile(candidate), bytes);
});

test('Codex removes reference copies when preparing one of several edit attachments fails', async (t) => {
  const root = await temporaryRoot(t);
  const inputPath = join(root, 'private-reference.png');
  const bytes = await imageBytes();
  await writeFile(inputPath, bytes);
  const client = codexFixture(t, root, () => assert.fail('invalid attachments must fail before model invocation'));
  let recoveryDirectory;
  await assert.rejects(client.runImageEdit({
    prompt: IMAGE_PROMPT,
    inputPaths: [inputPath, join(root, 'missing-reference.png')],
    outputPath: join(root, 'edited.png'),
  }), (error) => {
    recoveryDirectory = error.recoveryDirectory;
    return error.code === 'CODEX_IMAGE_UNVERIFIED';
  });
  if (recoveryDirectory) {
    const child = relative(resolve(tmpdir()), resolve(recoveryDirectory));
    assert.ok(child && !child.startsWith('..') && basename(recoveryDirectory).startsWith('xhs-codex-'));
    t.after(() => rm(recoveryDirectory, { recursive: true, force: true }));
    // Give a concurrently dispatched Sharp write time to settle after another
    // input rejects; cleanup must also cover writes still in flight at failure.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await assert.rejects(readFile(join(recoveryDirectory, 'input-1.png')), { code: 'ENOENT' });
  }
  assert.deepEqual(await readFile(inputPath), bytes);
});
