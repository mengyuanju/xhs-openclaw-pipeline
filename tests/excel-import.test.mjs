import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import ExcelJS from 'exceljs';

import { parseExcelImport } from '../src/admin/excel-import.mjs';

async function workbookBuffer(rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('选题');
  sheet.addRow(['外部ID', 'query', '分类', '目标用户', '图片数量', '参考图', '元数据']);
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe('parseExcelImport', () => {
  it('normalizes Chinese headers and reports invalid and duplicate rows', async () => {
    const buffer = await workbookBuffer([
      ['x-1', '租房桌面怎么整理', '收纳', '租房用户', 3, 'desk.png;room.jpg', '{"city":"上海"}'],
      ['x-1', '重复编号', '收纳', '租房用户', 4, '', ''],
      ['x-3', '', '收纳', '租房用户', 8, '../escape.png', '{bad json}'],
    ]);

    const preview = await parseExcelImport({ buffer, fileName: 'queries.xlsx' });

    assert.equal(preview.totalRows, 3);
    assert.equal(preview.validRows, 1);
    assert.equal(preview.invalidRows, 2);
    assert.deepEqual(preview.rows[0], {
      rowNumber: 2,
      externalId: 'x-1',
      query: '租房桌面怎么整理',
      input: { category: '收纳', targetAudience: '租房用户', metadata: { city: '上海' } },
      imageCount: 3,
      referenceImageFiles: ['desk.png', 'room.jpg'],
      errors: [],
    });
    assert.ok(preview.rows[1].errors.some((error) => error.includes('externalId重复')));
    assert.ok(preview.rows[2].errors.some((error) => error.includes('query不能为空')));
    assert.ok(preview.rows[2].errors.some((error) => error.includes('imageCount必须为3到5')));
    assert.ok(preview.rows[2].errors.some((error) => error.includes('参考图文件名非法')));
    assert.ok(preview.rows[2].errors.some((error) => error.includes('metadata必须是JSON对象')));
  });

  it('rejects non-xlsx files and files above the upload limit', async () => {
    await assert.rejects(
      () => parseExcelImport({ buffer: Buffer.from('a,b'), fileName: 'queries.csv' }),
      /only .xlsx files are accepted/i,
    );
    await assert.rejects(
      () => parseExcelImport({ buffer: Buffer.alloc(5 * 1024 * 1024 + 1), fileName: 'queries.xlsx' }),
      /cannot exceed 5 MiB/i,
    );
  });

  it('requires a query column', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('错误模板');
    sheet.addRow(['外部ID', '分类']);
    sheet.addRow(['x-1', '收纳']);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    await assert.rejects(
      () => parseExcelImport({ buffer, fileName: 'queries.xlsx' }),
      /query column is required/i,
    );
  });
});

