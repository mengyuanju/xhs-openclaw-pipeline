import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { businessPrompt, internalPrompt, promptProvenance } from '../../src/prompt-runtime.mjs';
import { normalizeTextRepairs, validateTextRepairRect, assertTextRepairRegions, renderTextRepairMask } from '../../src/image-text-repair.mjs';
import { imageHash, assertOutsideMask, EDIT_WIDTH, EDIT_HEIGHT } from '../../src/image-edit-pixels.mjs';

const normalized = value => String(value ?? '').normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const assetFor = entry => entry.asset ?? { id: entry.assetId, sha256: entry.sha256 };
const messageFor = error => String(error?.message ?? '错字修复失败').slice(0, 500);
function reviewObject(result) {
  if (typeof result?.rawText !== 'string' || result.rawText.length > 30_000) throw new TypeError('错字修复视觉检查返回无效内容');
  const parsed = JSON.parse(result.rawText);
  if (!object(parsed) || typeof parsed.passed !== 'boolean' || typeof parsed.confidence !== 'number'
    || !Number.isFinite(parsed.confidence) || parsed.confidence < 0 || parsed.confidence > 1) throw new TypeError('错字修复视觉检查结构无效');
  return parsed;
}
function confirmedReview(result, fields, text) {
  const review = reviewObject(result);
  const checks = object(review.checks) ? review.checks : {};
  const passed = review.passed === true && review.confidence >= 0.9 && fields.every(field => checks[field] === true)
    && typeof review.recognizedText === 'string' && review.recognizedText.length <= 12_000
    && (text === undefined || normalized(review.recognizedText).includes(normalized(text)));
  return { passed, confidence: review.confidence, recognizedText: String(review.recognizedText ?? '').slice(0, 12_000),
    checks: Object.fromEntries(fields.map(field => [field, checks[field] === true])), reason: String(review.reason ?? '').slice(0, 1000), model: result.model ?? null };
}
function repairPrompt(context, config, contractName, data) {
  if (contractName === 'INTERNAL_TEXT_REPAIR_REFERENCE'
    || (contractName === 'INTERNAL_TEXT_REPAIR_VERIFY' && data.mode === 'REFERENCE')) {
    const input = JSON.stringify({ operation: 'AI_TEXT_REPAIR', ...data }).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
    return `<program_contract>\n${internalPrompt(contractName)}\n</program_contract>\n<untrusted_image_text_repair_request>\n${input}\n</untrusted_image_text_repair_request>`;
  }
  if (!(config.imageEditPrompt ?? context.imageEditPrompt)?.content) throw new Error('缺少已发布图片编辑提示词，请发布后重试');
  return businessPrompt('IMAGE_EDIT_SYSTEM', {
    variables: { query: context.task.query, category: context.task.input?.category, targetAudience: context.task.input?.targetAudience,
      imageIndex: Number(config.targetPage ?? 1), imageCount: context.run.result?.images?.length ?? 1, reviewInstruction: '仅纠正用户指定的错字字形' },
    contract: internalPrompt(contractName), dataTag: 'untrusted_image_text_repair_request',
    data: { operation: 'AI_TEXT_REPAIR', ...data },
  });
}
function referenceFeedback(entry) {
  const validation = entry.validation ?? {};
  return {
    passed: validation.passed === true,
    reason: String(validation.reason ?? '').slice(0, 1000),
    recognizedText: String(validation.recognizedText ?? '').slice(0, 100),
    checks: Object.fromEntries(['correctGlyphs', 'readable', 'noExtraText'].map(field => [field, validation.checks?.[field] === true])),
    requestedRegeneration: entry.status === 'PENDING',
  };
}
function referenceFailureReason(checked, text) {
  if (checked.reason.trim()) return checked.reason;
  if (checked.recognizedText.trim() !== text) return `实际识别文字“${checked.recognizedText.slice(0, 100)}”与正确文字“${text}”不一致`;
  if (checked.confidence < 0.9) return `参考字形检查置信度不足（${checked.confidence.toFixed(2)}），请放大核对笔画`;
  return '参考字形的笔画、清晰度或额外文字检查未通过';
}
async function boundedPng(bytes, expected) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 10 * 1024 * 1024) throw new TypeError('错字修复图片大小无效');
  const metadata = await sharp(bytes, { failOn: 'warning', animated: true, limitInputPixels: 16_000_000 }).metadata();
  if (metadata.format !== 'png' || (metadata.pages ?? 1) !== 1 || !metadata.width || !metadata.height
    || metadata.width > 4096 || metadata.height > 4096) throw new TypeError('错字修复图片必须为有效的静态 PNG');
  if (expected && (metadata.width !== expected.width || metadata.height !== expected.height)) throw new TypeError('错字修复图块尺寸不符');
  return { bytes, metadata };
}
async function normalizedWorkingImage(bytes, dimensions) {
  const checked = await boundedPng(bytes);
  const expectedAspect = dimensions.width / dimensions.height;
  const actualAspect = checked.metadata.width / checked.metadata.height;
  if (checked.metadata.width < 32 || checked.metadata.height < 32) throw new TypeError('错字修复上下文图片尺寸过小');
  const geometry = { passed: Math.abs(actualAspect / expectedAspect - 1) <= 0.015,
    requested: dimensions, generated: { width: checked.metadata.width, height: checked.metadata.height } };
  if (!geometry.passed) geometry.reason = '错字修复上下文图片的宽高比例已改变；已按原区域映射，仅供人工检查';
  const normalizedBytes = checked.metadata.width === dimensions.width && checked.metadata.height === dimensions.height ? bytes
    : await sharp(bytes).resize(dimensions.width, dimensions.height, { fit: 'fill' }).png().toBuffer();
  return { bytes: normalizedBytes, geometry };
}
async function readCached(service, entry, expected) {
  const bytes = await service.readAsset(assetFor(entry));
  if (!/^[a-f0-9]{64}$/u.test(entry.sha256 ?? '') || imageHash(bytes) !== entry.sha256) throw new TypeError('错字修复缓存图片校验失败');
  return (await boundedPng(bytes, expected)).bytes;
}
function focusRegion(item, rect) {
  const padding = Math.max(16, rect.height * 2);
  const x = Math.max(item.region.x, rect.x - padding), y = Math.max(item.region.y, rect.y - padding);
  const right = Math.min(item.region.x + item.region.width, rect.x + rect.width + padding);
  const bottom = Math.min(item.region.y + item.region.height, rect.y + rect.height + padding);
  return { x, y, width: right - x, height: bottom - y };
}
async function prepareFocus(source, item, rect, path) {
  const focus = focusRegion(item, rect);
  const scale = Math.min(8, 2048 / focus.width, 2048 / focus.height);
  const width = Math.max(1, Math.round(focus.width * scale)), height = Math.max(1, Math.round(focus.height * scale));
  const bytes = await sharp(source).extract({ left: focus.x, top: focus.y, width: focus.width, height: focus.height })
    .resize(width, height).png().toBuffer();
  await writeFile(path, bytes);
  const target = { x: Math.round((rect.x - focus.x) * width / focus.width),
    y: Math.round((rect.y - focus.y) * height / focus.height),
    width: Math.max(1, Math.round(rect.width * width / focus.width)), height: Math.max(1, Math.round(rect.height * height / focus.height)) };
  target.width = Math.min(target.width, width - target.x); target.height = Math.min(target.height, height - target.y);
  return { focus, target, dimensions: { width, height } };
}
async function composePatches(source, patches) {
  if (!patches.length) return source;
  assertTextRepairRegions(patches.map(patch => patch.rect));
  return sharp(source).composite(patches.map(patch => ({ input: patch.bytes, left: patch.rect.x, top: patch.rect.y }))).png().toBuffer();
}
function validateApprovedCopy(context, repairs, requiredText) {
  if (context.task.task_kind === 'STANDALONE_IMAGE_EDIT' || context.task.taskKind === 'STANDALONE_IMAGE_EDIT') return;
  const approved = normalized(requiredText.join('\n'));
  if (!approved) throw new Error('当前页面缺少已审核文案，不能修复文字');
  for (const item of repairs) {
    if (!approved.includes(normalized(item.correctText))) throw new Error(`正确文字“${item.correctText}”不在当前页面已审核文案中，请先修改文案`);
    if (item.contextText && !approved.includes(normalized(item.contextText))) throw new Error(`第 ${repairs.indexOf(item) + 1} 处目标句子不在已审核文案中，请检查输入`);
  }
}

