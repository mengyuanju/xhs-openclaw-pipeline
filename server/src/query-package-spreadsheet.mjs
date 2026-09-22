import ExcelJS from '@excel.js/exceljs';
import JSZip from 'jszip';
import { normalizeClientBatchCode } from './client-batch.mjs';

const MAX_XLSX_BYTES = 8 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 500;
const MAX_WORKSHEETS = 20;
const MAX_ROWS = 10_050;
const MAX_COLUMNS = 100;
const HEADER_NAMES = /^(?:query|关键词|选题)$/iu;

function columnKey(number) {
  let value = number;
  let key = '';
  while (value > 0) {
    value -= 1;
    key = String.fromCharCode(65 + (value % 26)) + key;
    value = Math.floor(value / 26);
  }
  return key;
}

function cellText(cell) {
  const value = cell?.value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim();
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value?.richText)) return value.richText.map((part) => part?.text ?? '').join('').trim();
  if (Object.hasOwn(value, 'formula') || Object.hasOwn(value, 'sharedFormula')) {
    throw new TypeError('公式单元格不允许作为 Query，请先在表格中粘贴为纯文本');
  }
  if (typeof value?.text === 'string') return value.text.trim();
  if (typeof cell?.text === 'string') return cell.text.trim();
  throw new TypeError('表格中包含不支持的单元格类型');
}

async function assertSafeArchive(buffer) {
  const archive = await JSZip.loadAsync(buffer, { checkCRC32: false, createFolders: false });
  const entries = Object.values(archive.files);
  if (entries.length > MAX_ZIP_ENTRIES) throw new RangeError('XLSX 文件结构过于复杂');
  const total = entries.reduce((sum, entry) => {
    const size = Number(entry?._data?.uncompressedSize ?? 0);
    return sum + (Number.isFinite(size) && size >= 0 ? size : MAX_UNCOMPRESSED_BYTES + 1);
  }, 0);
  if (total > MAX_UNCOMPRESSED_BYTES) throw new RangeError('XLSX 解压后内容过大');
}

function worksheetColumns(worksheet, headerRowNumber) {
  const columnCount = Math.min(MAX_COLUMNS, Math.max(1, worksheet.actualColumnCount));
  const header = worksheet.getRow(headerRowNumber);
  return Array.from({ length: columnCount }, (_, index) => {
    const number = index + 1;
    let label = '';
    try { label = cellText(header.getCell(number)); } catch { label = ''; }
    return { key: columnKey(number), number, label: label || columnKey(number) };
  });
}

function resolveColumn(columns, requested) {
  if (!requested) return columns.find((column) => HEADER_NAMES.test(column.label)) ?? columns[0];
  const token = String(requested).trim();
  return columns.find((column) => column.key.toUpperCase() === token.toUpperCase()
    || column.label === token
    || String(column.number) === token) ?? null;
}


function standardColumns(columns) {
  const labels = new Map();
  for (const column of columns) {
    const label = column.label.replace(/\s+/gu, '').toLowerCase();
    if (['下发query', '生产query', '任务id', '序号'].includes(label)) {
      if (labels.has(label)) throw new TypeError(`标准表包含重复列：${column.label}`);
      labels.set(label, column);
    }
  }
  if (!labels.has('下发query') && !labels.has('生产query')) return null;
  for (const label of ['下发query', '生产query', '任务id']) {
    if (!labels.has(label)) throw new TypeError(`标准表缺少必需列：${label}`);
  }
  return {
    issued: labels.get('下发query'), production: labels.get('生产query'),
    batch: labels.get('任务id'), externalId: labels.get('序号'),
  };
}

function parseStandardRows(worksheet, headerRowNumber, columns, maximum) {
  const items = [];
  const batches = new Map();
  const seen = new Set();
  const invalidRows = [];
  let blanks = 0;
  let duplicates = 0;
  let dataRows = 0;
  for (let rowNumber = headerRowNumber + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    if (!row.values.some((value) => value !== null && value !== undefined && String(value).trim())) {
      blanks += 1;
      continue;
    }
    dataRows += 1;
    if (dataRows > maximum) throw new RangeError(`单次最多导入 ${maximum} 条 Query`);
    try {
      const issuedQuery = cellText(row.getCell(columns.issued.number));
      const productionQuery = cellText(row.getCell(columns.production.number));
      const query = productionQuery || issuedQuery;
      const batch = cellText(row.getCell(columns.batch.number));
      if (!/^[0-9a-f]{32}$/iu.test(batch)) {
        throw new TypeError('任务ID必须是 32 位十六进制编号，不能为空');
      }
      const clientBatchCode = normalizeClientBatchCode(batch);
      if (!query) throw new TypeError('生产query和下发query不能同时为空');
      if ([...query].length > 500) throw new TypeError('实际作业 Query 不能超过 500 个字符');
      if ([...issuedQuery].length > 5000) throw new TypeError('下发query不能超过 5000 个字符');
      const externalId = columns.externalId ? cellText(row.getCell(columns.externalId.number)) || null : null;
      if (externalId && [...externalId].length > 200) throw new TypeError('序号不能超过 200 个字符');
      const identity = clientBatchCode + ':' + query.replace(/\s+/gu, '').toLocaleLowerCase('zh-CN');
      if (seen.has(identity)) duplicates += 1;
      seen.add(identity);
      // Preserve every source row, including duplicates and cell-internal newlines.
      items.push({ rowNumber, externalId, issuedQuery, productionQuery, query, clientBatchCode });
      batches.set(clientBatchCode, (batches.get(clientBatchCode) ?? 0) + 1);
    } catch (error) {
      invalidRows.push({ rowNumber, message: error.message });
    }
  }
  return {
    mode: 'STANDARD',
    selectedColumn: columns.production.key,
    items,
    queries: items.map((item) => item.query),
    groups: [...batches].map(([clientBatchCode, count]) => ({ clientBatchCode, count })),
    duplicates, blanks,
    invalidRows: invalidRows.slice(0, 100),
    error: invalidRows.length
      ? `有 ${invalidRows.length} 行数据需要修正：${invalidRows.slice(0, 5).map((row) => `第 ${row.rowNumber} 行：${row.message}`).join('；')}`
      : items.length === 0 ? '工作表没有可导入的 Query' : null,
  };
}

