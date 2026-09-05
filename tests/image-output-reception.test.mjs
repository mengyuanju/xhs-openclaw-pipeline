import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import sharp from 'sharp';
import { createOpenClawClient } from '../src/openclaw.mjs';
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

// Matches OpenClaw's installed runImageGenerate/writeOutputAsset contract:
// outputs[].path is the published file, including numbered multi-image names.
function openClawSuccess(capability, paths) {
  return { status: 0, stderr: '', stdout: JSON.stringify({
    ok: true, capability, transport: 'local', provider: 'openai', model: 'gpt-image-2',
    attempts: [], outputs: paths.map((path) => ({ path, mimeType: 'image/png' })),
  }) };
}

function openClawFixture(runner) {
  return createOpenClawClient({
    entryPath: 'C:/fake-openclaw/dist/index.js',
    modelApi: { webSearchProvider: 'OPENCLAW', imageModel: 'openai/gpt-image-2' },
    runner: () => assert.fail('image tests must not start the real CLI'),
    asyncRunner: runner,
    asyncSleep: async () => {},
    fetchImpl: () => assert.fail('image tests must not access model APIs'),
  });
}

function requestedImagePath(args) {
  assert.ok(args.includes('--output'));
  return resolve(args[args.indexOf('--output') + 1]);
}

for (const operation of ['generate', 'edit']) {
  test(`OpenClaw ${operation} receives a differently named PNG without replaying image generation`, async (t) => {
    const root = await temporaryRoot(t);
    const outputPath = join(root, 'page-1.png');
    const inputPath = join(root, 'input.png');
    const bytes = await imageBytes();
    await writeFile(inputPath, bytes);
    let calls = 0;
    let requestedPath;
    const client = openClawFixture(async (_command, args) => {
      calls += 1;
      requestedPath = requestedImagePath(args);
      const actual = join(dirname(requestedPath), 'provider-generated-1.png');
      await writeFile(actual, bytes);
      return openClawSuccess(`image.${operation}`, [actual]);
    });
    const result = operation === 'generate'
      ? await client.runImage({ prompt: IMAGE_PROMPT, outputPath })
      : await client.runImageEdit({ prompt: IMAGE_PROMPT, outputPath, inputPaths: [inputPath] });
    assert.equal(calls, 1, 'receiving an existing image must not consume another model call');
    assert.equal(result.outputPath, outputPath);
    assert.deepEqual(await readFile(outputPath), bytes);
    assert.notEqual(dirname(requestedPath), dirname(outputPath), 'each image call must have its own output directory');
    assert.deepEqual(await readFile(inputPath), bytes, 'the edit input must remain unchanged');
  });
}

test('OpenClaw rejects two distinct native outputs without guessing or replaying, and preserves both', async (t) => {
  const root = await temporaryRoot(t);
  const outputPath = join(root, 'page-1.png');
  const bytes = [await imageBytes('#112233'), await imageBytes('#ffeedd')];
  let calls = 0;
  let candidates;
  const client = openClawFixture(async (_command, args) => {
    calls += 1;
    const requested = requestedImagePath(args);
    candidates = [join(dirname(requested), 'raw-1.png'), join(dirname(requested), 'raw-2.png')];
    await Promise.all(candidates.map((path, index) => writeFile(path, bytes[index])));
    return openClawSuccess('image.generate', candidates);
  });
  await assert.rejects(client.runImage({ prompt: IMAGE_PROMPT, outputPath }), /ambiguous|multiple|one|多|候选/iu);
  assert.equal(calls, 1);
  await assert.rejects(readFile(outputPath), { code: 'ENOENT' });
  for (const [index, path] of candidates.entries()) assert.deepEqual(await readFile(path), bytes[index]);
});

test('OpenClaw deduplicates repeated references to the same output file', async (t) => {
  const root = await temporaryRoot(t);
  const bytes = await imageBytes();
  let calls = 0;
  const client = openClawFixture(async (_command, args) => {
    calls += 1;
    const actual = join(dirname(requestedImagePath(args)), 'raw-1.png');
    await writeFile(actual, bytes);
    return openClawSuccess('image.generate', [actual, actual]);
  });
  const outputPath = join(root, 'page-1.png');
  await client.runImage({ prompt: IMAGE_PROMPT, outputPath });
  assert.equal(calls, 1);
  assert.deepEqual(await readFile(outputPath), bytes);
});

for (const invalid of ['fake PNG', 'truncated PNG', 'stale PNG']) {
  test(`OpenClaw refuses ${invalid} at its requested output path without replaying the model`, async (t) => {
    const root = await temporaryRoot(t);
    const validBytes = await imageBytes();
    let calls = 0;
    const client = openClawFixture(async (_command, args) => {
      calls += 1;
      const actual = requestedImagePath(args);
      const bytes = invalid === 'fake PNG' ? Buffer.from('not PNG data')
        : invalid === 'truncated PNG' ? validBytes.subarray(0, Math.floor(validBytes.length / 2)) : validBytes;
      await writeFile(actual, bytes);
      if (invalid === 'stale PNG') await utimes(actual, new Date(0), new Date(0));
      return openClawSuccess('image.generate', [actual]);
    });
    await assert.rejects(client.runImage({ prompt: IMAGE_PROMPT, outputPath: join(root, 'page-1.png') }));
    assert.equal(calls, 1, 'artifact validation failure must not call the provider again');
  });
}

test('OpenClaw does not receive an unrelated file outside the current invocation directory', async (t) => {
  const root = await temporaryRoot(t);
  const externalRoot = await temporaryRoot(t);
  const external = join(externalRoot, 'private.png');
  const bytes = await imageBytes();
  await writeFile(external, bytes);
  let calls = 0;
  const client = openClawFixture(async () => {
    calls += 1;
    return openClawSuccess('image.generate', [external]);
  });
  const outputPath = join(root, 'page-1.png');
  await assert.rejects(client.runImage({ prompt: IMAGE_PROMPT, outputPath }));
  assert.equal(calls, 1);
  await assert.rejects(readFile(outputPath), { code: 'ENOENT' });
  assert.deepEqual(await readFile(external), bytes);
});

test('OpenClaw never mistakes a pre-existing business output for this invocation succeeding', async (t) => {
  const root = await temporaryRoot(t);
  const outputPath = join(root, 'page-1.png');
  const oldBytes = await imageBytes();
  await writeFile(outputPath, oldBytes);
  await utimes(outputPath, new Date(0), new Date(0));
  const client = openClawFixture(async () => openClawSuccess('image.generate', []));
  await assert.rejects(client.runImage({ prompt: IMAGE_PROMPT, outputPath }));
  assert.deepEqual(await readFile(outputPath), oldBytes);
});

test('OpenClaw retains a generated image when publishing to the business output fails', async (t) => {
  const root = await temporaryRoot(t);
  const outputPath = join(root, 'occupied.png');
  await mkdir(outputPath);
  const bytes = await imageBytes();
  let calls = 0;
  let candidate;
  const client = openClawFixture(async (_command, args) => {
    calls += 1;
    candidate = join(dirname(requestedImagePath(args)), 'provider-output.png');
    await writeFile(candidate, bytes);
    return openClawSuccess('image.generate', [candidate]);
  });
  await assert.rejects(client.runImage({ prompt: IMAGE_PROMPT, outputPath }));
  assert.equal(calls, 1, 'publishing I/O errors must not replay image generation');
  assert.deepEqual(await readFile(candidate), bytes);
});

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
    executable: 'fake-codex', environment: { CODEX_HOME: root, XHS_WEB_SEARCH_PROVIDER: 'OPENCLAW' },
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
