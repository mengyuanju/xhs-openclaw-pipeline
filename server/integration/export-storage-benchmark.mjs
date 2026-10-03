import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildBatchTaskArchive } from '../src/task-archive.mjs';
import { createTaskArchivePreparation } from '../src/task-archive-preparation.mjs';
import { createExportProgressLease } from '../src/export-progress-lease.mjs';

const path = fileURLToPath(import.meta.url), fileBytes = 4 * 1024 ** 2;
function tasks() {
  return Array.from({ length: 4 }, (_, index) => {
    const id = index + 1, ids = [id * 10 + 1, id * 10 + 2, id * 10 + 3];
    return { id, currentCopyRevisionId: id, currentImageRunId: `run-${id}`,
      copyRevisions: [{ id, content: { copy: { title: `Synthetic ${id}`, body: 'Synthetic archive benchmark' } } }],
      imageRuns: [{ id: `run-${id}`, result: { images: ids.map(assetId => ({ assetId })) } }],
      assets: ids.map(assetId => ({ id: assetId, imageRunId: `run-${id}`, mediaType: 'image/png' })) };
  });
}
async function archiveBenchmark(mode) {
  const chunk = randomBytes(64 * 1024);
  const rssBefore = process.memoryUsage().rss; let peakRss = rssBefore;
  const sample = () => { peakRss = Math.max(peakRss, process.memoryUsage().rss); };
  const timer = setInterval(sample, 10), started = performance.now();
  let root, manager, archiveBytes;
  try {
    if (mode === 'buffer') {
      const archive = await buildBatchTaskArchive(tasks(), async () => {
        const content = Buffer.alloc(fileBytes);
        for (let offset = 0; offset < content.length; offset += chunk.length) chunk.copy(content, offset);
        return { content, mediaType: 'image/png', originalName: 'synthetic.png' };
      });
      archiveBytes = archive.length; sample();
    } else {
      root = await mkdtemp(join(tmpdir(), 'xhs-archive-memory-'));
      manager = createTaskArchivePreparation({ storageRoot: root });
      const archive = await manager.prepareBatch(tasks(), async () => ({
        content: Readable.from((async function* () { for (let i = 0; i < fileBytes / chunk.length; i += 1) yield chunk; })()),
        mediaType: 'image/png', originalName: 'synthetic.png',
      }));
      archiveBytes = archive.size;
      await pipeline(await archive.openStream(), new Writable({ write(_chunk, _encoding, callback) { callback(); } }));
      sample(); await archive.dispose();
    }
    return { mode, tasks: 4, assets: 12, originalBytes: 12 * fileBytes, archiveBytes,
      elapsedMs: Number((performance.now() - started).toFixed(2)), rssBefore, peakRss, rssGrowth: peakRss - rssBefore,
      retainedArchiveBufferBytes: mode === 'buffer' ? archiveBytes : 0 };
  } finally {
    clearInterval(timer); await manager?.dispose();
    if (root) { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); }
  }
}
async function progressBenchmark() {
  let clock = 0, updates = 0, finalRows = 0;
  const progress = createExportProgressLease(async rows => { updates += 1; finalRows = rows; }, { now: () => clock });
  try {
    for (let rows = 250; rows <= 1_000_000; rows += 250) { clock += 5; progress.setRows(rows); await progress.flush(); }
    await progress.flush(true);
    return { rows: finalRows, cursorBatches: 4000, simulatedProcessingMs: clock,
      previousWrites: 4001, writes: updates, reductionPercent: Number(((1 - updates / 4001) * 100).toFixed(2)),
      simulated: true, realLeaseFencingEvidence: 'performance-round2-export-storage-postgres.txt' };
  } finally { await progress.dispose(); }
}
async function main() {
  const child = process.argv[2];
  if (child) {
    assert.ok(['--child=buffer', '--child=disk'].includes(child));
    console.log(JSON.stringify(await archiveBenchmark(child.slice(8)))); return;
  }
  const run = promisify(execFile), results = [];
  for (const mode of ['buffer', 'disk']) {
    const output = await run(process.execPath, [path, `--child=${mode}`], { windowsHide: true, shell: false, timeout: 120_000 });
    results.push(JSON.parse(output.stdout));
  }
  const report = { createdAt: new Date().toISOString(), synthetic: true, usesDatabase: false, usesModels: false,
    archive: results, progress: await progressBenchmark(),
    limitation: 'One synthetic 48 MiB batch per isolated process; RSS and timings depend on allocator and hardware. No million-data or 30-user claim.' };
  await writeFile(resolve('reports/performance-round2-export-storage-benchmark.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
if (process.argv[1] && resolve(process.argv[1]) === path) main().catch(error => { console.error(error.message); process.exitCode = 1; });
