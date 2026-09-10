import ExcelJS from '@excel.js/exceljs';
import { randomUUID } from 'node:crypto';
import { rename, rm } from 'node:fs/promises';
import sharp from 'sharp';

import { resolveDeliveryArchiveSource } from './delivery-source.mjs';
import { IMAGE_FORMATS } from './image-options.mjs';

export const DELIVERY_SPREADSHEET_MEDIA_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const MAX_DELIVERY_SPREADSHEET_TASKS = 200;
export const MAX_DELIVERY_SPREADSHEET_IMAGES_PER_TASK = 5;
export const MAX_DELIVERY_SPREADSHEET_IMAGE_BYTES = 256 * 1024 * 1024;

const MAX_CELL_CHARACTERS = 32_767;
const IMAGE_DISPLAY_MAX_WIDTH_PX = 150;
const IMAGE_DISPLAY_MAX_HEIGHT_PX = 200;
const IMAGE_COLUMN_WIDTH = 22;
const PACKAGE_COLUMN_WIDTH = 30;
const QUERY_COLUMN_WIDTH = 32;
const ARTICLE_COLUMN_WIDTH = 72;
const LINKS_COLUMN_WIDTH = 64;
const TEXT_COLUMN_COUNT = 4;
const DATA_ROW_HEIGHT_PT = 155;
const FONT_NAME = 'Arial';
const DELIVERY_IMAGE_MEDIA_TYPES = new Set(
  Object.values(IMAGE_FORMATS).map((format) => format.mediaType),
);
const ORIGINAL_IMAGE_FORMATS = new Map([
  ['image/png', { extension: 'png', sharpFormat: 'png' }],
  ['image/jpeg', { extension: 'jpeg', sharpFormat: 'jpeg' }],
  ['image/gif', { extension: 'gif', sharpFormat: 'gif' }],
]);

function iterable(value) {
  return value && (typeof value[Symbol.asyncIterator] === 'function'
    || typeof value[Symbol.iterator] === 'function');
}

function spreadsheetText(value, label) {
  const text = String(value ?? '')
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/gu, '\uFFFD');
  if (text.length > MAX_CELL_CHARACTERS) {
    throw new RangeError(`${label}超过 Excel 单元格上限`);
  }
  return text;
}

function currentDeliverySource(task) {
  const revision = task.copyRevisions?.find(
    (item) => Number(item.id) === Number(task.currentCopyRevisionId),
  );
  const imageRun = task.imageRuns?.find(
    (item) => String(item.id) === String(task.currentImageRunId),
  );
  const candidates = (task.assets ?? []).filter((asset) =>
    String(asset.imageRunId) === String(task.currentImageRunId)
      && DELIVERY_IMAGE_MEDIA_TYPES.has(String(asset.mediaType)));
  const source = resolveDeliveryArchiveSource({
    content: revision?.content,
    imageResult: imageRun?.result,
    availableAssetIds: candidates.map((asset) => asset.id),
  });
  if (source.assetIds.length > MAX_DELIVERY_SPREADSHEET_IMAGES_PER_TASK
      || new Set(source.assetIds).size !== source.assetIds.length) {
    throw new TypeError('当前交付图片资产绑定无效，请重新检查图片版本');
  }
  return source;
}

function articleValue(copy) {
  const title = spreadsheetText(copy.title, '标题');
  const body = spreadsheetText(copy.body, '正文');
  const separator = title && body ? '\n\n' : '';
  if (title.length + separator.length + body.length > MAX_CELL_CHARACTERS) {
    throw new RangeError('完整文章超过 Excel 单元格上限');
  }
  return `${title}${separator}${body}`;
}

function rankedXiaohongshuLinks(task) {
  if (!Array.isArray(task?.xiaohongshuLinks)) return [];
  return task.xiaohongshuLinks
    .map((item, index) => ({
      index,
      rank: Number.isSafeInteger(Number(item?.rank)) && Number(item.rank) > 0
        ? Number(item.rank)
        : index + 1,
      url: String(item?.url ?? '').trim(),
    }))
    .filter((item) => item.url)
    .sort((left, right) => left.rank - right.rank || left.index - right.index);
}

