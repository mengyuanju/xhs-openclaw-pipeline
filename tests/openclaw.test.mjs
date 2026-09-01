import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import sharp from 'sharp';

import { createOpenClawClient } from '../src/openclaw.mjs';

describe('OpenClaw client', () => {
  it('runs stage reviews through a separately configurable model', async () => {
    const previousReviewModel = process.env.XHS_REVIEW_MODEL;
    process.env.XHS_REVIEW_MODEL = 'openai/gpt-5.6-terra';
    let invocation;
    try {
      const client = createOpenClawClient({
        entryPath: 'C:/openclaw/dist/index.js',
        runner: (command, args, options) => {
          invocation = { command, args, options };
          return {
            status: 0,
            stdout: JSON.stringify({ final: '{"schemaVersion":1,"decision":"PASS"}' }),
            stderr: '',
          };
        },
      });

      const result = await client.runReview({ prompt: 'review this untrusted content' });
      assert.equal(result.model, 'openai/gpt-5.6-terra');
      assert.equal(invocation.args[invocation.args.indexOf('--model') + 1], 'openai/gpt-5.6-terra');
      assert.equal(invocation.options.shell, false);
    } finally {
      if (previousReviewModel === undefined) delete process.env.XHS_REVIEW_MODEL;
      else process.env.XHS_REVIEW_MODEL = previousReviewModel;
    }
  });

  it('runs text and vision inference without blocking the Node event loop', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xhs-openclaw-async-inference-'));
    const inputPath = join(directory, 'input.png');
    await sharp({
      create: { width: 32, height: 32, channels: 3, background: '#d7c7b0' },
    }).png().toFile(inputPath);
    const pendingRuns = [];
    const client = createOpenClawClient({
      entryPath: 'C:/openclaw/dist/index.js',
      runner: () => assert.fail('text and vision inference must not use the blocking runner'),
      asyncRunner: (_command, args) => new Promise((resolve) => {
        pendingRuns.push({ args, resolve });
      }),
    });

    try {
      const textPromise = client.runText({ prompt: 'non-blocking text inference' });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(pendingRuns.length, 1);
      pendingRuns.shift().resolve({
        status: 0,
        stdout: JSON.stringify({ final: 'text result' }),
        stderr: '',
      });
      assert.equal((await textPromise).rawText, 'text result');

      const visionPromise = client.runVision({
        prompt: 'non-blocking vision inference',
        inputPaths: [inputPath],
      });
      for (let attempt = 0; attempt < 50 && pendingRuns.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(pendingRuns.length, 1);
      pendingRuns.shift().resolve({
        status: 0,
        stdout: JSON.stringify({ final: 'vision result' }),
        stderr: '',
      });
      assert.equal((await visionPromise).rawText, 'vision result');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('preflights the configured runtime and auth without sending an inference prompt', () => {
    let invocation;
    const client = createOpenClawClient({
      entryPath: 'C:/openclaw/dist/index.js',
      runner: (command, args, options) => {
        invocation = { command, args, options };
        return {
          status: 0,
          stdout: JSON.stringify({ auth: { providers: [] } }),
          stderr: '',
        };
      },
    });

    const result = client.checkReady({
      textModel: 'openai/gpt-5.6-sol',
      imageModel: 'openai/gpt-image-2',
    });

    assert.equal(invocation.command, process.execPath);
    assert.deepEqual(invocation.args, [
      'C:/openclaw/dist/index.js',
      'models',
      'status',
      '--check',
      '--json',
    ]);
    assert.equal(invocation.options.shell, false);
    assert.equal(invocation.options.timeout, 120_000);
    assert.doesNotMatch(invocation.args.join(' '), /prompt|infer|image generate/u);
    assert.deepEqual(result, {
      textModel: 'openai/gpt-5.6-sol',
      imageModel: 'openai/gpt-image-2',
    });
  });

  it('rejects legacy provider ids before starting OpenClaw', () => {
    let calls = 0;
    const client = createOpenClawClient({
      entryPath: 'C:/openclaw/dist/index.js',
      runner: () => {
        calls += 1;
        return { status: 0, stdout: '{}', stderr: '' };
      },
    });

    assert.throws(
      () => client.checkReady({
        textModel: 'openai-codex/gpt-5.4-mini',
        imageModel: 'openai/gpt-image-2',
      }),
      /legacy provider.*openai-codex/iu,
    );
    assert.equal(calls, 0);
  });

  it('runs OpenClaw through the Node runtime configured in the environment', async () => {
    const previousNodePath = process.env.OPENCLAW_NODE_PATH;
    process.env.OPENCLAW_NODE_PATH = 'C:/runtime/node.exe';
    let invocation;
    try {
      const client = createOpenClawClient({
        entryPath: 'C:/openclaw/dist/index.js',
        runner: (command, args, options) => {
          invocation = { command, args, options };
          return {
            status: 0,
            stdout: JSON.stringify({ final: 'compatible runtime' }),
            stderr: '',
          };
        },
      });
      await client.runText({ prompt: 'hello' });
    } finally {
      if (previousNodePath === undefined) delete process.env.OPENCLAW_NODE_PATH;
      else process.env.OPENCLAW_NODE_PATH = previousNodePath;
    }

    assert.equal(invocation.command, 'C:/runtime/node.exe');
    assert.equal(invocation.options.shell, false);
  });

  it('does not inject the image-only proxy into text inference', async () => {
    const previousProxyUrl = process.env.XHS_IMAGE_PROXY_URL;
    process.env.XHS_IMAGE_PROXY_URL = 'http://127.0.0.1:7897';
    let invocation;
    try {
      const client = createOpenClawClient({
        entryPath: 'C:/openclaw/dist/index.js',
        runner: (command, args, options) => {
          invocation = { command, args, options };
          return {
            status: 0,
            stdout: JSON.stringify({ final: 'text without image proxy' }),
            stderr: '',
          };
        },
      });
      await client.runText({ prompt: 'hello' });
    } finally {
      if (previousProxyUrl === undefined) delete process.env.XHS_IMAGE_PROXY_URL;
      else process.env.XHS_IMAGE_PROXY_URL = previousProxyUrl;
    }

    assert.equal(invocation.options.env, undefined);
  });

  it('uses the model proxy first and falls back to direct text transport', async () => {
    const previousProxyUrl = process.env.XHS_MODEL_PROXY_URL;
    process.env.XHS_MODEL_PROXY_URL = 'http://127.0.0.1:7897';
    const invocations = [];
    const client = createOpenClawClient({
      entryPath: 'C:/openclaw/dist/index.js',
      sleep: () => {},
      runner: (_command, _args, options) => {
        invocations.push(options);
        if (invocations.length === 1) {
          return { status: 1, stdout: '', stderr: 'fetch failed: ECONNRESET' };
        }
        return { status: 0, stdout: JSON.stringify({ final: 'direct fallback' }), stderr: '' };
      },
    });

    try {
      const result = await client.runText({ prompt: 'try the configured model proxy first' });
      assert.equal(result.rawText, 'direct fallback');
      assert.equal(invocations[0].env.HTTPS_PROXY, 'http://127.0.0.1:7897');
      assert.equal(invocations[1].env, undefined);
    } finally {
      if (previousProxyUrl === undefined) delete process.env.XHS_MODEL_PROXY_URL;
      else process.env.XHS_MODEL_PROXY_URL = previousProxyUrl;
    }
  });

  it('uses the canonical current OpenAI model when no override is configured', async () => {
    const previousModel = process.env.XHS_TEXT_MODEL;
    delete process.env.XHS_TEXT_MODEL;
    let invocation;
    let result;
    try {
      const client = createOpenClawClient({
        entryPath: 'C:/openclaw/dist/index.js',
        runner: (command, args, options) => {
          invocation = { command, args, options };
          return {
            status: 0,
            stdout: JSON.stringify({ final: 'current model' }),
            stderr: '',
          };
        },
      });
      result = await client.runText({ prompt: 'hello' });
    } finally {
      if (previousModel === undefined) delete process.env.XHS_TEXT_MODEL;
      else process.env.XHS_TEXT_MODEL = previousModel;
    }

    const modelFlag = invocation.args.indexOf('--model');
    const thinkingFlag = invocation.args.indexOf('--thinking');
    assert.equal(invocation.args[modelFlag + 1], 'openai/gpt-5.6-sol');
    assert.equal(invocation.args[thinkingFlag + 1], 'high');
    assert.equal(result.model, 'openai/gpt-5.6-sol');
    assert.equal(result.thinking, 'high');
  });

  it('passes the prompt as one argument without enabling a shell', async () => {
    let invocation;
    const client = createOpenClawClient({
      entryPath: 'C:/openclaw/dist/index.js',
      runner: (command, args, options) => {
        invocation = { command, args, options };
        return {
          status: 0,
          stdout: JSON.stringify({ final: '{"ok":true}' }),
          stderr: '',
        };
      },
    });

    const result = await client.runText({
      model: 'openai/gpt-5.6-sol',
      prompt: 'query with & | > shell characters',
    });

    assert.equal(invocation.command, process.execPath);
    assert.equal(invocation.options.shell, false);
    assert.equal(invocation.args.at(-1), 'query with & | > shell characters');
    assert.deepEqual(result, {
      rawText: '{"ok":true}',
      model: 'openai/gpt-5.6-sol',
      thinking: 'high',
    });
  });

  it('redacts credential-looking text from OpenClaw failures', async () => {
    const client = createOpenClawClient({
      entryPath: 'C:/openclaw/dist/index.js',
      runner: () => ({
        status: 1,
        stdout: '',
        stderr: 'request failed with sk-abcdefghijklmnop',
      }),
    });

    await assert.rejects(
      client.runText({ model: 'openai/gpt-5.6-sol', prompt: 'hello' }),
      (error) => {
        assert.doesNotMatch(error.message, /sk-abcdefghijklmnop/);
        assert.match(error.message, /REDACTED/);
        return true;
      },
    );
  });

  it('preserves provider diagnostics ahead of a long failed command', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xhs-openclaw-error-summary-'));
    const inputPath = join(directory, 'input.png');
    await sharp({
      create: { width: 32, height: 32, channels: 3, background: '#d7c7b0' },
    }).png().toFile(inputPath);
    const client = createOpenClawClient({
      entryPath: 'C:/openclaw/dist/index.js',
      sleep: () => {},
      runner: () => ({
        status: 1,
        stdout: '',
        stderr: 'provider transport failed: UND_ERR_SOCKET ECONNRESET',
        error: new Error(`Command failed: node infer --prompt ${'very long prompt '.repeat(500)}`),
      }),
    });

    try {
      await assert.rejects(
        client.runVision({ prompt: 'summarize the provider failure', inputPaths: [inputPath] }),
        (error) => {
          assert.match(error.message, /UND_ERR_SOCKET ECONNRESET/u);
          return true;
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('retries bounded transient text transport failures with backoff', async () => {
    const delays = [];
    let calls = 0;
    const client = createOpenClawClient({
      entryPath: 'C:/openclaw/dist/index.js',
      sleep: (milliseconds) => delays.push(milliseconds),
      runner: () => {
        calls += 1;
        if (calls < 4) {
          return {
            status: 1,
            stdout: '',
            stderr: 'TypeError: fetch failed causeCode=ECONNRESET message=Connection error.',
          };
        }
        return { status: 0, stdout: JSON.stringify({ final: 'recovered' }), stderr: '' };
      },
    });

    const result = await client.runText({ prompt: 'retry a transient connection failure' });

    assert.equal(result.rawText, 'recovered');
    assert.equal(calls, 4);
    assert.deepEqual(delays, [5_000, 15_000, 30_000]);
  });

  it('reduces thinking effort when retrying a terminated text stream', async () => {
    const delays = [];
    const thinkingAttempts = [];
    const client = createOpenClawClient({
      entryPath: 'C:/openclaw/dist/index.js',
      sleep: (milliseconds) => delays.push(milliseconds),
      runner: (_command, args) => {
        const thinking = args[args.indexOf('--thinking') + 1];
        thinkingAttempts.push(thinking);
        if (thinking !== 'low') {
          return {
            status: 1,
            stdout: '',
            stderr: 'No text output returned: UND_ERR_SOCKET terminated',
          };
        }
        return { status: 0, stdout: JSON.stringify({ final: 'recovered at low effort' }), stderr: '' };
      },
    });

    const result = await client.runText({ prompt: 'recover a terminated response stream' });

    assert.deepEqual(thinkingAttempts, ['high', 'medium', 'low']);
    assert.deepEqual(delays, [5_000, 15_000]);
    assert.equal(result.rawText, 'recovered at low effort');
    assert.equal(result.thinking, 'low');
  });

  it('keeps an explicit low thinking effort stable across transport retries', async () => {
    const thinkingAttempts = [];
    const client = createOpenClawClient({
      entryPath: 'C:/openclaw/dist/index.js',
      sleep: () => {},
      runner: (_command, args) => {
        const thinking = args[args.indexOf('--thinking') + 1];
        thinkingAttempts.push(thinking);
        if (thinkingAttempts.length < 3) {
          return {
            status: 1,
            stdout: '',
            stderr: 'UND_ERR_SOCKET terminated',
          };
        }
        return { status: 0, stdout: JSON.stringify({ final: 'stable at low effort' }), stderr: '' };
      },
    });

    const result = await client.runText({
      prompt: 'keep a stable thinking effort',
      thinking: 'low',
    });

    assert.deepEqual(thinkingAttempts, ['low', 'low', 'low']);
    assert.equal(result.thinking, 'low');
  });

  it('does not retry deterministic model errors', async () => {
    let calls = 0;
    const client = createOpenClawClient({
      entryPath: 'C:/openclaw/dist/index.js',
      sleep: () => assert.fail('deterministic failures must not sleep'),
      runner: () => {
        calls += 1;
        return { status: 1, stdout: '', stderr: 'Error: Unknown model: invalid/model' };
      },
    });

    await assert.rejects(client.runText({ prompt: 'do not retry this failure' }), /Unknown model/);
    assert.equal(calls, 1);
  });

  it('preserves the spawn timeout when OpenClaw also writes informational stderr', async () => {
    let calls = 0;
    const client = createOpenClawClient({
      entryPath: 'C:/openclaw/dist/index.js',
      runner: () => {
        calls += 1;
        return {
          status: null,
          stdout: '',
          stderr: '[image-generation/openai] image auth selected: provider=openai mode=oauth',
          error: Object.assign(new Error('spawnSync node ETIMEDOUT'), { code: 'ETIMEDOUT' }),
        };
      },
      sleep: () => assert.fail('a full child-process timeout must not retry within the same task lease'),
    });

    await assert.rejects(
      client.runImage({
        prompt: 'generate an image that reaches the process timeout',
        outputPath: 'C:/tmp/timed-out.png',
      }),
      (error) => {
        assert.match(error.message, /ETIMEDOUT/u);
        assert.match(error.message, /image auth selected/u);
        return true;
      },
    );
    assert.equal(calls, 1);
  });

  it('removes a partial image before retrying a transient socket failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xhs-openclaw-image-retry-'));
    const outputPath = join(directory, 'raw.png');
    const delays = [];
    let calls = 0;
    const client = createOpenClawClient({
      entryPath: 'C:/openclaw/dist/index.js',
      sleep: (milliseconds) => delays.push(milliseconds),
      runner: () => {
        calls += 1;
        if (calls === 1) {
          writeFileSync(outputPath, 'partial');
          return { status: 1, stdout: '', stderr: 'terminated | other side closed | UND_ERR_SOCKET' };
        }
        assert.equal(existsSync(outputPath), false, 'partial output must be removed before retry');
        writeFileSync(outputPath, 'complete');
        return { status: 0, stdout: '{"ok":true}', stderr: '' };
      },
    });

    try {
      const result = await client.runImage({
        prompt: 'generate a bounded retry image',
        outputPath,
      });
      assert.equal(result.outputPath, outputPath);
      assert.equal(readFileSync(outputPath, 'utf8'), 'complete');
      assert.equal(calls, 2);
      assert.deepEqual(delays, [5_000]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('retries when image editing exits successfully without creating its output file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xhs-openclaw-missing-image-retry-'));
    const inputPath = join(directory, 'input.png');
    const outputPath = join(directory, 'edited.png');
    const delays = [];
    let calls = 0;
    writeFileSync(inputPath, 'input');
    const client = createOpenClawClient({
      entryPath: 'C:/openclaw/dist/index.js',
      sleep: (milliseconds) => delays.push(milliseconds),
      runner: () => {
        calls += 1;
        if (calls === 2) writeFileSync(outputPath, 'complete');
        return { status: 0, stdout: '{"ok":true}', stderr: '' };
      },
    });

    try {
      const result = await client.runImageEdit({
        prompt: 'edit the image and require a real output file',
        inputPaths: [inputPath],
        outputPath,
      });
      assert.equal(result.outputPath, outputPath);
      assert.equal(readFileSync(outputPath, 'utf8'), 'complete');
      assert.equal(calls, 2);
      assert.deepEqual(delays, [5_000]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('falls back to direct image transport after the configured proxy resets the connection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xhs-openclaw-proxy-fallback-'));
    const outputPath = join(directory, 'raw.png');
    const previousProxyUrl = process.env.XHS_IMAGE_PROXY_URL;
    process.env.XHS_IMAGE_PROXY_URL = 'http://127.0.0.1:7897';
    const invocations = [];
    const client = createOpenClawClient({
      entryPath: 'C:/openclaw/dist/index.js',
      sleep: () => {},
      runner: (command, args, options) => {
        invocations.push({ command, args, options });
        if (options.env?.HTTPS_PROXY) {
          return { status: 1, stdout: '', stderr: 'fetch failed: ECONNRESET before TLS' };
        }
        writeFileSync(outputPath, 'direct connection image');
        return { status: 0, stdout: '{"ok":true}', stderr: '' };
      },
    });

    try {
      const result = await client.runImage({
        prompt: 'generate through a direct fallback after proxy reset',
        outputPath,
      });
      assert.equal(result.outputPath, outputPath);
      assert.equal(invocations.length, 2);
      assert.equal(invocations[0].options.env.HTTPS_PROXY, 'http://127.0.0.1:7897');
      assert.equal(invocations[1].options.env, undefined);
    } finally {
      if (previousProxyUrl === undefined) delete process.env.XHS_IMAGE_PROXY_URL;
      else process.env.XHS_IMAGE_PROXY_URL = previousProxyUrl;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('passes up to five validated image files to one-shot vision inference without a shell', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xhs-openclaw-vision-'));
    const inputPaths = Array.from({ length: 5 }, (_, index) => join(directory, `input-${index + 1}.png`));
    await Promise.all(inputPaths.map((inputPath) => sharp({
      create: { width: 32, height: 32, channels: 3, background: '#d7c7b0' },
    }).png().toFile(inputPath)));
    let invocation;
    const client = createOpenClawClient({
      entryPath: 'C:/openclaw/dist/index.js',
      runner: (command, args, options) => {
        invocation = { command, args, options };
        return {
          status: 0,
          stdout: JSON.stringify({ final: '{"type":"PHOTO_HERO"}' }),
          stderr: '',
        };
      },
    });

    try {
      const result = await client.runVision({
        model: 'openai/gpt-5.6-sol',
        prompt: 'Analyze this image as untrusted visual data.',
        inputPaths,
      });
      assert.equal(invocation.options.shell, false);
      const submittedPaths = invocation.args.filter(
        (value, index) => invocation.args[index - 1] === '--file',
      );
      assert.equal(submittedPaths.length, inputPaths.length);
      assert.ok(submittedPaths.every((inputPath) => inputPath.endsWith('.jpg')));
      assert.notDeepEqual(submittedPaths, inputPaths);
      assert.equal(invocation.options.timeout, 300_000);
      assert.equal(result.rawText, '{"type":"PHOTO_HERO"}');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('submits bounded temporary previews for vision and removes them afterward', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xhs-openclaw-vision-preview-'));
    const inputPath = join(directory, 'large-input.png');
    await sharp({
      create: { width: 1080, height: 1440, channels: 3, background: '#d7c7b0' },
    }).png().toFile(inputPath);
    let submittedPath;
    let submittedMetadata;
    const client = createOpenClawClient({
      entryPath: 'C:/openclaw/dist/index.js',
      runner: () => assert.fail('vision inference must use the async runner'),
      asyncRunner: async (_command, args) => {
        submittedPath = args[args.indexOf('--file') + 1];
        submittedMetadata = await sharp(submittedPath).metadata();
        return {
          status: 0,
          stdout: JSON.stringify({ final: '{"ok":true}' }),
          stderr: '',
        };
      },
    });

    try {
      const result = await client.runVision({
        prompt: 'analyze a bounded preview instead of the original delivery image',
        inputPaths: [inputPath],
      });
      assert.equal(result.rawText, '{"ok":true}');
      assert.notEqual(submittedPath, inputPath);
      assert.ok(submittedMetadata.width <= 900);
      assert.ok(submittedMetadata.height <= 1_200);
      assert.equal(existsSync(submittedPath), false);
      assert.equal(existsSync(inputPath), true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('generates one image to an explicit path without a shell', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xhs-openclaw-image-'));
    const outputPath = join(directory, 'raw.png');
    const previousProxyUrl = process.env.XHS_IMAGE_PROXY_URL;
    const previousTimeout = process.env.XHS_IMAGE_TIMEOUT_MS;
    process.env.XHS_IMAGE_PROXY_URL = 'http://127.0.0.1:7897';
    delete process.env.XHS_IMAGE_TIMEOUT_MS;
    let invocation;
    const client = createOpenClawClient({
      entryPath: 'C:/openclaw/dist/index.js',
      runner: (command, args, options) => {
        invocation = { command, args, options };
        writeFileSync(outputPath, Buffer.from('fake image'));
        return { status: 0, stdout: JSON.stringify({ ok: true, outputs: [{ path: outputPath }] }), stderr: '' };
      },
    });

    try {
      const result = await client.runImage({
        model: 'openai/gpt-image-2',
        prompt: 'a clean desk & no visible text',
        outputPath,
      });

      assert.equal(invocation.options.shell, false);
      assert.equal(invocation.args.at(-1), 'a clean desk & no visible text');
      assert.match(invocation.args.join(' '), /--count 1/);
      assert.match(invocation.args.join(' '), /--size 1152x1536/u);
      assert.equal(result.outputPath, outputPath);
      assert.equal(result.model, 'openai/gpt-image-2');
    } finally {
      if (previousProxyUrl === undefined) delete process.env.XHS_IMAGE_PROXY_URL;
      else process.env.XHS_IMAGE_PROXY_URL = previousProxyUrl;
      if (previousTimeout === undefined) delete process.env.XHS_IMAGE_TIMEOUT_MS;
      else process.env.XHS_IMAGE_TIMEOUT_MS = previousTimeout;
      await rm(directory, { recursive: true, force: true });
    }

    assert.equal(invocation.options.env.HTTP_PROXY, 'http://127.0.0.1:7897');
    assert.equal(invocation.options.env.HTTPS_PROXY, 'http://127.0.0.1:7897');
    const timeoutIndex = invocation.args.indexOf('--timeout-ms');
    assert.equal(invocation.args[timeoutIndex + 1], '300000');
    assert.equal(invocation.options.timeout, 310000);
  });

  it('starts independent image CLI processes concurrently through the async runner', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xhs-openclaw-image-concurrency-'));
    const outputPaths = [join(directory, 'first.png'), join(directory, 'second.png')];
    let active = 0;
    let maxActive = 0;
    let started = 0;
    let releaseCalls;
    let signalStarted;
    const callsStarted = new Promise((resolve) => { signalStarted = resolve; });
    const gate = new Promise((resolve) => { releaseCalls = resolve; });
    const client = createOpenClawClient({
      entryPath: 'C:/openclaw/dist/index.js',
      runner: () => assert.fail('image generation must not use the blocking runner'),
      asyncRunner: async (_command, args, options) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        started += 1;
        if (started === 2) signalStarted();
        await gate;
        const outputPath = args[args.indexOf('--output') + 1];
        writeFileSync(outputPath, 'generated');
        active -= 1;
        return { status: 0, stdout: '{"ok":true}', stderr: '', options };
      },
    });

    const pending = outputPaths.map((outputPath, index) => Promise.resolve().then(() => client.runImage({
      prompt: `concurrent image prompt number ${index + 1}`,
      outputPath,
    })));
    const signal = await Promise.race([
      callsStarted.then(() => 'started'),
      Promise.all(pending).then(() => 'completed', () => 'failed'),
    ]);
    releaseCalls();

    try {
      assert.equal(signal, 'started');
      const results = await Promise.all(pending);
      assert.equal(maxActive, 2);
      assert.deepEqual(results.map(({ outputPath }) => outputPath), outputPaths);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('edits an image with repeated file arguments and no shell', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xhs-openclaw-edit-'));
    const firstInput = join(directory, 'first.png');
    const secondInput = join(directory, 'second.png');
    const outputPath = join(directory, 'edited.png');
    const previousProxyUrl = process.env.XHS_IMAGE_PROXY_URL;
    process.env.XHS_IMAGE_PROXY_URL = 'http://127.0.0.1:7897';
    writeFileSync(firstInput, 'first');
    writeFileSync(secondInput, 'second');
    let invocation;
    const client = createOpenClawClient({
      entryPath: 'C:/openclaw/dist/index.js',
      runner: (command, args, options) => {
        invocation = { command, args, options };
        writeFileSync(outputPath, Buffer.from('edited image'));
        return { status: 0, stdout: '{"ok":true}', stderr: '' };
      },
    });

    try {
      const result = await client.runImageEdit({
        prompt: '保持主体不变，把背景调整得更干净自然',
        inputPaths: [firstInput, secondInput],
        outputPath,
      });
      assert.equal(invocation.options.shell, false);
      assert.deepEqual(
        invocation.args.filter((value, index) => invocation.args[index - 1] === '--file'),
        [firstInput, secondInput],
      );
      assert.match(invocation.args.join(' '), /--size 1152x1536/u);
      assert.equal(result.outputPath, outputPath);
    } finally {
      if (previousProxyUrl === undefined) delete process.env.XHS_IMAGE_PROXY_URL;
      else process.env.XHS_IMAGE_PROXY_URL = previousProxyUrl;
      await rm(directory, { recursive: true, force: true });
    }

    assert.equal(invocation.options.env.HTTP_PROXY, 'http://127.0.0.1:7897');
    assert.equal(invocation.options.env.HTTPS_PROXY, 'http://127.0.0.1:7897');
  });

  it('uses the configured long timeout for image editing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xhs-openclaw-image-timeout-'));
    const inputPath = join(directory, 'input.png');
    const outputPath = join(directory, 'edited.png');
    const previousTimeout = process.env.XHS_IMAGE_TIMEOUT_MS;
    process.env.XHS_IMAGE_TIMEOUT_MS = '420000';
    writeFileSync(inputPath, 'input');
    let invocation;
    const client = createOpenClawClient({
      entryPath: 'C:/openclaw/dist/index.js',
      runner: (command, args, options) => {
        invocation = { command, args, options };
        writeFileSync(outputPath, 'edited');
        return { status: 0, stdout: '{"ok":true}', stderr: '' };
      },
    });

    try {
      await client.runImageEdit({
        prompt: 'edit this image with a deliberately long model timeout',
        inputPaths: [inputPath],
        outputPath,
      });
    } finally {
      if (previousTimeout === undefined) delete process.env.XHS_IMAGE_TIMEOUT_MS;
      else process.env.XHS_IMAGE_TIMEOUT_MS = previousTimeout;
      await rm(directory, { recursive: true, force: true });
    }

    const timeoutIndex = invocation.args.indexOf('--timeout-ms');
    assert.equal(invocation.args[timeoutIndex + 1], '420000');
    assert.equal(invocation.options.timeout, 430000);
  });

  it('runs web search through the configured OpenClaw capability without a shell', async () => {
    const previousProxyUrl = process.env.XHS_MODEL_PROXY_URL;
    process.env.XHS_MODEL_PROXY_URL = 'http://127.0.0.1:7897';
    let invocation;
    const client = createOpenClawClient({
      entryPath: 'C:/openclaw/dist/index.js',
      runner: (command, args, options) => {
        invocation = { command, args, options };
        return {
          status: 0,
          stdout: JSON.stringify({
            ok: true,
            provider: 'duckduckgo',
            outputs: [{ result: { results: [{ title: 'Source', url: 'https://example.com' }] } }],
          }),
          stderr: '',
        };
      },
    });

    try {
      const result = await client.runWebSearch({
        query: 'query with & | > shell characters',
        provider: 'duckduckgo',
        limit: 3,
      });

      assert.equal(invocation.command, process.execPath);
      assert.equal(invocation.options.shell, false);
      assert.deepEqual(invocation.args, [
        'C:/openclaw/dist/index.js',
        'infer',
        'web',
        'search',
        '--provider',
        'duckduckgo',
        '--query',
        'query with & | > shell characters',
        '--limit',
        '3',
        '--json',
      ]);
      assert.equal(invocation.options.env.HTTPS_PROXY, 'http://127.0.0.1:7897');
      assert.equal(result.provider, 'duckduckgo');
      assert.equal(result.result.results[0].url, 'https://example.com');
    } finally {
      if (previousProxyUrl === undefined) delete process.env.XHS_MODEL_PROXY_URL;
      else process.env.XHS_MODEL_PROXY_URL = previousProxyUrl;
    }
  });

  it('retries transient Codex web-search transport failures before falling back', async () => {
    let calls = 0;
    const delays = [];
    const client = createOpenClawClient({
      entryPath: 'C:/openclaw/dist/index.js',
      runner: () => {
        calls += 1;
        if (calls === 1) {
          return { status: 1, stdout: '', stderr: 'Error: Reconnecting... 2/5' };
        }
        return {
          status: 0,
          stdout: JSON.stringify({
            provider: 'codex',
            outputs: [{ result: { results: [{ url: 'https://example.com/source' }] } }],
          }),
          stderr: '',
        };
      },
      asyncSleep: async (milliseconds) => { delays.push(milliseconds); },
    });

    const result = await client.runWebSearch({ query: '需要核验的主题', provider: 'codex' });

    assert.equal(calls, 2);
    assert.deepEqual(delays, [5_000]);
    assert.equal(result.provider, 'codex');
  });

  it('validates web search input before starting OpenClaw', async () => {
    let calls = 0;
    const client = createOpenClawClient({
      entryPath: 'C:/openclaw/dist/index.js',
      runner: () => {
        calls += 1;
        return { status: 0, stdout: '{}', stderr: '' };
      },
    });

    await assert.rejects(client.runWebSearch({ query: '', provider: 'codex' }), /query/iu);
    await assert.rejects(client.runWebSearch({ query: 'topic', provider: 'bad provider' }), /provider/iu);
    await assert.rejects(client.runWebSearch({ query: 'topic', provider: 'codex', limit: 11 }), /limit/iu);
    assert.equal(calls, 0);
  });

  it('rejects malformed web search JSON and redacts provider failures', async () => {
    let call = 0;
    const client = createOpenClawClient({
      entryPath: 'C:/openclaw/dist/index.js',
      runner: () => {
        call += 1;
        return call === 1
          ? { status: 0, stdout: 'not-json', stderr: '' }
          : { status: 1, stdout: '', stderr: 'failed with sk-abcdefghijklmnop' };
      },
    });

    await assert.rejects(
      client.runWebSearch({ query: 'topic', provider: 'codex' }),
      /invalid JSON/iu,
    );
    await assert.rejects(
      client.runWebSearch({ query: 'topic', provider: 'codex' }),
      (error) => {
        assert.match(error.message, /REDACTED/u);
        assert.doesNotMatch(error.message, /sk-abcdefghijklmnop/u);
        return true;
      },
    );
  });
});
