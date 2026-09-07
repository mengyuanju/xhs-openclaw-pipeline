import { PAGE_TEMPLATES, normalizePageLayout } from './image-options.mjs';

export const LAYOUT_KIND_LABELS = Object.freeze({ all: '所有页面', hero: '封面', steps: '步骤', detail: '细节', comparison: '对比', checklist: '清单', summary: '总结' });

/** @param {unknown} value */
export function normalizeLayoutPresets(value = []) {
  if (!Array.isArray(value) || value.length > 50) throw new TypeError('布局种类必须是数组，最多 50 项');
  const ids = new Set();
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('布局种类格式无效');
    for (const key of Object.keys(item)) if (!['id', 'name', 'kind', 'enabled', 'layout'].includes(key)) throw new TypeError(`布局种类不支持字段 ${key}`);
    if (typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/u.test(item.id) || ids.has(item.id)) throw new TypeError('布局种类标识无效或重复');
    ids.add(item.id);
    if (typeof item.name !== 'string' || !item.name.trim() || [...item.name.trim()].length > 60) throw new TypeError('布局名称需为 1–60 个字符');
    if (item.kind !== 'all' && !Object.hasOwn(PAGE_TEMPLATES, item.kind)) throw new TypeError('布局适用页面类型无效');
    if (typeof item.enabled !== 'boolean') throw new TypeError('布局启用状态必须是布尔值');
    if (item.layout?.mode !== 'CUSTOM') throw new TypeError('布局种类需要自定义格式');
    return { id: item.id, name: item.name.trim(), kind: item.kind, enabled: item.enabled,
      layout: normalizePageLayout(item.layout, item.kind) };
  });
}
