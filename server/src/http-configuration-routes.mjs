import { requestActor, json, requireJson, safeStoragePath } from './http-route-common.mjs';
import { generateAndImportLayouts } from '../../src/admin/layout-catalog-service.mjs';
import { readPromptConfiguration, savePromptPolicy } from '../../src/admin/prompt-runtime-service.mjs';
import { assertPromptEditable, normalizePromptContent } from '../../src/admin/prompt-service.mjs';
import { assertPromptPublishable } from '../../src/admin/prompt-preview.mjs';
import { listCopyAnalysisPrompts, saveCopyAnalysisPrompt, importCopyKnowledgeLabels, retireKnowledge } from './knowledge-admin.mjs';
import { withPromptExecution, readPromptExecution, listPromptExecutions } from '../../src/admin/prompt-execution.mjs';
import { uploadKnowledgeAsset } from './http-asset-storage.mjs';
import { ControlPlaneNotFoundError } from './domain.mjs';
import { relative } from 'node:path';
import { readFile } from 'node:fs/promises';
export function installConfigurationRoutes({
  router,
  repository,
  storageRoot,
  analyzeCopy,
  analyzeVisual
}) {
  router.get('/v1/workflow-quality-settings', async ctx => {
    requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.getWorkflowQualitySettings());
  });
  router.put('/v1/workflow-quality-settings', async ctx => {
    const actor = requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.updateWorkflowQualitySettings(requireJson(ctx), {
      actor
    }));
  });
  router.get('/v1/layout-catalog', async ctx => {
    requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.getLayoutCatalog());
  });
  router.post('/v1/layout-catalog', async ctx => {
    requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.updateLayoutCatalog(requireJson(ctx)));
  });
  router.post('/v1/layout-catalog/generate', async ctx => {
    requestActor(ctx, ['ADMIN']);
    const controlPlane = {
      listPrompts: () => repository.listPrompts(),
      listSettings: () => repository.listSettings(),
      listKnowledge: () => repository.listKnowledge()
    };
    json(ctx, 201, await generateAndImportLayouts({
      input: requireJson(ctx),
      outputRoot: storageRoot,
      configuration: await readPromptConfiguration({
        controlPlane
      }),
      readCatalog: () => repository.getLayoutCatalog(),
      updateCatalog: (change, options) => repository.updateLayoutCatalog(change, options)
    }));
  });
  router.get('/v1/human-quality-settings', async ctx => {
    requestActor(ctx);
    json(ctx, 200, await repository.getHumanQualitySettings());
  });
  router.put('/v1/human-quality-settings', async ctx => {
    requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.updateHumanQualitySettings(requireJson(ctx)));
  });
  router.get('/v1/settings', async ctx => {
    // Existing executors have no user session. Startup only needs the provider;
    // full configuration is delivered later in their existing claim snapshot.
    if (!ctx.state.actor) {
      const records = await repository.listSettings();
      const agentProvider = records.find(record => record.key === 'production')?.value?.modelApi?.agentProvider;
      return json(ctx, 200, [{
        key: 'production',
        value: {
          modelApi: agentProvider ? {
            agentProvider
          } : {}
        }
      }]);
    }
    requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.listSettings());
  });
  router.put('/v1/settings/:key', async ctx => {
    requestActor(ctx, ['ADMIN']);
    const body = requireJson(ctx);
    if (ctx.params.key === 'prompt_runtime') {
      const controlPlane = {
        listPrompts: () => repository.listPrompts(),
        updateSetting: (key, value) => repository.upsertSetting(key, value)
      };
      json(ctx, 200, await savePromptPolicy(body.value, {
        controlPlane
      }));
    } else json(ctx, 200, await repository.upsertSetting(ctx.params.key, body.value, {
      expectedVersion: body.expectedVersion
    }));
  });
  router.get('/v1/prompts', async ctx => {
    requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.listPrompts());
  });
  router.post('/v1/prompts/versions', async ctx => {
    requestActor(ctx, ['ADMIN']);
    const body = requireJson(ctx);
    assertPromptEditable(body.kind, body.content);
    json(ctx, 201, await repository.createPromptVersion({
      ...body,
      content: normalizePromptContent(body.content)
    }));
  });
  router.post('/v1/prompt-versions/:versionId/publish', async ctx => {
    requestActor(ctx, ['ADMIN']);
    const templates = await repository.listPrompts();
    const template = templates.find(item => item.versions.some(version => Number(version.id) === Number(ctx.params.versionId)));
    const version = template?.versions.find(item => Number(item.id) === Number(ctx.params.versionId));
    if (version) assertPromptPublishable(template.kind, version.content);
    json(ctx, 200, await repository.publishPromptVersion(ctx.params.versionId));
  });
  router.get('/v1/knowledge', async ctx => {
    requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.listKnowledge());
  });
  router.get('/v1/knowledge/capabilities', ctx => {
    requestActor(ctx, ['ADMIN']);
    json(ctx, 200, {
      workbenchVersion: 1,
      copyKnowledgePaginationVersion: 1
    });
  });
  router.get('/v1/copy-knowledge', async ctx => {
    requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.listCopyKnowledgeOverview(ctx.query));
  });
  router.get('/v1/copy-analysis-prompts', async ctx => {
    requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await listCopyAnalysisPrompts(repository.pool));
  });
  router.post('/v1/copy-analysis-prompts', async ctx => {
    requestActor(ctx, ['ADMIN']);
    json(ctx, 201, await saveCopyAnalysisPrompt(repository.pool, requireJson(ctx)));
  });
  router.patch('/v1/copy-analysis-prompts/:id', async ctx => {
    requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await saveCopyAnalysisPrompt(repository.pool, requireJson(ctx), ctx.params.id));
  });
  router.post('/v1/knowledge/labels/import', async ctx => {
    requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await importCopyKnowledgeLabels(repository.pool, requireJson(ctx).labels));
  });
  router.post('/v1/copy-knowledge/analyze', async ctx => {
    requestActor(ctx, ['ADMIN']);
    const controlPlane = {
      listPrompts: () => repository.listPrompts(),
      listSettings: () => repository.listSettings(),
      listKnowledge: () => repository.listKnowledge()
    };
    const configuration = await readPromptConfiguration({
      controlPlane
    });
    json(ctx, 201, await withPromptExecution({
      outputRoot: storageRoot,
      configuration,
      kind: 'COPY_ANALYSIS'
    }, () => analyzeCopy({
      repository,
      input: requireJson(ctx)
    })));
  });
  router.post('/v1/visual-knowledge/analyze', async ctx => {
    requestActor(ctx, ['ADMIN']);
    const body = requireJson(ctx);
    if (typeof body.imageBase64 !== 'string' || body.imageBase64.length > 14_000_000) throw new TypeError('图片输入无效');
    const controlPlane = {
      listPrompts: () => repository.listPrompts(),
      listSettings: () => repository.listSettings(),
      listKnowledge: () => repository.listKnowledge()
    };
    const configuration = await readPromptConfiguration({
      controlPlane
    });
    const result = await withPromptExecution({
      outputRoot: storageRoot,
      configuration,
      kind: 'VISUAL_ANALYSIS'
    }, () => analyzeVisual({
      buffer: Buffer.from(body.imageBase64, 'base64'),
      mimeType: body.mimeType,
      fileName: body.fileName,
      modelApi: configuration.productionSettings.modelApi
    }));
    json(ctx, 201, result);
  });
  router.get('/v1/prompt-runs', async ctx => {
    requestActor(ctx, ['ADMIN']);
    json(ctx, 200, ctx.query.id ? await readPromptExecution(storageRoot, String(ctx.query.id)) : await listPromptExecutions(storageRoot));
  });
  router.post('/v1/knowledge/:id/retire', async ctx => {
    requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await retireKnowledge(repository.pool, ctx.params.id));
  });
  router.post('/v1/knowledge/versions', async ctx => {
    requestActor(ctx, ['ADMIN']);
    const body = requireJson(ctx);
    json(ctx, 201, await repository.createKnowledgeVersion({
      itemId: body.itemId ?? null,
      kind: body.kind,
      name: body.name,
      content: body.content ?? {},
      publish: body.publish ?? false,
      expectedVersionId: body.expectedVersionId ?? null
    }));
  });
  router.put('/v1/knowledge-versions/:versionId/asset', async ctx => {
    requestActor(ctx, ['ADMIN']);
    json(ctx, 201, await uploadKnowledgeAsset({
      ctx,
      repository,
      storageRoot,
      versionId: ctx.params.versionId
    }));
  });
  router.get('/v1/knowledge-versions/:versionId/asset', async ctx => {
    requestActor(ctx, ['ADMIN']);
    const asset = await repository.getKnowledgeAsset(ctx.params.versionId);
    if (!asset) throw new ControlPlaneNotFoundError('knowledge asset not found');
    const path = safeStoragePath(storageRoot, relative(storageRoot, asset.storagePath));
    ctx.status = 200;
    ctx.type = 'image/png';
    ctx.body = await readFile(path);
  });
  router.post('/v1/knowledge-versions/:versionId/publish', async ctx => {
    requestActor(ctx, ['ADMIN']);
    json(ctx, 200, await repository.publishKnowledgeVersion(ctx.params.versionId));
  });
}
