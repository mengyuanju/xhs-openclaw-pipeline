import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import JSZip from 'jszip';

import { parseExcelImport } from '../src/admin/excel-import.mjs';

const projectFile = (path) => new URL(`../${path}`, import.meta.url);

test('Excel intake presents a clear download, paste, and upload flow', async () => {
  const [workbench, styles] = await Promise.all([
    readFile(projectFile('app/imports/import-workbench.tsx'), 'utf8'),
    readFile(projectFile('app/globals.css'), 'utf8'),
  ]);

  assert.match(workbench, /href="\/templates\/xhs-topic-import-template\.xlsx"/);
  assert.match(workbench, /download="小红书选题导入模板\.xlsx"/);
  assert.match(workbench, />下载 Excel 模板<\/a>/);
  assert.match(workbench, /保留首行表头/);
  assert.match(workbench, /从第 2 行开始粘贴/);
  assert.match(styles, /\.import-steps\s*\{/);
  assert.match(styles, /\.import-step\s*\{/);
});

test('downloadable Excel template accepts pasted topics with the current importer', async () => {
  const template = await readFile(projectFile('public/templates/xhs-topic-import-template.xlsx'));
  const archive = await JSZip.loadAsync(template);
  const workbookXml = await archive.file('xl/workbook.xml').async('string');
  const sheetXml = await archive.file('xl/worksheets/sheet1.xml').async('string');

  assert.match(workbookXml, /<x:sheet name="选题导入" sheetId="1"/);
  assert.match(workbookXml, /<x:sheet name="填写说明" sheetId="2"/);
  for (const header of ['选题', '分类', '目标人群', '图片数量', '参考链接', '参考资料']) {
    assert.match(sheetXml, new RegExp(`<x:v>${header}</x:v>`));
  }
  assert.match(sheetXml, /<x:dataValidation type="whole" operator="between" sqref="D2:D5001">/);

  archive.file('xl/worksheets/sheet1.xml', sheetXml.replace(
    '</x:sheetData>',
    '<x:row r="2"><x:c r="A2" t="str"><x:v>租房书桌太乱怎么整理</x:v></x:c></x:row></x:sheetData>',
  ));
  const uploadBuffer = await archive.generateAsync({ type: 'nodebuffer' });
  const preview = await parseExcelImport({
    buffer: uploadBuffer,
    fileName: '小红书选题导入模板.xlsx',
  });

  assert.equal(preview.totalRows, 1);
  assert.equal(preview.validRows, 1);
  assert.equal(preview.rows[0].query, '租房书桌太乱怎么整理');
});
