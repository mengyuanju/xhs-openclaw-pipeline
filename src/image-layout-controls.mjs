import { internalPrompt } from './prompt-runtime.mjs';
import { PAGE_TEMPLATES, normalizePageLayout, normalizeImageSettings } from '../server/src/image-options.mjs';
import { normalizeLayoutPresets } from '../server/src/layout-library.mjs';
import { normalizeLayoutCatalog } from '../server/src/layout-catalog.mjs';

export function preparePageLayouts(post, presets = [], layoutCatalog = null) {
  // Catalog selection happens inside visual planning. Explicit page layouts remain pinned.
  return normalizeLayoutCatalog(layoutCatalog) ? post : assignRandomLayouts(post, presets);
}

// Resolve once before persisting the source/checkpoint; saved layouts survive retries.
export function assignRandomLayouts(post, presets = [], random = Math.random) {
  const library = normalizeLayoutPresets(presets).filter(item => item.enabled);
  return { ...post, imagePlan: post.imagePlan.map(page => {
    if (page.layout && page.layout.mode !== 'AUTO') return page;
    const candidates = [
      ...(PAGE_TEMPLATES[page.kind] ?? []).map(template => ({ mode: 'TEMPLATE', template })),
      ...library.filter(item => item.kind === 'all' || item.kind === page.kind).map(item => item.layout),
    ];
    if (!candidates.length) throw new TypeError(`no layout available for ${page.kind}`);
    return { ...page, layout: { ...candidates[Math.floor(random() * candidates.length)] } };
  }) };
}

export function requestedLayoutTemplate(page) {
  const layout = page.layout && normalizePageLayout(page.layout, page.kind);
  return layout?.mode === 'CUSTOM' ? 'CUSTOM' : layout?.mode === 'TEMPLATE' ? layout.template : null;
}

export function attachPageLayout(visualPage, page) {
  if (!page.layout) return visualPage;
  const manualLayout = normalizePageLayout(page.layout, page.kind);
  return { ...visualPage, manualLayout, layoutTemplate: requestedLayoutTemplate(page) ?? visualPage.layoutTemplate };
}

export function imageControlsPrompt(post, page) {
  const pages = page ? [page] : post.imagePlan;
  const layouts = pages.flatMap((item, index) => item.layout && item.layout.mode !== 'AUTO'
    ? [{ pageIndex: page ? undefined : index + 1, kind: item.kind, ...normalizePageLayout(item.layout, item.kind) }] : []);
  const settings = post.imageSettings ? normalizeImageSettings(post.imageSettings) : null;
  if (!layouts.length && !settings) return '';
  const data = JSON.stringify({ layouts, imageSettings: settings }).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
  return internalPrompt('INTERNAL_IMAGE_MANUAL_LAYOUT', { slot1: (data), slot2: (settings ? settings.background === 'SOLID' ? internalPrompt('INTERNAL_IMAGE_SOLID_BACKGROUND', { slot1: (settings.backgroundColor) }) : internalPrompt('INTERNAL_TRANSPARENT_BACKGROUND') : '') });
}