function xiaohongshuLinksValue(task) {
  const links = rankedXiaohongshuLinks(task);
  const statusText = {
    PENDING: '等待搜索',
    RUNNING: '搜索中',
    SUCCEEDED: '搜索完成，暂无结果',
    BLOCKED: task?.xiaohongshuSearchBlockedReason === 'CAPTCHA_REQUIRED'
      ? '等待人工安全验证'
      : '等待重新登录',
    FAILED: '搜索失败',
    CANCELLED: '搜索已取消',
  }[task?.xiaohongshuSearchStatus] ?? '';
  return spreadsheetText(
    links.length > 0 ? links.map((item) => item.url).join('\n') : statusText,
    '小红书链接',
  );
}

function assertXiaohongshuSearchReady(task) {
  if (task?.xiaohongshuSearchStatus && task.xiaohongshuSearchStatus !== 'SUCCEEDED') {
    throw new TypeError('当前 Query 的小红书搜索尚未完成，不能导出交付文件');
  }
}

function orientedDimensions(metadata) {
  const orientation = Number(metadata.orientation);
  return orientation >= 5 && orientation <= 8
    ? { width: metadata.height, height: metadata.width }
    : { width: metadata.width, height: metadata.height };
}

function displaySize(width, height) {
  const scale = Math.min(
    IMAGE_DISPLAY_MAX_WIDTH_PX / width,
    IMAGE_DISPLAY_MAX_HEIGHT_PX / height,
  );
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function originalImage(content, mediaType) {
  if (!Buffer.isBuffer(content) && !(content instanceof Uint8Array)) {
    throw new TypeError('交付图片内容无效');
  }
  const format = ORIGINAL_IMAGE_FORMATS.get(String(mediaType));
  if (!format) {
    throw new TypeError('Excel 原图导出仅支持 PNG、JPEG 或 GIF；请切换图片格式后重试');
  }
  const buffer = Buffer.from(content);
  let metadata;
  try {
    metadata = await sharp(buffer, {
      failOn: 'error',
      limitInputPixels: 40_000_000,
    }).metadata();
  } catch {
    throw new TypeError('交付图片内容无效');
  }
  const dimensions = orientedDimensions(metadata);
  if (metadata.format !== format.sharpFormat
      || !Number.isSafeInteger(dimensions.width) || dimensions.width < 1
      || !Number.isSafeInteger(dimensions.height) || dimensions.height < 1) {
    throw new TypeError('交付图片格式与文件内容不一致');
  }
  return {
    buffer,
    extension: format.extension,
    display: displaySize(dimensions.width, dimensions.height),
  };
}

function styleWorksheet(worksheet, rowCount, imageCount) {
  const columnCount = TEXT_COLUMN_COUNT + imageCount;
  worksheet.getColumn(1).width = PACKAGE_COLUMN_WIDTH;
  worksheet.getColumn(2).width = QUERY_COLUMN_WIDTH;
  worksheet.getColumn(3).width = ARTICLE_COLUMN_WIDTH;
  worksheet.getColumn(4).width = LINKS_COLUMN_WIDTH;
  for (let index = 1; index <= imageCount; index += 1) {
    const column = worksheet.getColumn(index + TEXT_COLUMN_COUNT);
    column.width = IMAGE_COLUMN_WIDTH;
    worksheet.getRow(1).getCell(index + TEXT_COLUMN_COUNT).value = `图片 ${index}`;
  }

  const header = worksheet.getRow(1);
  header.height = 24;
  for (let column = 1; column <= columnCount; column += 1) {
    const cell = header.getCell(column);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF991B1B' } };
    cell.font = { name: FONT_NAME, size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF7F1D1D' } } };
  }

  for (let rowNumber = 2; rowNumber <= rowCount + 1; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    row.height = DATA_ROW_HEIGHT_PT;
    for (let column = 1; column <= columnCount; column += 1) {
      const cell = row.getCell(column);
      cell.font = { name: FONT_NAME, size: 10, color: { argb: 'FF111827' } };
      cell.alignment = column <= TEXT_COLUMN_COUNT
        ? { horizontal: 'left', vertical: 'top', wrapText: true }
        : { horizontal: 'center', vertical: 'middle' };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } } };
    }
  }

  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: columnCount },
  };
}

