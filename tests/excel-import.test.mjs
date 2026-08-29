import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

import { parseExcelImport } from '../src/admin/excel-import.mjs';
import { errorToApiResponse } from '../src/admin/http.mjs';

async function workbookBuffer(rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('选题');
  sheet.addRow(['外部ID', 'query', '分类', '目标用户', '图片数量', '参考图', '元数据']);
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function namespacePrefixedWorkbookBuffer(rows) {
  const buffer = await workbookBuffer(rows);
  const archive = await JSZip.loadAsync(buffer);
  for (const [path, entry] of Object.entries(archive.files)) {
    if (!path.startsWith('xl/') || !path.endsWith('.xml') || entry.dir) continue;
    const xml = await entry.async('string');
    if (!xml.includes('xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"')) continue;
    archive.file(path, xml
      .replace(
        'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
        'xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
      )
      .replace(/<(\/?)([A-Za-z][\w-]*)(?=[\s/>])/g, '<$1x:$2'));
  }
  return archive.generateAsync({ type: 'nodebuffer' });
}

async function screenedWorkbookBuffer(rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('已筛选选题');
  sheet.addRow(['序号', 'query', '分类', '是否有效', '废弃原因', '需求强度判定', '判定简要说明']);
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
      screening: null,
      errors: [],
    });
    assert.ok(preview.rows[1].errors.some((error) => error.includes('externalId重复')));
    assert.ok(preview.rows[2].errors.some((error) => error.includes('query不能为空')));
    assert.ok(preview.rows[2].errors.some((error) => error.includes('imageCount必须为3到5')));
    assert.ok(preview.rows[2].errors.some((error) => error.includes('参考图文件名非法')));
    assert.ok(preview.rows[2].errors.some((error) => error.includes('metadata必须是JSON对象')));
  });

  it('preserves reference URLs for production tasks', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('选题');
    sheet.addRow(['query', '图片数量', '参考链接', '参考资料']);
    sheet.addRow([
      '自行车铃铛被人弄坏了咋办',
      3,
      'https://example.com/guide；https://example.org/rules',
      '来源摘要：先留证，再核对损坏情况，最后协商处理。',
    ]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const preview = await parseExcelImport({ buffer, fileName: 'sources.xlsx' });

    assert.equal(preview.validRows, 1);
    assert.equal(preview.rows[0].imageCount, 3);
    assert.deepEqual(preview.rows[0].input.referenceUrls, [
      'https://example.com/guide',
      'https://example.org/rules',
    ]);
    assert.equal(
      preview.rows[0].input.referenceText,
      '来源摘要：先留证，再核对损坏情况，最后协商处理。',
    );
  });

  it('rejects unsafe or malformed reference URLs', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('选题');
    sheet.addRow(['query', '参考链接']);
    sheet.addRow(['测试选题', 'file:///etc/passwd；javascript:alert(1)']);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const preview = await parseExcelImport({ buffer, fileName: 'unsafe-sources.xlsx' });

    assert.equal(preview.invalidRows, 1);
    assert.ok(preview.rows[0].errors.some((error) => error.includes('参考链接必须使用http或https')));
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

    const error = await parseExcelImport({ buffer, fileName: 'queries.xlsx' })
      .then(() => null, (caught) => caught);
    assert.ok(error instanceof TypeError);
    assert.match(error.message, /缺少必需列.*query/i);
    const response = errorToApiResponse(error);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: { code: 'INVALID_INPUT', message: error.message },
    });
  });

  it('rejects a worksheet that has headers but no data rows', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('空表');
    sheet.addRow(['query', '分类']);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    await assert.rejects(
      () => parseExcelImport({ buffer, fileName: 'empty.xlsx' }),
      (error) => error instanceof TypeError && /没有可导入的数据行/.test(error.message),
    );
  });

  it('accepts valid OOXML workbooks that prefix the main spreadsheet namespace', async () => {
    const buffer = await namespacePrefixedWorkbookBuffer([
      ['x-1', '带命名空间的工作簿', '测试', '审核员', 3, '', '{}'],
    ]);

    const preview = await parseExcelImport({ buffer, fileName: 'prefixed.xlsx' });
    assert.equal(preview.validRows, 1);
    assert.equal(preview.rows[0].query, '带命名空间的工作簿');
  });

  it('imports all four demand levels as screening decisions without treating discards as format errors', async () => {
    const buffer = await screenedWorkbookBuffer([
      [15001, '两款投影仪怎么选', '3C', '是', '-', '强需', '存在明确的多对象比较需求。'],
      [15002, '杭州电子科技大学介绍', '教育', '是', '-', '中需', '专业信息为主，真实经验可作补充。'],
      [15003, '今天上海天气', '日历', '否', '一句话可回答/固定信息查询', '弱需', '固定事实即可闭环。'],
      [15004, '聊斋全书 txt 下载', '资源', '否', '资源下载类非笔记需求', '无需', '明确的资源下载需求。'],
    ]);

    const preview = await parseExcelImport({ buffer, fileName: 'screened.xlsx' });

    assert.equal(preview.validRows, 4);
    assert.equal(preview.invalidRows, 0);
    assert.deepEqual(preview.rows.map((row) => row.screening), [
      {
        admitted: true,
        demandLevel: 'STRONG',
        reason: '存在明确的多对象比较需求。',
        source: 'EXCEL',
      },
      {
        admitted: true,
        demandLevel: 'MEDIUM',
        reason: '专业信息为主，真实经验可作补充。',
        source: 'EXCEL',
      },
      {
        admitted: false,
        demandLevel: 'WEAK',
        reason: '固定事实即可闭环。',
        source: 'EXCEL',
      },
      {
        admitted: false,
        demandLevel: 'NONE',
        reason: '明确的资源下载需求。',
        source: 'EXCEL',
      },
    ]);
    assert.deepEqual(preview.rows[0].input.taskJudgement, {
      admitted: true,
      demandLevel: 'strong',
      reason: '存在明确的多对象比较需求。',
    });
    assert.equal(preview.rows[2].input.taskJudgement.admitted, false);
    assert.equal(preview.rows[2].input.taskJudgement.demandLevel, 'weak');
  });

  it('leaves structurally valid rows pending when the workbook has no demand judgement', async () => {
    const buffer = await workbookBuffer([
      ['x-1', '租房合同怎么签才不踩坑', '法律', '租房用户', 3, '', '{}'],
    ]);

    const preview = await parseExcelImport({ buffer, fileName: 'raw.xlsx' });

    assert.equal(preview.validRows, 1);
    assert.equal(preview.rows[0].screening, null);
  });

  it('keeps legacy rejected rows pending when they do not include a four-level judgement', async () => {
    const buffer = await screenedWorkbookBuffer([
      [15005, '今天上海天气', '日历', '否', '一句话可回答/固定信息查询', '-', '固定事实即可闭环。'],
    ]);

    const preview = await parseExcelImport({ buffer, fileName: 'legacy-screened.xlsx' });

    assert.equal(preview.validRows, 1);
    assert.equal(preview.invalidRows, 0);
    assert.equal(preview.rows[0].screening, null);
  });
});
