import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { processNext } from './pipeline.mjs';
import { createQueue } from './queue.mjs';
import { createOpenClawClient } from './openclaw.mjs';
import { createAdminStore } from './admin/admin-store.mjs';
import { processNextImageEdit } from './admin/image-edit-worker.mjs';
import { createAdminWorkerIntegration } from './admin/worker-service.mjs';

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
    createOpenClaw = createOpenClawClient,
    processContentTask = processNext,
    processImageEditTask = processNextImageEdit,
    sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  } = {},
) {
  const [command, ...args] = argv;
  if (!command) {
    writeJson(stderr, { error: 'command is required: init, enqueue, status or worker' });
    return 1;
  }

  const databasePath = resolve(
    env.XHS_DATABASE_PATH || env.XHS_DB_PATH || resolve(PROJECT_ROOT, 'data', 'queue.db'),
  );
  const outputRoot = resolve(env.XHS_OUTPUT_ROOT || resolve(PROJECT_ROOT, 'output'));
  const assetRoot = resolve(env.XHS_ASSET_ROOT || resolve(PROJECT_ROOT, 'data', 'assets'));
  const knowledgeRoot = resolve(env.XHS_KNOWLEDGE_ROOT || resolve(PROJECT_ROOT, 'data', 'knowledge'));
  let queue;
  let adminStore;
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
      const mock = hasFlag(args, '--mock');
      const openclaw = mock ? undefined : createOpenClaw();
      openclaw?.checkReady({
        textModel: env.XHS_TEXT_MODEL,
        imageModel: env.XHS_IMAGE_MODEL,
      });
      if (!mock) queue.closeCircuit('openclaw-auth');
      adminStore = createAdminStore(databasePath);
      const integration = createAdminWorkerIntegration({ store: adminStore, assetRoot, knowledgeRoot });
      let result = await processContentTask({
        queue,
        workerId,
        outputRoot,
        mock,
        openclaw,
        configProvider: integration.getTaskConfig,
        onCompleted: integration.onCompleted,
        onFailed: integration.onFailed,
        recoveryEnabled: !mock,
      });
      if (result.status === 'idle') {
        result = await processImageEditTask({
          store: adminStore,
          assetRoot,
          workerId,
          mock,
        });
      }
      writeJson(stdout, result);
      return ['failed', 'blocked'].includes(result.status) ? 1 : 0;
    }

    if (command === 'drain') {
      assertAllowedOptions(args, {
        '--mock': 'boolean',
        '--live': 'boolean',
        '--max': 'value',
        '--concurrency': 'value',
        '--worker-id': 'value',
      });
      const mock = hasFlag(args, '--mock');
      const live = hasFlag(args, '--live');
      if (mock === live) throw new Error('drain requires exactly one of --mock or --live');
      const rawMax = flagValue(args, '--max');
      if (!rawMax) throw new Error('drain requires --max');
      const max = Number(rawMax);
      if (!Number.isInteger(max) || max < 1 || max > 5_000) {
        throw new Error('--max must be an integer between 1 and 5000');
      }
      const concurrency = Number(
        flagValue(args, '--concurrency') ?? env.XHS_TASK_CONCURRENCY ?? 2,
      );
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2) {
        throw new Error('--concurrency must be an integer between 1 and 2');
      }
      const workerId = flagValue(args, '--worker-id') || `drain-${process.pid}`;
      const openclaw = mock ? undefined : createOpenClaw();
      openclaw?.checkReady({
        textModel: env.XHS_TEXT_MODEL,
        imageModel: env.XHS_IMAGE_MODEL,
      });
      if (!mock) queue.closeCircuit('openclaw-auth');
      adminStore = createAdminStore(databasePath);
      const integration = createAdminWorkerIntegration({ store: adminStore, assetRoot, knowledgeRoot });
      const summary = {
        status: 'completed',
        mode: mock ? 'mock' : 'live',
        max,
        concurrency,
        processed: 0,
        attempted: 0,
        contentCompleted: 0,
        imageEditsCompleted: 0,
        retriesScheduled: 0,
        manualRequired: 0,
        failed: 0,
      };
      let authenticationRequired = false;
      while (summary.processed < max) {
        const slots = Math.min(concurrency, max - summary.processed);
        const contentResults = await Promise.all(Array.from({ length: slots }, (_value, slot) =>
          processContentTask({
            queue,
            workerId: `${workerId}-${slot + 1}`,
            outputRoot,
            mock,
            openclaw,
            imageConcurrency: concurrency > 1 ? 1 : undefined,
            configProvider: integration.getTaskConfig,
            onCompleted: integration.onCompleted,
            onFailed: integration.onFailed,
            recoveryEnabled: !mock,
          })));
        const blockedContent = contentResults.filter(({ status }) => status === 'blocked');
        const claimedContent = contentResults.filter(({ status }) => !['idle', 'blocked'].includes(status));
        if (claimedContent.length > 0) {
          summary.attempted += claimedContent.length;
          summary.contentCompleted += claimedContent.filter(({ status }) => status === 'completed').length;
          const failedContent = claimedContent.filter(({ status }) => status === 'failed');
          const scheduledContent = claimedContent.filter(({ status }) => status === 'retry_scheduled');
          summary.failed += failedContent.length;
          summary.retriesScheduled += scheduledContent.length;
          summary.manualRequired += failedContent.filter(({ recovery }) =>
            recovery?.manualRequired === true).length;
          summary.processed += claimedContent.filter(({ status }) =>
            status === 'completed' || status === 'failed').length;
          authenticationRequired = claimedContent.some(({ recovery }) =>
            recovery?.failureClass === 'AUTH' && recovery?.haltWorker === true);
          if (authenticationRequired) break;
          continue;
        }
        if (blockedContent.some(({ haltWorker }) => haltWorker === true)) {
          authenticationRequired = true;
          break;
        }
        const edit = await processImageEditTask({ store: adminStore, assetRoot, workerId, mock });
        if (edit.status === 'idle') {
          const delayMs = queue.nextClaimDelayMs();
          if (delayMs === null) break;
          await sleep(Math.max(1, Math.min(delayMs, 60_000)));
          continue;
        }
        summary.attempted += 1;
        summary.processed += 1;
        if (edit.status === 'completed') summary.imageEditsCompleted += 1;
        else summary.failed += 1;
      }
      if (authenticationRequired) summary.status = 'authentication_required';
      else if (summary.failed > 0) summary.status = 'completed_with_failures';
      writeJson(stdout, summary);
      return authenticationRequired || summary.failed > 0 ? 1 : 0;
    }

    throw new Error(`unknown command: ${command}`);
  } catch (error) {
    writeJson(stderr, { error: error instanceof Error ? error.message : String(error) });
    return 1;
  } finally {
    adminStore?.close();
    queue?.close();
  }
}

const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  process.exitCode = await main();
}
