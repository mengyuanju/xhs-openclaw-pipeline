import sharp from 'sharp';
import { shortText, imageHash, assertOutsideMask } from '../../src/image-edit-pixels.mjs';
import { validateTextRepairRect, assertTextRepairRegions, renderTextRepairMask } from '../../src/image-text-repair.mjs';

const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const MAX_EDIT_BYTES = 40 * 1024 * 1024;
const MAX_EDIT_PIXELS = 32_000_000;
export function initialTextRepairState(items) {
  return { revision: 0, references: [...new Set(items.map(item => item.correctText))]
    .map(text => ({ text, status: 'PENDING' })),
  locations: items.map(item => ({ id: item.id, correctText: item.correctText, status: 'PENDING' })) };
}
export function publicTextRepairState(state) {
  if (!state?.references || !state?.locations) return null;
  return { ...state, references: state.references.map(({ asset, storage_path, ...entry }) => entry),
    locations: state.locations.map(({ asset, storage_path, ...entry }) => entry) };
}
export function assertTextRepairApprovedCopy(task, revision, run, config) {
  if (config.operation !== 'AI_TEXT_REPAIR' || task.task_kind === 'STANDALONE_IMAGE_EDIT') return;
  const content = revision.content;
  const page = (content.imagePlan ?? content.reviewed?.imagePlan ?? content.post?.imagePlan)?.[config.targetPage - 1];
  if (!page) throw new TypeError('缺少已批准的页面文案');
  const visible = run.result?.visualPlan?.value?.pages?.[config.targetPage - 1]?.allowedVisibleText ?? page;
  const approved = [visible.headline, visible.subtitle, ...(visible.bullets ?? []), ...(visible.labels ?? []),
    ...(run.result?.images?.[config.targetPage - 1]?.imageEditRequiredText ?? [])]
    .filter(value => typeof value === 'string').map(value => value.replace(/\s+/gu, ''));
  for (const item of config.textRepairs) {
    if (!approved.some(value => value.includes(item.correctText.replace(/\s+/gu, '')))
      || (item.contextText && !approved.some(value => value.includes(item.contextText.replace(/\s+/gu, ''))))) {
      throw new TypeError('正确文字和目标句子必须与当前页已批准文案一致');
    }
  }
}
export function normalizeTextRepairCheckpoint(input, config, state) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['kind', 'text', 'id', 'status', 'message', 'rect', 'bytes', 'validation'].includes(key))) {
    throw new TypeError('文字修正进度无效');
  }
  if (config.operation !== 'AI_TEXT_REPAIR') throw new TypeError('当前请求不支持文字修正进度');
  const kind = input.kind;
  if (!['REFERENCE', 'LOCATION', 'STATUS'].includes(kind)) throw new TypeError('文字修正进度类型无效');
  const item = input.id == null ? null : config.textRepairs.find(item => item.id === input.id);
  const text = input.text ?? item?.correctText;
  if ((kind === 'REFERENCE' && input.id != null) || (item && text !== item.correctText)) throw new TypeError('文字修正进度的字形和位置不匹配');
  if (input.id != null && !item) throw new TypeError('修正位置不属于当前请求');
  if (!state.references.some(entry => entry.text === text)) throw new TypeError('参考字形不属于当前请求');
  if (kind === 'LOCATION' && !item) throw new TypeError('文字修正位置缺失');
  if (kind === 'STATUS') {
    const allowed = item ? ['LOCATING', 'REPAIRING', 'FAILED'] : ['GENERATING', 'FAILED'];
    if (!allowed.includes(input.status)) throw new TypeError('文字修正状态无效');
    return { kind, item, text, status: input.status, message: shortText(input.message ?? '', 1000, false) };
  }
  if (!input.validation || typeof input.validation !== 'object' || Array.isArray(input.validation)
    || typeof input.validation.passed !== 'boolean' || JSON.stringify(input.validation).length > 100_000) {
    throw new TypeError('文字修正校验记录无效');
  }
  if (input.validation.sourceSha256 !== config.sha256 || input.validation.correctText !== text) {
    throw new TypeError('文字修正校验记录与冻结源图或正确文字不一致');
  }
  if (!Buffer.isBuffer(input.bytes) || !input.bytes.length || input.bytes.length > MAX_ARTIFACT_BYTES) {
    throw new TypeError('文字修正图片过大或无效');
  }
  const rect = kind === 'LOCATION' ? validateTextRepairRect(input.rect, item) : null;
  if (rect) {
    const reference = state.references.find(entry => entry.text === text);
    if (reference.status !== 'READY' || reference.validation?.passed !== true || !reference.assetId) {
      throw new TypeError('正确字形参考尚未通过校验');
    }
    if (input.validation.referenceSha256 !== reference.sha256) throw new TypeError('文字修正片段引用了其他版本的参考字形');
    assertTextRepairRegions([...state.locations.filter(entry => entry.id !== item.id && entry.status === 'COMPLETED')
      .map(entry => entry.rect), rect]);
  }
  return { kind, item, text, rect, bytes: input.bytes, validation: input.validation,
    status: kind === 'REFERENCE' ? (input.validation.passed ? 'READY' : 'FAILED')
      : (input.validation.passed ? 'COMPLETED' : 'FAILED') };
}
export async function textRepairArtifactMetadata(checkpoint, state) {
  const metadata = await sharp(checkpoint.bytes, { failOn: 'warning', limitInputPixels: 16_000_000, animated: true }).metadata();
  if (metadata.format !== 'png' || (metadata.pages ?? 1) !== 1 || !metadata.width || !metadata.height
    || metadata.width > 4096 || metadata.height > 4096) throw new TypeError('文字修正资产必须是单页 PNG');
  if (checkpoint.rect && (metadata.width !== checkpoint.rect.width || metadata.height !== checkpoint.rect.height)) {
    throw new TypeError('修正片段尺寸与实际字形区域不符');
  }
  const others = [...state.references.filter(entry => checkpoint.kind !== 'REFERENCE' || entry.text !== checkpoint.text),
    ...state.locations.filter(entry => checkpoint.kind !== 'LOCATION' || entry.id !== checkpoint.item.id)];
  if (others.reduce((sum, entry) => sum + (entry.byteSize ?? 0), 0) + checkpoint.bytes.length > MAX_EDIT_BYTES
    || others.reduce((sum, entry) => sum + (entry.width ?? 0) * (entry.height ?? 0), 0)
      + metadata.width * metadata.height > MAX_EDIT_PIXELS) throw new TypeError('文字修正参考和片段总大小超限');
  return { width: metadata.width, height: metadata.height, byteSize: checkpoint.bytes.length, sha256: imageHash(checkpoint.bytes) };
}
export function resetTextRepairReference(state, text) {
  if (!state?.references?.some(entry => entry.text === text)) throw new TypeError('请选择当前修正项中的正确文字');
  return { ...state, revision: (state.revision ?? 0) + 1,
    // Keep the previous image and review available as feedback until its replacement is stored.
    references: state.references.map(entry => entry.text === text ? { ...entry, status: 'PENDING' } : entry),
    locations: state.locations.map(entry => entry.correctText === text
      ? { id: entry.id, correctText: text, status: 'PENDING' } : entry) };
}
export async function verifyTextRepairCompletion({ config, state, source, result, readAsset }) {
  if (!state?.references?.length || state.locations?.length !== config.textRepairs.length) {
    throw new TypeError('文字修正进度不完整');
  }
  const regions = [];
  const composites = [];
  for (const item of config.textRepairs) {
    const reference = state.references.find(entry => entry.text === item.correctText);
    const location = state.locations.find(entry => entry.id === item.id);
    if (reference?.status !== 'READY' || reference.validation?.passed !== true || !reference.assetId
      || location?.status !== 'COMPLETED' || location.validation?.passed !== true || !location.assetId
      || location.referenceSha256 !== reference.sha256) throw new TypeError('仍有字形或位置未通过修正校验');
    const rect = validateTextRepairRect(location.rect, item);
    const bytes = await readAsset(location.assetId, location.sha256);
    if (imageHash(bytes) !== location.sha256) throw new TypeError('文字修正片段校验值已变化');
    const metadata = await sharp(bytes).metadata();
    if (metadata.width !== rect.width || metadata.height !== rect.height) throw new TypeError('修正片段尺寸与实际区域不符');
    regions.push(rect);
    composites.push({ input: bytes, left: rect.x, top: rect.y });
  }
  assertTextRepairRegions(regions);
  const mask = await renderTextRepairMask(regions);
  const outside = await assertOutsideMask(source, result, mask);
  const expected = await sharp(source).composite(composites).ensureAlpha().raw().toBuffer();
  const actual = await sharp(result).ensureAlpha().raw().toBuffer();
  if (!expected.equals(actual)) throw new TypeError('结果与已冻结的文字修正片段不一致');
  return { mask, outside, regions };
}
