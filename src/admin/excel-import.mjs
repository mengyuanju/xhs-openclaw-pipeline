import ExcelJS from 'exceljs';

const MAX_EXCEL_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 5_000;
const HEADER_ALIASES = new Map([
  ['externalid', 'externalId'],
  ['外部id', 'externalId'],
  ['外部编号', 'externalId'],
  ['query', 'query'],
  ['查询', 'query'],
  ['选题', 'query'],
  ['主题', 'query'],
  ['category', 'category'],
  ['分类', 'category'],
  ['targetaudience', 'targetAudience'],
  ['目标用户', 'targetAudience'],
  ['目标人群', 'targetAudience'],
  ['promptset', 'promptSet'],
  ['提示词组', 'promptSet'],
  ['imagecount', 'imageCount'],
  ['图片数量', 'imageCount'],
  ['referenceimagefiles', 'referenceImageFiles'],
  ['参考图', 'referenceImageFiles'],
  ['priority', 'priority'],
  ['优先级', 'priority'],
  ['metadata', 'metadata'],
  ['元数据', 'metadata'],
]);

function normalizedHeader(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function cellValue(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text ?? '').join('');
    if ('result' in value) return cellValue(value.result);
    if ('text' in value) return String(value.text ?? '');
    if ('hyperlink' in value) return String(value.text ?? value.hyperlink ?? '');
    return '';
  }
  return String(value);
}

function cleanText(value, maxLength) {
  const text = cellValue(value).trim();
  return [...text].slice(0, maxLength + 1).join('');
}

function parseMetadata(value, errors) {
  const text = cleanText(value, 10_000);
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
    return parsed;
  } catch {
    errors.push('metadata必须是JSON对象');
    return undefined;
  }
}

function parseReferenceFiles(value, errors) {
  const text = cleanText(value, 2_000);
  if (!text) return [];
  const files = text.split(/[,，;；\n]+/).map((part) => part.trim()).filter(Boolean);
  const validPattern = /^(?!\.)(?!.*\.\.)[^<>:"/\\|?*\u0000-\u001F]{1,120}\.(?:png|jpe?g|webp)$/i;
  for (const file of files) {
    if (!validPattern.test(file)) errors.push(`参考图文件名非法：${file}`);
  }
  return files.filter((file) => validPattern.test(file));
}

function parseImageCount(value, errors) {
  const text = cleanText(value, 20);
  if (!text) return 3;
  const imageCount = Number(text);
  if (!Number.isInteger(imageCount) || imageCount < 3 || imageCount > 5) {
    errors.push('imageCount必须为3到5');
    return 3;
  }
  return imageCount;
}

function headerColumns(worksheet) {
  const columns = new Map();
  worksheet.getRow(1).eachCell({ includeEmpty: true }, (cell, columnNumber) => {
    const canonical = HEADER_ALIASES.get(normalizedHeader(cell.value));
    if (canonical && !columns.has(canonical)) columns.set(canonical, columnNumber);
  });
  if (!columns.has('query')) throw new Error('query column is required');
  return columns;
}

function valueAt(row, columns, name) {
  const column = columns.get(name);
  return column ? row.getCell(column).value : '';
}

export async function parseExcelImport({ buffer, fileName }) {
  if (typeof fileName !== 'string' || !fileName.toLowerCase().endsWith('.xlsx')) {
    throw new TypeError('only .xlsx files are accepted');
  }
  if (!Buffer.isBuffer(buffer)) throw new TypeError('Excel upload must be a Buffer');
  if (buffer.byteLength > MAX_EXCEL_BYTES) throw new RangeError('Excel upload cannot exceed 5 MiB');

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw new Error('Excel file could not be decoded');
  }
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error('Excel workbook must contain a worksheet');
  const columns = headerColumns(worksheet);
  const rows = [];

  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const worksheetRow = worksheet.getRow(rowNumber);
    const rawValues = [...columns.keys()].map((name) => cellValue(valueAt(worksheetRow, columns, name)).trim());
    if (rawValues.every((value) => value === '')) continue;
    if (rows.length >= MAX_ROWS) throw new RangeError(`Excel cannot contain more than ${MAX_ROWS} data rows`);

    const errors = [];
    const query = cleanText(valueAt(worksheetRow, columns, 'query'), 501);
    const externalId = cleanText(valueAt(worksheetRow, columns, 'externalId'), 101) || null;
    const category = cleanText(valueAt(worksheetRow, columns, 'category'), 100);
    const targetAudience = cleanText(valueAt(worksheetRow, columns, 'targetAudience'), 200);
    const promptSet = cleanText(valueAt(worksheetRow, columns, 'promptSet'), 100);
    const priority = cleanText(valueAt(worksheetRow, columns, 'priority'), 30);
    if (!query) errors.push('query不能为空');
    if ([...query].length > 500) errors.push('query不能超过500字');
    if (externalId && [...externalId].length > 100) errors.push('externalId不能超过100字');

    const metadata = parseMetadata(valueAt(worksheetRow, columns, 'metadata'), errors);
    const input = {};
    if (category) input.category = category;
    if (targetAudience) input.targetAudience = targetAudience;
    if (promptSet) input.promptSet = promptSet;
    if (priority) input.priority = priority;
    if (metadata) input.metadata = metadata;

    rows.push({
      rowNumber,
      externalId,
      query,
      input,
      imageCount: parseImageCount(valueAt(worksheetRow, columns, 'imageCount'), errors),
      referenceImageFiles: parseReferenceFiles(
        valueAt(worksheetRow, columns, 'referenceImageFiles'),
        errors,
      ),
      errors,
    });
  }

  const seenExternalIds = new Set();
  for (const row of rows) {
    if (!row.externalId) continue;
    if (seenExternalIds.has(row.externalId)) row.errors.push(`externalId重复：${row.externalId}`);
    seenExternalIds.add(row.externalId);
  }

  const validRows = rows.filter((row) => row.errors.length === 0).length;
  return {
    fileName,
    totalRows: rows.length,
    validRows,
    invalidRows: rows.length - validRows,
    rows,
  };
}

export { MAX_EXCEL_BYTES, MAX_ROWS };

