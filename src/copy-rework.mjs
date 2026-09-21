import { normalizePageLayout } from '../server/src/image-options.mjs';

const RETURN_ORIGINS = new Set(['QA_RETURN', 'FINAL_REWORK']);

function text(value) {
  return typeof value === 'string' ? value.replace(/\r\n?/gu, '\n').trim() : '';
}

function textList(value) {
  return Array.isArray(value) ? value.map(text) : [];
}

// Compare only editable content. Metadata, image settings and default AUTO
// layouts must never turn an untouched return into a completed rework.
export function copyReworkContent(content) {
  const copy = content?.copy ?? content?.reviewed?.copy ?? content?.post;
  const plan = content?.imagePlan ?? content?.reviewed?.imagePlan ?? content?.post?.imagePlan;
  return {
    copy: { title: text(copy?.title), body: text(copy?.body), tags: textList(copy?.tags) },
    imagePlan: (Array.isArray(plan) ? plan : []).map(page => ({
      kind: text(page.kind),
      headline: text(page.headline),
      subtitle: text(page.subtitle),
      bullets: textList(page.bullets),
      prompt: text(page.prompt),
      layout: normalizePageLayout(page.layout ?? { mode: 'AUTO' }, page.kind),
    })),
  };
}

export function copyReworkChanges(baseline, content) {
  const before = copyReworkContent(baseline);
  const after = copyReworkContent(content);
  const copyChanged = JSON.stringify(before.copy) !== JSON.stringify(after.copy);
  const imagePlanChanged = JSON.stringify(before.imagePlan) !== JSON.stringify(after.imagePlan);
  return { copyChanged, imagePlanChanged, satisfied: copyChanged || imagePlanChanged };
}

// The nearest return starts a new round, regardless of edits in older rounds.
export function findCopyReworkBaseline(revisions, revisionId) {
  const byId = new Map(revisions.map(revision => [Number(revision.id), revision]));
  const visited = new Set();
  let revision = byId.get(Number(revisionId));
  while (revision && !visited.has(Number(revision.id))) {
    if (RETURN_ORIGINS.has(revision.revisionOrigin)) return revision;
    visited.add(Number(revision.id));
    revision = byId.get(Number(revision.parentRevisionId));
  }
  return null;
}