export async function writeDeliverySpreadsheet(tasks, loadAsset, outputPath, {
  signal,
  maxTasks = MAX_DELIVERY_SPREADSHEET_TASKS,
  maxImageBytes = MAX_DELIVERY_SPREADSHEET_IMAGE_BYTES,
} = {}) {
  if (!iterable(tasks)) throw new TypeError('delivery spreadsheet tasks must be iterable');
  if (typeof loadAsset !== 'function') throw new TypeError('delivery spreadsheet asset loader is required');
  if (!Number.isSafeInteger(maxTasks) || maxTasks < 1) {
    throw new RangeError('delivery spreadsheet task limit must be a positive integer');
  }
  if (!Number.isSafeInteger(maxImageBytes) || maxImageBytes < 1) {
    throw new RangeError('delivery spreadsheet image byte limit must be a positive integer');
  }

  const workbook = new ExcelJS.Workbook();
  workbook.calcProperties.fullCalcOnLoad = false;

  const worksheet = workbook.addWorksheet('交付内容', {
    properties: { defaultRowHeight: 18 },
    views: [{
      state: 'frozen',
      xSplit: TEXT_COLUMN_COUNT,
      ySplit: 1,
      topLeftCell: 'E2',
      showGridLines: false,
    }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  worksheet.getCell('A1').value = '词包名称';
  worksheet.getCell('B1').value = 'Query';
  worksheet.getCell('C1').value = '完整文章';
  worksheet.getCell('D1').value = '小红书链接';

  let taskCount = 0;
  let maxImageCount = 0;
  let imageByteSize = 0;
  for await (const task of tasks) {
    signal?.throwIfAborted();
    assertXiaohongshuSearchReady(task);
    taskCount += 1;
    if (taskCount > maxTasks) {
      throw new RangeError(`Excel 图片导出一次最多 ${maxTasks} 篇文章`);
    }

    const { copy, assetIds } = currentDeliverySource(task);
    maxImageCount = Math.max(maxImageCount, assetIds.length);
    const row = worksheet.addRow([]);
    row.getCell(1).value = spreadsheetText(
      task.sourceQueryPackageName ?? '未归属词包',
      '词包名称',
    );
    row.getCell(2).value = spreadsheetText(task.query, 'Query');
    row.getCell(3).value = articleValue(copy);
    row.getCell(4).value = xiaohongshuLinksValue(task);

    for (let imageIndex = 0; imageIndex < assetIds.length; imageIndex += 1) {
      signal?.throwIfAborted();
      const asset = await loadAsset(task, assetIds[imageIndex]);
      signal?.throwIfAborted();
      if (!asset || Number(asset.id) !== Number(assetIds[imageIndex])
          || Number(asset.taskId) !== Number(task.id)
          || String(asset.imageRunId) !== String(task.currentImageRunId)
          || !DELIVERY_IMAGE_MEDIA_TYPES.has(String(asset.mediaType))) {
        throw new TypeError(`任务 ${task.id} 的交付图片缺失`);
      }
      const contentByteSize = Buffer.isBuffer(asset.content)
        || asset.content instanceof Uint8Array
        ? asset.content.byteLength
        : null;
      if (contentByteSize !== null && imageByteSize + contentByteSize > maxImageBytes) {
        throw new RangeError('Excel 原图总大小超出单次导出上限，请减少勾选数量后分批导出');
      }
      const image = await originalImage(asset.content, asset.mediaType);
      imageByteSize += image.buffer.byteLength;
      const imageId = workbook.addImage({
        buffer: image.buffer,
        extension: image.extension,
      });
      worksheet.addImage(imageId, {
        tl: { col: imageIndex + TEXT_COLUMN_COUNT + 0.08, row: row.number - 0.96 },
        ext: image.display,
        editAs: 'oneCell',
      });
    }
  }

  if (taskCount < 1) throw new RangeError('delivery spreadsheet must contain at least one task');
  styleWorksheet(worksheet, taskCount, maxImageCount);
  const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;
  try {
    signal?.throwIfAborted();
    await workbook.xlsx.writeFile(temporaryPath);
    signal?.throwIfAborted();
    await rename(temporaryPath, outputPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
  return { taskCount, imageColumnCount: maxImageCount };
}
