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
