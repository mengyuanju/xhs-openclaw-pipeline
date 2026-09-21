import assert from 'node:assert/strict';
import test from 'node:test';

import ExcelJS from '@excel.js/exceljs';

import { parseQueryPackageSpreadsheet } from '../src/query-package-spreadsheet.mjs';

async function workbookBytes(configure) {
  const workbook = new ExcelJS.Workbook();
  configure(workbook);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test('XLSX query import selects a named worksheet and column without executing formulas', async () => {
  const bytes = await workbookBytes((workbook) => {
    const ignored = workbook.addWorksheet('说明');
    ignored.addRow(['备注', '值']);
    ignored.addRow(['不应导入', 'x']);
    const queries = workbook.addWorksheet('候选');
    queries.addRow(['编号', 'Query', '备注']);
    queries.addRow([1, '租房桌面收纳', 'a']);
    queries.addRow([2, ' 通勤穿搭 ', 'b']);
    queries.addRow([3, '租房桌面收纳', 'duplicate']);
  });
  const result = await parseQueryPackageSpreadsheet(bytes, { sheet: '候选', column: 'Query' });
  assert.equal(result.selectedColumn, 'B');
  assert.deepEqual(result.queries, ['租房桌面收纳', '通勤穿搭']);
  assert.equal(result.duplicates, 1);
  assert.equal(result.error, null);
});

test('XLSX query import reports formula and oversized rows instead of evaluating them', async () => {
  const bytes = await workbookBytes((workbook) => {
    const sheet = workbook.addWorksheet('Query');
    sheet.addRow(['Query']);
    sheet.getCell('A2').value = { formula: 'CONCAT("secret", "query")', result: 'cached' };
    sheet.getCell('A3').value = 'x'.repeat(501);
    sheet.getCell('A4').value = '正常选题';
  });
  const result = await parseQueryPackageSpreadsheet(bytes);
  assert.deepEqual(result.queries, ['正常选题']);
  assert.deepEqual(result.invalidRows.map((row) => row.rowNumber), [2, 3]);
});

test('XLSX query import rejects an unknown worksheet and bounded input violations', async () => {
  const bytes = await workbookBytes((workbook) => workbook.addWorksheet('候选').addRow(['Query']));
  await assert.rejects(parseQueryPackageSpreadsheet(bytes, { sheet: '不存在' }), /工作表不存在/u);
  await assert.rejects(parseQueryPackageSpreadsheet(Buffer.alloc(8 * 1024 * 1024 + 1)), /8MB/u);
});

const batchA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const batchB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const standardHeader = ['序号', '下发query', '是否进入生产', '生产query', '任务ID'];

test('standard XLSX keeps each row, falls back per cell and groups duplicate identities by task ID', async () => {
  const bytes = await workbookBytes((book) => {
    const sheet = book.addWorksheet('标准表');
    sheet.addRow(standardHeader);
    sheet.addRow([48002, '原始问题\n第二行', '是', '生产问题', batchA.toUpperCase()]);
    sheet.addRow([48005, '回退问题\n仍为同一条', '否', ' \t ', batchA]);
    sheet.addRow([48006, '其他原始问题', '是', '生产问题', batchB]);
    sheet.addRow([48007, '另一条原始问题', '是', '生产问题', batchA]);
    sheet.getCell('B8').value = '稀疏行仍应导入';
    sheet.getCell('E8').value = batchB;
  });
  const preview = await parseQueryPackageSpreadsheet(bytes);
  assert.equal(preview.mode, 'STANDARD');
  assert.equal(preview.error, null);
  assert.equal(preview.items.length, 5);
  assert.deepEqual(preview.items.map((row) => row.rowNumber), [2, 3, 4, 5, 8]);
  assert.equal(preview.items[0].externalId, '48002');
  assert.equal(preview.items[0].issuedQuery, '原始问题\n第二行');
  assert.equal(preview.items[0].query, '生产问题');
  assert.equal(preview.items[1].query, '回退问题\n仍为同一条');
  assert.equal(preview.duplicates, 1);
  assert.deepEqual(preview.groups, [{ clientBatchCode: batchA, count: 3 }, { clientBatchCode: batchB, count: 2 }]);
});

test('standard XLSX blocks partial imports when batch, formula or Query cells are invalid', async () => {
  const bytes = await workbookBytes((book) => {
    const sheet = book.addWorksheet('标准表');
    sheet.addRow(standardHeader);
    sheet.addRow([1, '有效', '是', '', batchA]);
    sheet.addRow([2, '批次为空', '是', '', '']);
    sheet.addRow([3, '', '是', ' \t ', batchA]);
    sheet.addRow([4, '公式原文', '是', { formula: '"cached"', result: 'cached' }, batchA]);
    sheet.addRow([5, 'x'.repeat(5001), '是', '简短生产词', batchA]);
    sheet.addRow([6, '有效', '是', 'x'.repeat(501), batchA]);
    sheet.addRow([7, '批次格式错误', '是', '', '123']);
  });
  const preview = await parseQueryPackageSpreadsheet(bytes);
  assert.equal(preview.items.length, 1);
  assert.match(preview.error, /6 行数据需要修正/u);
  assert.deepEqual(preview.invalidRows.map((row) => row.rowNumber), [3, 4, 5, 6, 7, 8]);
});

test('standard XLSX accepts production-only rows and rejects missing or ambiguous headers', async () => {
  const bytes = await workbookBytes((book) => {
    const sheet = book.addWorksheet('标准表');
    sheet.addRow(['任务 ID', ' 生产 Query ', '下发query']);
    sheet.addRow([batchA, '仅有生产词', '']);
  });
  assert.equal((await parseQueryPackageSpreadsheet(bytes)).items[0].query, '仅有生产词');
  for (const header of [
    ['生产query', '下发query'],
    ['生产query', '下发query', '任务ID', '任务 ID'],
  ]) {
    const invalid = await workbookBytes((book) => book.addWorksheet('错误').addRow(header));
    await assert.rejects(parseQueryPackageSpreadsheet(invalid), /缺少|重复列/u);
  }
  await assert.rejects(parseQueryPackageSpreadsheet(bytes, { maximum: 0 }), /最多导入/u);
});
