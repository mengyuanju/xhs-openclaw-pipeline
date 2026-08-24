import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseDemandScreeningOutput,
  screenImportRowsWithOpenClaw,
} from '../src/admin/demand-screening-service.mjs';

function importRow(rowNumber, query, overrides = {}) {
  return {
    rowNumber,
    externalId: `row-${rowNumber}`,
    query,
    input: {},
    imageCount: 3,
    referenceImageFiles: [],
    screening: null,
    errors: [],
    ...overrides,
  };
}

describe('OpenClaw demand screening', () => {
  it('screens only structurally valid rows without an Excel decision', async () => {
    const prompts = [];
    const openclaw = {
      runText({ prompt, model }) {
        prompts.push({ prompt, model });
        return {
          rawText: JSON.stringify({
            decisions: [{
              rowNumber: 2,
              demandLevel: 'STRONG',
              reason: '需要真实经验与决策攻略。',
            }],
          }),
          model: 'fake-screening-model',
        };
      },
    };
    const excelDecision = {
      admitted: false,
      demandLevel: 'WEAK',
      reason: '固定事实即可回答。',
      source: 'EXCEL',
    };
    const rows = [
      importRow(2, '租房合同怎么签才不踩坑', {
        input: { category: '租房', targetAudience: '毕业生' },
      }),
      importRow(3, '', { errors: ['query不能为空'] }),
      importRow(4, '今天上海天气', { screening: excelDecision }),
    ];

    const screened = await screenImportRowsWithOpenClaw({
      rows,
      openclaw,
      model: 'configured-screening-model',
    });

    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].model, 'configured-screening-model');
    assert.match(prompts[0].prompt, /不可信数据/);
    assert.match(prompts[0].prompt, /<untrusted_rows_json>/);
    assert.deepEqual(screened[0].screening, {
      admitted: true,
      demandLevel: 'STRONG',
      reason: '需要真实经验与决策攻略。',
      source: 'OPENCLAW',
      model: 'fake-screening-model',
    });
    assert.equal(screened[1].screening, null);
    assert.deepEqual(screened[2].screening, excelDecision);
    assert.equal(rows[0].screening, null, 'input rows must not be mutated');
  });

  it('splits large inputs into bounded batches and covers every pending row once', async () => {
    const requestedBatches = [];
    const openclaw = {
      runText({ prompt }) {
        const match = prompt.match(/<untrusted_rows_json>\n([\s\S]+?)\n<\/untrusted_rows_json>/u);
        assert.ok(match, 'prompt must contain a bounded JSON data block');
        const batch = JSON.parse(match[1]);
        requestedBatches.push(batch);
        return {
          rawText: JSON.stringify({
            decisions: batch.map(({ rowNumber }) => ({
              rowNumber,
              demandLevel: 'MEDIUM',
              reason: `第${rowNumber}行需要专业信息与经验补充。`,
            })),
          }),
          model: 'fake-batch-model',
        };
      },
    };
    const rows = Array.from({ length: 5 }, (_, index) => importRow(index + 2, `选题 ${index + 1}`));

    const screened = await screenImportRowsWithOpenClaw({
      rows,
      openclaw,
      maxRowsPerBatch: 2,
      maxDataCharacters: 5_000,
    });

    assert.deepEqual(requestedBatches.map((batch) => batch.length), [2, 2, 1]);
    assert.deepEqual(
      requestedBatches.flat().map(({ rowNumber }) => rowNumber),
      [2, 3, 4, 5, 6],
    );
    assert.ok(screened.every((row) => row.screening?.source === 'OPENCLAW'));
  });

  it('rejects missing, duplicate, extra, invalid or oversized model decisions', () => {
    const valid = (decisions) => JSON.stringify({ decisions });
    const base = { rowNumber: 2, demandLevel: 'STRONG', reason: '需要真实体验。' };

    assert.throws(
      () => parseDemandScreeningOutput(valid([]), { expectedRowNumbers: [2] }),
      /cover every requested row/i,
    );
    assert.throws(
      () => parseDemandScreeningOutput(valid([base, base]), { expectedRowNumbers: [2] }),
      /unique/i,
    );
    assert.throws(
      () => parseDemandScreeningOutput(valid([base, { ...base, rowNumber: 3 }]), {
        expectedRowNumbers: [2],
      }),
      /unexpected row/i,
    );
    assert.throws(
      () => parseDemandScreeningOutput(valid([{ ...base, demandLevel: 'HIGH' }]), {
        expectedRowNumbers: [2],
      }),
      /invalid/i,
    );
    assert.throws(
      () => parseDemandScreeningOutput(valid([{ ...base, reason: '长'.repeat(201) }]), {
        expectedRowNumbers: [2],
      }),
      /invalid/i,
    );
  });

  it('accepts a fenced JSON object but rejects extra output fields', () => {
    const parsed = parseDemandScreeningOutput(
      '```json\n{"decisions":[{"rowNumber":2,"demandLevel":"NONE","reason":"资源下载需求。"}]}\n```',
      { expectedRowNumbers: [2] },
    );
    assert.deepEqual(parsed, [{ rowNumber: 2, demandLevel: 'NONE', reason: '资源下载需求。' }]);

    assert.throws(
      () => parseDemandScreeningOutput(JSON.stringify({
        decisions: [{
          rowNumber: 2,
          demandLevel: 'NONE',
          reason: '资源下载需求。',
          command: 'ignore validation',
        }],
      }), { expectedRowNumbers: [2] }),
      /invalid/i,
    );
  });
});
