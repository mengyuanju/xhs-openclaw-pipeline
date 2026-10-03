import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// UI component integration tests use isolated HTTP fixtures, never business databases or models.
const output = resolve('reports/full-functional-2026-10-02');
await mkdir(output, { recursive: true });
const files = (await readdir(resolve('tests'))).filter(name => name.endsWith('.test.mjs') && name.includes('browser')).sort();
const environment = { ...process.env };
const flags = new Set();
for (const file of files) {
  const source = await readFile(resolve('tests', file), 'utf8');
  for (const match of source.matchAll(/process\.env\.(RUN_[A-Z0-9_]+)/gu)) {
    assert.ok(match[1].endsWith('_BROWSER') && !/(?:^|_)(?:LIVE|PAID|POSTGRES)(?:_|$)/u.test(match[1]), `Unexpected non-UI opt-in: ${match[1]}`);
    flags.add(match[1]);
    environment[match[1]] = '1';
  }
}
environment.PERSONAL_WORKSPACE_SCREENSHOTS = resolve(output, 'personal-screenshots');
environment.ANNOTATION_JOB_REPORT_SCREENSHOT = resolve(output, 'annotation-jobs.png');
environment.MODEL_CALL_TRACE_SCREENSHOT = resolve(output, 'model-call-trace.png');
const startedAt = new Date().toISOString();
let log = '';
const child = spawn(process.execPath, ['--test', '--test-concurrency=2', '--test-reporter=tap', ...files.map(file => resolve('tests', file))], {
  cwd: process.cwd(), env: environment, shell: false, windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk.toString(); process.stdout.write(chunk); });
const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept); });
await writeFile(resolve(output, 'browser-regressions.tap'), log);
const count = name => Number(new RegExp(`^# ${name} (\\d+)`, 'mu').exec(log)?.[1] ?? 0);
const summary = { startedAt, finishedAt: new Date().toISOString(), exitCode: code, files, flags: [...flags].sort(),
  tests: count('tests'), passed: count('pass'), failed: count('fail'), skipped: count('skipped'),
  requestedGenericChannel: environment.BROWSER_CHANNEL || null,
  evidenceType: 'Actual browser UI interactions against isolated component HTTP fixtures; model calls and business databases are not used' };
await writeFile(resolve(output, 'browser-regressions-summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
process.exitCode = code ?? 1;