export async function parseQueryPackageSpreadsheet(buffer, {
  sheet: requestedSheet,
  column: requestedColumn,
  maximum = 10_000,
} = {}) {
  if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
    throw new TypeError('spreadsheet body must be bytes');
  }
  if (buffer.byteLength < 1 || buffer.byteLength > MAX_XLSX_BYTES) {
    throw new RangeError('XLSX 文件大小必须在 1B 到 8MB 之间');
  }
  await assertSafeArchive(buffer);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(buffer));
  if (workbook.worksheets.length < 1 || workbook.worksheets.length > MAX_WORKSHEETS) {
    throw new RangeError(`XLSX 工作表数量必须在 1 到 ${MAX_WORKSHEETS} 之间`);
  }
  const sheets = workbook.worksheets.map((worksheet) => {
    if (worksheet.rowCount > MAX_ROWS || worksheet.actualColumnCount > MAX_COLUMNS) {
      throw new RangeError(`工作表“${worksheet.name}”超过 ${MAX_ROWS} 行或 ${MAX_COLUMNS} 列限制`);
    }
    let headerRowNumber = 1;
    for (let row = 1; row <= Math.max(1, worksheet.rowCount); row += 1) {
      if (worksheet.getRow(row).values.some((value) => value !== null && value !== undefined && String(value).trim())) {
        headerRowNumber = row;
        break;
      }
    }
    return {
      name: worksheet.name,
      headerRowNumber,
      columns: worksheetColumns(worksheet, headerRowNumber),
    };
  });
  const selectedSheet = requestedSheet
    ? sheets.find((candidate) => candidate.name === requestedSheet)
    : sheets[0];
  if (!selectedSheet) throw new TypeError('指定的工作表不存在');
  const standard = standardColumns(selectedSheet.columns);
  if (standard) {
    return {
      sheets,
      selectedSheet: selectedSheet.name,
      ...parseStandardRows(workbook.getWorksheet(selectedSheet.name), selectedSheet.headerRowNumber, standard, maximum),
    };
  }
  const selectedColumn = resolveColumn(selectedSheet.columns, requestedColumn);
  if (!selectedColumn) throw new TypeError('指定的 Query 列不存在');
  const worksheet = workbook.getWorksheet(selectedSheet.name);
  const headerText = cellText(worksheet.getRow(selectedSheet.headerRowNumber).getCell(selectedColumn.number));
  const startRow = HEADER_NAMES.test(headerText)
    ? selectedSheet.headerRowNumber + 1
    : selectedSheet.headerRowNumber;
  const queries = [];
  const seen = new Set();
  const invalidRows = [];
  let duplicates = 0;
  let blanks = 0;
  for (let rowNumber = startRow; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    let query;
    try {
      query = cellText(worksheet.getRow(rowNumber).getCell(selectedColumn.number));
    } catch (error) {
      invalidRows.push({ rowNumber, message: error.message });
      continue;
    }
    if (!query) { blanks += 1; continue; }
    if ([...query].length > 500) {
      invalidRows.push({ rowNumber, message: '单条 Query 不能超过 500 个字符' });
      continue;
    }
    const identity = query.replace(/\s+/gu, '').toLocaleLowerCase('zh-CN');
    if (seen.has(identity)) { duplicates += 1; continue; }
    seen.add(identity);
    queries.push(query);
    if (queries.length > maximum) throw new RangeError(`单个词包最多导入 ${maximum} 条 Query`);
  }
  return {
    mode: 'SINGLE_COLUMN',
    sheets,
    selectedSheet: selectedSheet.name,
    selectedColumn: selectedColumn.key,
    queries,
    duplicates,
    blanks,
    invalidRows: invalidRows.slice(0, 100),
    error: queries.length === 0 ? '所选列没有可导入的 Query' : null,
  };
}

export const QUERY_PACKAGE_SPREADSHEET_BYTES = MAX_XLSX_BYTES;
