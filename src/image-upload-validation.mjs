export const REFERENCE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

const imageTypes = {
  'image/png': { label: 'PNG', extensions: '.png' },
  'image/jpeg': { label: 'JPEG', extensions: '.jpg 或 .jpeg' },
  'image/webp': { label: 'WebP', extensions: '.webp' },
};

function startsWithBytes(bytes, signature, offset = 0) {
  return bytes.length >= offset + signature.length
    && signature.every((value, index) => bytes[offset + index] === value);
}

export function detectReferenceImageMediaType(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  if (startsWithBytes(bytes, [137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png';
  if (startsWithBytes(bytes, [255, 216, 255])) return 'image/jpeg';
  if (startsWithBytes(bytes, [82, 73, 70, 70])
    && startsWithBytes(bytes, [87, 69, 66, 80], 8)) return 'image/webp';
  return null;
}

export function referenceUploadSizeMessage(byteLength) {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new TypeError('图片字节大小无效');
  const currentMiB = (byteLength / 1024 / 1024).toFixed(2);
  const excess = byteLength > REFERENCE_UPLOAD_MAX_BYTES && currentMiB === '5.00'
    ? `，超出 ${(byteLength - REFERENCE_UPLOAD_MAX_BYTES).toLocaleString('en-US')} 字节` : '';
  return `图片文件超过大小限制：当前 ${currentMiB} MiB（${byteLength.toLocaleString('en-US')} 字节）/上限 5 MiB（${REFERENCE_UPLOAD_MAX_BYTES.toLocaleString('en-US')} 字节）${excess}。请压缩或缩小图片后重新上传。`;
}

export function referenceImageTypeMismatchMessage(bytes, declaredMediaType, { contentValidated = false } = {}) {
  const actualType = imageTypes[detectReferenceImageMediaType(bytes)];
  if (!actualType || contentValidated !== true) {
    return '文件签名与声明类型不符：无法识别图片内容，可能格式不受支持或文件已损坏。请重新导出为 PNG、JPEG 或 WebP 后上传。';
  }
  const declaredType = Object.hasOwn(imageTypes, declaredMediaType) ? imageTypes[declaredMediaType].label : '上传声明';
  return `文件签名与声明类型不符：图片内容实际为 ${actualType.label}，与${declaredType === '上传声明' ? declaredType : `声明的 ${declaredType} 格式`}不符。请将文件后缀改为 ${actualType.extensions} 后重新上传。`;
}
