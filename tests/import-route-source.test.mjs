import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { it } from 'node:test';

it('screens parsed Excel rows with OpenClaw before creating the preview batch', async () => {
  const route = await readFile(
    new URL('../app/api/import-batches/route.ts', import.meta.url),
    'utf8',
  );
  const screeningCall = route.indexOf('await screenImportRowsWithOpenClaw');
  const createBatchCall = route.indexOf('store.createImportBatch');

  assert.ok(screeningCall >= 0, 'the import route must invoke OpenClaw demand screening');
  assert.ok(createBatchCall > screeningCall, 'screening must finish before the preview batch is written');
  assert.match(route, /OPENCLAW_SCREENING_FAILED/);
});
