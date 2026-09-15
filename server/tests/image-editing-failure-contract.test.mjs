import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('executor image-edit failures use one explicit text type for the shared error parameter', async () => {
  const source = await readFile(new URL('../src/image-editing.mjs', import.meta.url), 'utf8');
  assert.match(source,
    /UPDATE task_executions SET[\s\S]{0,300}progress_message=\$2::text,error=\$2::text/u);
});
