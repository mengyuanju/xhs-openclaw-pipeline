import { generateLayoutCandidates } from '../layout-catalog-generation.mjs';
import { withPromptExecution } from './prompt-execution.mjs';

export async function generateAndImportLayouts({ input, configuration, outputRoot, readCatalog, updateCatalog, generate = generateLayoutCandidates }) {
  const record = await readCatalog();
  if (record.revision !== input.expectedRevision) { const error = new TypeError('布局目录已变化，请刷新后再生成'); error.code = 'CATALOG_CONFLICT'; throw error; }
  const runtime = configuration.promptRuntime?.prompts?.LAYOUT_CATALOG_SYSTEM ? configuration.promptRuntime : null;
  const promptSource = runtime ? 'PUBLISHED' : 'BUNDLED_DEFAULT';
  return withPromptExecution({ outputRoot, configuration: { ...configuration, promptRuntime: runtime, source: promptSource }, kind: 'LAYOUT_CATALOG', query: input.brief }, async () => {
    const result = await generate({ brief: input.brief, catalog: record.catalog, modelApi: configuration.productionSettings?.modelApi });
    const imported = await updateCatalog({ operation: 'IMPORT', expectedRevision: record.revision }, { modelTemplates: result.templates });
    return { ...imported, model: result.model, promptSource };
  });
}
