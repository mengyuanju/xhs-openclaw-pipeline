import { resolve } from 'node:path';

import {
  collectOpenClawCodexTrace,
  writeOpenClawCodexTrace,
} from '../src/openclaw-trace-export.mjs';

function usage() {
  return [
    'Usage: node scripts/export-openclaw-codex-trace.mjs [options]',
    '',
    'Options:',
    '  --latest                 Export the newest standalone copy job (default)',
    '  --job-id <id>            Export one standalone copy job',
    '  --database <path>        Business SQLite path (default: data/queue.db)',
    '  --openclaw-root <path>   OpenClaw home (default: %USERPROFILE%/.openclaw)',
    '  --output-root <path>     Export parent directory (default: .codex_artifacts)',
    '  --help                   Show this help',
  ].join('\n');
}

function readValue(args, index, name) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new TypeError(`${name} requires a value`);
  return value;
}

function parseArgs(args) {
  const options = {
    jobId: null,
    databasePath: resolve('data', 'queue.db'),
    openClawRoot: resolve(process.env.USERPROFILE ?? '', '.openclaw'),
    outputRoot: resolve('.codex_artifacts'),
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--latest') options.jobId = null;
    else if (argument === '--job-id') {
      const value = Number(readValue(args, index, argument));
      if (!Number.isInteger(value) || value < 1) throw new TypeError('--job-id must be a positive integer');
      options.jobId = value;
      index += 1;
    } else if (argument === '--database') {
      options.databasePath = resolve(readValue(args, index, argument));
      index += 1;
    } else if (argument === '--openclaw-root') {
      options.openClawRoot = resolve(readValue(args, index, argument));
      index += 1;
    } else if (argument === '--output-root') {
      options.outputRoot = resolve(readValue(args, index, argument));
      index += 1;
    } else if (argument === '--help') {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else {
      throw new TypeError(`unknown option: ${argument}`);
    }
  }
  return options;
}

try {
  const options = parseArgs(process.argv.slice(2));
  const report = collectOpenClawCodexTrace(options);
  const output = writeOpenClawCodexTrace({ report, outputRoot: options.outputRoot });
  process.stdout.write(`${JSON.stringify({
    jobId: report.business.job.id,
    status: report.business.job.status,
    sessions: report.openclaw.sessions.length,
    totalTokens: report.chain.usage.totalTokens,
    coverage: report.coverage,
    ...output,
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
