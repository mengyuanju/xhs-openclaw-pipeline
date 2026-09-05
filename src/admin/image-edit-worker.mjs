import { createHash, randomUUID } from 'node:crypto';
import { codexErrorCode } from '../codex-protocol.mjs';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import sharp from 'sharp';

import { DELIVERY_IMAGE_HEIGHT, DELIVERY_IMAGE_WIDTH } from '../image-output-contract.mjs';
import { applyDeterministicTextOverlay } from '../images.mjs';
import { createImageAlignmentValidator } from '../image-alignment.mjs';
import { createAgentClient as createOpenClawClient } from '../agent-client.mjs';
import { normalizeProductionSettings, productionDisclosure } from '../production-settings.mjs';
import { renderPrompt } from './prompt-service.mjs';

function safeAbsolute(root, child) {
  const rootPath = resolve(root);
  const path = resolve(rootPath, child);
  const relation = relative(rootPath, path);
  if (!relation || relation.startsWith('..')) throw new Error('image edit path escaped the asset root');
  return path;
}

function publicError(value) {
  return String(value instanceof Error ? value.message : value ?? 'Unknown error')
    .replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/g, '[REDACTED_API_KEY]')
    .replace(/\bBearer\s+[a-zA-Z0-9._~+/=-]{12,}\b/gi, 'Bearer [REDACTED_TOKEN]')
    .slice(0, 2_000);
}

export async function processNextImageEdit({
  store,
  assetRoot,
  workerId,
  mock = false,
  openclaw,
}) {
  try { if (!mock) openclaw?.assertAvailable?.(); }
  catch (error) {
    const code = codexErrorCode(error);
    if (!code) throw error;
    return { status: 'blocked', reason: code, haltWorker: error.haltWorker === true, retryAt: error.retryAt };
  }
  const request = store.claimNextImageEdit({ workerId });
  if (!request) return { status: 'idle' };
  const source = store.getAsset(request.sourceAssetId);
  const config = store.getWorkerConfig(request.taskId);
  const root = resolve(assetRoot);
  const sourcePath = source ? safeAbsolute(root, source.relativePath) : null;
  const fileName = `ai-edit-${randomUUID()}.png`;
  const relativePath = `revisions/${request.taskId}/${fileName}`;
  const outputPath = safeAbsolute(root, relativePath);
  const rawPath = safeAbsolute(root, `revisions/${request.taskId}/.raw-${randomUUID()}.png`);

  try {
    if (!source || !config || !sourcePath) throw new Error('image edit source or task configuration is missing');
    await mkdir(dirname(outputPath), { recursive: true });
    let model = null;
    let provider = 'openclaw';
    let alignment = null;
    if (mock) {
      await sharp(sourcePath, { failOn: 'error', limitInputPixels: 40_000_000 })
        .resize(DELIVERY_IMAGE_WIDTH, DELIVERY_IMAGE_HEIGHT, { fit: 'cover', position: 'attention' })
        .png({ compressionLevel: 8 })
        .toFile(outputPath);
    } else {
      const productionSettings = normalizeProductionSettings(config.productionSettings ?? {});
      const client = openclaw ?? createOpenClawClient({ modelApi: productionSettings.modelApi });
      const complianceDisclosure = productionDisclosure(productionSettings);
      const prompt = renderPrompt(config.imageEditPromptContent, {
        query: config.query,
        category: config.input?.category,
        targetAudience: config.input?.targetAudience,
        imageIndex: 1,
        imageCount: config.imageCount,
        reviewInstruction: request.instruction,
      });
      const generated = await client.runImageEdit({
        prompt,
        inputPaths: [sourcePath],
        outputPath: rawPath,
      });
      model = generated.model;
      provider = client.provider ?? 'openclaw';
      await sharp(generated.outputPath, { failOn: 'error', limitInputPixels: 40_000_000 })
        .resize(DELIVERY_IMAGE_WIDTH, DELIVERY_IMAGE_HEIGHT, { fit: 'cover', position: 'attention' })
        .png({ compressionLevel: 8 })
        .toFile(outputPath);
      if (source.sourceTextRevisionId && source.pageIndex) {
        const detail = store.getTask(request.taskId);
        const latestRun = detail?.generationRuns?.slice().reverse().find((run) => run.outputDir);
        if (!latestRun) throw new Error('image edit alignment requires a previous generation run');
        const [post, visualPlan] = await Promise.all([
          readFile(resolve(latestRun.outputDir, 'post.json'), 'utf8').then(JSON.parse),
          readFile(resolve(latestRun.outputDir, 'visual-plan.json'), 'utf8').then(JSON.parse),
        ]);
        const visualPage = visualPlan.pages?.[source.pageIndex - 1];
        if (!visualPage) throw new Error('image edit visual page is missing');
        await applyDeterministicTextOverlay({
          imagePath: outputPath,
          visibleText: visualPage.allowedVisibleText,
          disclosure: complianceDisclosure,
          pageKind: visualPage.kind,
          layoutDirection: visualPage.layoutDirection,
        });
        const validateImage = createImageAlignmentValidator({
          openclaw: client,
          post,
          visualPlan,
          imageCount: config.imageCount,
          complianceDisclosure,
        });
        alignment = await validateImage({ imagePath: outputPath, pageIndex: source.pageIndex, attempt: 1 });
      }
    }
    const content = await readFile(outputPath);
    const metadata = await sharp(content, { limitInputPixels: 40_000_000 }).metadata();
    const asset = store.addAsset({
      taskId: request.taskId,
      kind: 'EDITED',
      parentAssetId: source.id,
      fileName,
      relativePath,
      mimeType: 'image/png',
      width: metadata.width,
      height: metadata.height,
      sha256: createHash('sha256').update(content).digest('hex'),
      source: mock ? 'mock:image-edit' : `${provider}:image-edit:${model}`,
      sourceTextRevisionId: source.sourceTextRevisionId,
      pageIndex: source.pageIndex,
      visualPlanSha256: source.visualPlanSha256,
      alignmentStatus: alignment?.passed === true
        ? 'PASSED'
        : source.sourceTextRevisionId ? 'FAILED' : 'NOT_APPLICABLE',
      alignmentResult: alignment ?? {
        parentAlignmentStatus: source.alignmentStatus,
        reason: mock
          ? 'mock AI image edit is not eligible for visual approval'
          : 'reference-only AI image edit has no delivery page contract',
      },
    });
    store.completeImageEdit(request.id, { workerId, resultAssetId: asset.id });
    return { status: 'completed', requestId: request.id, taskId: request.taskId, assetId: asset.id };
  } catch (error) {
    await unlink(outputPath).catch(() => {});
    store.failImageEdit(request.id, { workerId, error });
    return {
      status: 'failed',
      requestId: request.id,
      taskId: request.taskId,
      error: publicError(error),
      reason: codexErrorCode(error),
      haltWorker: ['CODEX_QUOTA_EXHAUSTED', 'CODEX_AUTH_REQUIRED'].includes(codexErrorCode(error)),
    };
  } finally {
    await unlink(rawPath).catch(() => {});
  }
}