export async function renderImageTextRepair({ service, edit, context, source, inputPath, outputPath, directory, client,
  requiredText = [], signal, mock = false, onImageRequested = () => {}, onFailedPreview = () => {} }) {
  if (mock) throw new Error('mock 不生成可采用的错字修复结果');
  if (!client?.runImage || !client?.runImageEdit || !client?.runVision || !service.textRepairCheckpoint) throw new Error('执行器尚不支持错字修复，请升级后重试');
  const config = edit.config, repairs = normalizeTextRepairs(config.textRepairs);
  validateApprovedCopy(context, repairs, requiredText);
  const sourceSha256 = imageHash(source), state = context.textRepairState ?? { references: [], locations: [] };
  const references = new Map(), patches = [], failures = [];
  let generationAttempts = 0, model = null;
  const checkpoint = input => service.textRepairCheckpoint(edit, input);
  const requestImage = () => { signal?.throwIfAborted(); generationAttempts++; onImageRequested(); };
  async function review(contract, data, paths) {
    signal?.throwIfAborted();
    return client.runVision({ prompt: repairPrompt(context, config, contract, data), inputPaths: paths, signal });
  }
  for (const [index, text] of [...new Set(repairs.map(item => item.correctText))].entries()) {
    signal?.throwIfAborted();
    const path = resolve(directory, `glyph-reference-${index}.png`);
    let bytes = null, savedReference = false;
    try {
      const cached = state.references?.find(entry => entry.text === text && entry.status === 'READY' && entry.validation?.passed === true);
      if (cached) {
        bytes = await readCached(service, cached); await writeFile(path, bytes);
        references.set(text, { ...cached, bytes, path, reused: true }); continue;
      }
      const previous = state.references?.find(entry => entry.text === text && entry.assetId
        && ['FAILED', 'PENDING'].includes(entry.status));
      let previousPath;
      if (previous) {
        if (previous.validation?.sourceSha256 !== sourceSha256 || previous.validation?.correctText !== text) {
          throw new TypeError('上次参考字形与当前源图或正确文字不一致');
        }
        previousPath = resolve(directory, `glyph-reference-${index}-previous.png`);
        await writeFile(previousPath, await readCached(service, previous));
      }
      await checkpoint({ kind: 'STATUS', text, status: 'GENERATING', message: '正在生成正确字形参考图' });
      requestImage();
      const request = { prompt: repairPrompt(context, config, 'INTERNAL_TEXT_REPAIR_REFERENCE',
        { correctText: text, sourceSha256, mode: previous ? 'REPAIR_REFERENCE' : 'GENERATE_REFERENCE',
          layout: 'large readable black glyphs on plain white background; no other text',
          ...(previous ? { previousReview: referenceFeedback(previous), attachmentRoles: ['previous glyph reference to inspect and correct'] } : {}) }),
        canvas: { width: 1024, height: 1024 }, outputPath: path, signal };
      const generated = previous ? await client.runImageEdit({ ...request, inputPaths: [previousPath] }) : await client.runImage(request);
      model = generated.model ?? model;
      bytes = (await boundedPng(await readFile(path))).bytes;
      const checked = confirmedReview(await review('INTERNAL_TEXT_REPAIR_VERIFY', { mode: 'REFERENCE', correctText: text }, [path]),
        ['correctGlyphs', 'readable', 'noExtraText'], text);
      checked.passed = checked.passed && checked.recognizedText.trim() === text;
      if (!checked.passed) checked.reason = referenceFailureReason(checked, text);
      const saved = await checkpoint({ kind: 'REFERENCE', text, bytes, validation: { ...checked, sourceSha256, correctText: text } });
      savedReference = true;
      if (!checked.passed) throw new Error(`“${text}”参考字形未通过检查：${checked.reason}；请重新生成参考图`);
      references.set(text, { ...saved, bytes, path, reused: false });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (bytes && !savedReference) await checkpoint({ kind: 'REFERENCE', text, bytes,
        validation: { passed: false, sourceSha256, correctText: text, reason: messageFor(error) } });
      failures.push({ text, stage: 'REFERENCE', message: messageFor(error) });
      await checkpoint({ kind: 'STATUS', text, status: 'FAILED', message: messageFor(error) });
    }
  }
  for (const [index, item] of repairs.entries()) {
    signal?.throwIfAborted();
    const reference = references.get(item.correctText);
    if (!reference) {
      await checkpoint({ kind: 'STATUS', id: item.id, status: 'FAILED', message: '参考字形未通过检查，本处尚未替换' });
      failures.push({ id: item.id, stage: 'REFERENCE', message: '参考字形未通过检查，本处尚未替换' }); continue;
    }
    let rect, patchBytes, candidateValidation, savedCandidate = false;
    async function saveCandidate(validation) {
      const saved = await checkpoint({ kind: 'LOCATION', id: item.id, rect, bytes: patchBytes, validation });
      patches.push({ ...saved, id: item.id, rect, bytes: patchBytes, validation, reused: false });
      savedCandidate = true;
    }
    try {
      const cached = state.locations?.find(entry => entry.id === item.id && entry.status === 'COMPLETED' && entry.validation?.passed === true
        && entry.validation.correctText === item.correctText && entry.validation.referenceSha256 === reference.sha256
        && entry.validation.sourceSha256 === sourceSha256);
      if (cached) {
        rect = validateTextRepairRect(cached.rect, item); assertTextRepairRegions([...patches.map(patch => patch.rect), rect]);
        patchBytes = await readCached(service, cached, rect); patches.push({ ...cached, rect, bytes: patchBytes, reused: true }); continue;
      }
      await checkpoint({ kind: 'STATUS', id: item.id, status: 'LOCATING', message: '正在段落内定位实际错字' });
      const paragraphPath = resolve(directory, `paragraph-${index}.png`);
      await writeFile(paragraphPath, await sharp(source).extract({ left: item.region.x, top: item.region.y, width: item.region.width, height: item.region.height })
        .resize({ width: Math.min(4096, item.region.width * 3), height: Math.min(4096, item.region.height * 3), fit: 'inside' }).png().toBuffer());
      const localized = reviewObject(await review('INTERNAL_TEXT_REPAIR_LOCALIZE', { ...item, sourceSha256, imageDimensions: { width: EDIT_WIDTH, height: EDIT_HEIGHT },
        attachmentRoles: ['frozen original image', 'enlarged selected paragraph', 'correct glyph reference'], coordinateSystem: 'absolute original image pixels' },
      [inputPath, paragraphPath, reference.path]));
      if (!localized.passed || localized.confidence < 0.9 || localized.ambiguous !== false || localized.candidateCount !== 1
        || localized.correctText !== item.correctText || typeof localized.recognizedContext !== 'string' || localized.recognizedContext.length > 2000
        || typeof localized.correctedContext !== 'string' || localized.correctedContext.length > 2000
        || !normalized(localized.correctedContext).includes(normalized(item.correctText))
        || (item.contextText && !normalized(localized.correctedContext).includes(normalized(item.contextText)))) throw new Error('无法唯一定位错字，请缩小到对应句子或补充修正后的完整句子');
      rect = validateTextRepairRect(localized.rect, item);
      assertTextRepairRegions([...patches.map(patch => patch.rect), rect]);
      await checkpoint({ kind: 'STATUS', id: item.id, status: 'REPAIRING', message: '正在按参考字形替换并匹配原文字样式' });
      const focusPath = resolve(directory, `focus-${index}.png`), generatedPath = resolve(directory, `generated-patch-${index}.png`);
      const transform = await prepareFocus(source, item, rect, focusPath);
      requestImage();
      const generated = await client.runImageEdit({ prompt: repairPrompt(context, config, 'INTERNAL_TEXT_REPAIR_REPLACE', { ...item,
        sourceSha256, actualRegion: rect, workingImage: transform, correctedContext: localized.correctedContext,
        attachmentRoles: ['enlarged original text neighborhood', 'correct glyph reference', 'selected paragraph context'],
        instruction: 'Only correct the specified glyph inside workingImage.target, preserve typography and background. Keep the working image dimensions exactly.' }),
      inputPaths: [focusPath, reference.path, paragraphPath], outputPath: generatedPath, canvas: transform.dimensions, signal });
      model = generated.model ?? model;
      const workingImage = await normalizedWorkingImage(await readFile(generatedPath), transform.dimensions);
      patchBytes = await sharp(workingImage.bytes).extract({ left: transform.target.x, top: transform.target.y,
        width: transform.target.width, height: transform.target.height }).resize(rect.width, rect.height).png().toBuffer();
      candidateValidation = { passed: false, sourceSha256, correctText: item.correctText, referenceSha256: reference.sha256,
        localization: { ...localized, rect }, originalRegion: item.region, workingImageGeometry: workingImage.geometry };
      const candidate = await composePatches(source, [{ rect, bytes: patchBytes }]);
      const candidatePath = resolve(directory, `candidate-${index}.png`); await writeFile(candidatePath, candidate);
      const candidateFocusPath = resolve(directory, `candidate-focus-${index}.png`);
      await writeFile(candidateFocusPath, await sharp(candidate).extract({ left: transform.focus.x, top: transform.focus.y,
        width: transform.focus.width, height: transform.focus.height }).resize(transform.dimensions.width, transform.dimensions.height).png().toBuffer());
      const checked = confirmedReview(await review('INTERNAL_TEXT_REPAIR_VERIFY', { mode: 'LOCATION', ...item, actualRegion: rect,
        correctedContext: localized.correctedContext, workingImage: transform,
        attachmentRoles: ['frozen original full image', 'one-location corrected full image', 'correct glyph reference',
          'enlarged original text neighborhood', 'same enlarged neighborhood extracted from the composited corrected image'],
        inspection: 'Use attachments 4 and 5 to inspect each stroke, typography, neighboring letters and background. They show the actual before and after writeback at identical crop coordinates and dimensions.' },
      [inputPath, candidatePath, reference.path, focusPath, candidateFocusPath]), ['correctGlyphs', 'styleMatched', 'neighborsPreserved', 'backgroundMatched'], item.correctText);
      const validation = { ...candidateValidation, ...checked, passed: checked.passed && workingImage.geometry.passed };
      if (!workingImage.geometry.passed) validation.reason = workingImage.geometry.reason;
      await saveCandidate(validation);
      if (!validation.passed) throw new Error(workingImage.geometry.reason ?? '替换后的文字字形或样式未通过检查，请查看局部对比后重试');
    } catch (error) {
      if (signal?.aborted) throw error;
      if (patchBytes && candidateValidation && !savedCandidate) {
        await saveCandidate({ ...candidateValidation, passed: false, reason: messageFor(error) });
      }
      failures.push({ id: item.id, stage: 'LOCATION', message: messageFor(error) });
      await checkpoint({ kind: 'STATUS', id: item.id, status: 'FAILED', message: messageFor(error) });
    }
  }
  const result = await composePatches(source, patches);
  if (patches.length) onFailedPreview(result);
  if (failures.length || patches.length !== repairs.length) throw Object.assign(new Error(`错字修复尚未全部完成：${failures[0]?.message ?? '存在未完成位置'}`),
    { validation: { stage: 'TEXT_REPAIR', passed: false, billedImageGeneration: generationAttempts > 0, failures, generationAttempts,
      completedLocationIds: patches.filter(patch => patch.validation?.passed === true).map(patch => patch.id),
      candidateLocationIds: patches.map(patch => patch.id), referenceCount: references.size, sourceSha256 } });
  const mask = await renderTextRepairMask(patches.map(patch => patch.rect));
  const outsideMask = await assertOutsideMask(source, result, mask);
  await writeFile(outputPath, result);
  const final = confirmedReview(await review('INTERNAL_TEXT_REPAIR_VERIFY', { mode: 'FINAL', repairs,
    actualRegions: patches.map(patch => ({ id: patch.id, rect: patch.rect })), requiredText, sourceSha256,
    standalone: context.task.task_kind === 'STANDALONE_IMAGE_EDIT' || context.task.taskKind === 'STANDALONE_IMAGE_EDIT',
    attachmentRoles: ['frozen original image', 'all requested corrections composed together'] }, [inputPath, outputPath]),
  ['allCorrectionsCompleted', 'unrelatedTextPreserved', 'unrelatedContentPreserved', 'approvedCopyMatched']);
  final.passed = final.passed && repairs.every(item => normalized(final.recognizedText).includes(normalized(item.correctText)));
  if (!final.passed) throw Object.assign(new Error('最终图片的文字或整体一致性未通过检查，请查看参考图和逐处对比'),
    { validation: { stage: 'TEXT_REPAIR_FINAL', passed: false, billedImageGeneration: generationAttempts > 0, text: final,
      outsideMask, generationAttempts, sourceSha256 } });
  const frozen = config.imageEditPrompt ?? context.imageEditPrompt;
  return { bytes: result, mask, validation: { passed: true, mock: false, billedImageGeneration: generationAttempts > 0,
    dimensions: { passed: true, width: EDIT_WIDTH, height: EDIT_HEIGHT }, format: 'png', integrity: { sha256: imageHash(result) }, outsideMask,
    sourceSha256, text: final, requiredText, generationAttempts, model, referenceCount: references.size,
    reusedReferences: [...references.values()].filter(entry => entry.reused).length, reusedLocations: patches.filter(entry => entry.reused).length,
    localization: { mode: 'TEXT_REPAIR_GLYPH_REGIONS', passed: true, locations: patches.map(entry => ({ id: entry.id, rect: entry.rect })) },
    promptProvenance: promptProvenance(), prompt: { kind: 'IMAGE_EDIT_SYSTEM', versionId: frozen.versionId ?? null, version: frozen.version ?? null,
      sha256: frozen.sha256 ?? null, capturedAt: frozen.capturedAt ?? null } } };
}
