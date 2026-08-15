import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { processNext } from './pipeline.mjs';
import { createQueue } from './queue.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

function flagValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function assertAllowedOptions(args, definitions) {
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!option.startsWith('--') || !(option in definitions)) {
      throw new Error(`unknown option: ${option}`);
    }
    if (definitions[option] === 'value') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
      index += 1;
    }
  }
}

function writeJson(stream, value) {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function main(
  argv = process.argv.slice(2),
  {
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
  } = {},
) {
  const [command, ...args] = argv;
  if (!command) {
    writeJson(stderr, { error: 'command is required: init, enqueue, status or worker' });
    return 1;
  }

  const databasePath = resolve(env.XHS_DATABASE_PATH || resolve(PROJECT_ROOT, 'data', 'queue.sqlite'));
  const outputRoot = resolve(env.XHS_OUTPUT_ROOT || resolve(PROJECT_ROOT, 'output'));
  let queue;
  try {
    queue = createQueue(databasePath);
    if (command === 'init') {
      assertAllowedOptions(args, {});
      writeJson(stdout, { status: 'initialized', databasePath, outputRoot });
      return 0;
    }

    if (command === 'enqueue') {
      assertAllowedOptions(args, { '--query': 'value', '--input-json': 'value' });
      const query = flagValue(args, '--query');
      if (!query) throw new Error('--query is required');
      const rawInput = flagValue(args, '--input-json');
      let input = {};
      if (rawInput) {
        try {
          input = JSON.parse(rawInput);
        } catch {
          throw new Error('--input-json must be valid JSON');
        }
      }
      writeJson(stdout, queue.enqueue({ query, input }));
      return 0;
    }

    if (command === 'status') {
      assertAllowedOptions(args, { '--limit': 'value' });
      const limit = Number(flagValue(args, '--limit') ?? 20);
      writeJson(stdout, { counts: queue.countByStatus(), recent: queue.list({ limit }) });
      return 0;
    }

    if (command === 'worker') {
      assertAllowedOptions(args, {
        '--once': 'boolean',
        '--mock': 'boolean',
        '--worker-id': 'value',
      });
      if (!hasFlag(args, '--once')) {
        throw new Error('MVP worker requires the explicit --once safety flag');
      }
      const workerId = flagValue(args, '--worker-id') || `worker-${process.pid}`;
      const result = await processNext({
        queue,
        workerId,
        outputRoot,
        mock: hasFlag(args, '--mock'),
      });
      writeJson(stdout, result);
      return result.status === 'failed' ? 1 : 0;
    }

    throw new Error(`unknown command: ${command}`);
  } catch (error) {
    writeJson(stderr, { error: error instanceof Error ? error.message : String(error) });
    return 1;
  } finally {
    queue?.close();
  }
}

const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = await main();
}
