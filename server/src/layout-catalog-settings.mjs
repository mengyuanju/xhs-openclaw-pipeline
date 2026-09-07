import { createHash } from 'node:crypto';
import { BUILTIN_LAYOUT_CATALOG, importLayoutTemplates, normalizeLayoutCatalog, templateKey } from './layout-catalog.mjs';

export function layoutCatalogRecord(settings = {}) {
  const catalog = normalizeLayoutCatalog(settings.layoutCatalog);
  return { catalog, revision: createHash('sha256').update(JSON.stringify(catalog)).digest('hex') };
}

export function changeLayoutCatalog(settings, input, { modelTemplates } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('目录操作无效');
  const record = layoutCatalogRecord(settings);
  if (input.expectedRevision !== record.revision) {
    const error = new TypeError('布局目录已被其他操作修改，请刷新后重试');
    error.code = 'CATALOG_CONFLICT'; throw error;
  }
  let result;
  if (input.operation === 'BUILTIN') result = importLayoutTemplates(record.catalog, BUILTIN_LAYOUT_CATALOG.templates);
  else if (input.operation === 'IMPORT') result = importLayoutTemplates(record.catalog, modelTemplates ?? input.templates, { source: modelTemplates ? 'MODEL' : 'MANUAL' });
  else if (input.operation === 'REPLACE') {
    const catalog = normalizeLayoutCatalog(input.catalog);
    if (!catalog) throw new TypeError('目录不能为空；可停用其中的模板');
    const previous = new Map((record.catalog?.templates ?? []).map(item => [templateKey(item), item]));
    const retained = new Set(catalog.templates.map(templateKey));
    if ([...previous.keys()].some(key => !retained.has(key))) throw new TypeError('历史模板版本不可删除；请停用模板或新增版本');
    for (const item of catalog.templates) {
      const prior = previous.get(templateKey(item));
      if (prior && JSON.stringify({ ...prior, enabled: item.enabled }) !== JSON.stringify(item)) throw new TypeError(`模板版本冲突：${templateKey(item)}，修改设计请新增版本`);
    }
    result = { catalog, added: catalog.templates.filter(item => !previous.has(templateKey(item))).length, unchanged: 0 };
  } else throw new TypeError('目录操作必须为 BUILTIN、IMPORT 或 REPLACE');
  return { settings: { ...settings, layoutCatalog: result.catalog }, record: { ...layoutCatalogRecord({ layoutCatalog: result.catalog }), added: result.added, unchanged: result.unchanged } };
}
