const cleanText = value => String(value).normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();

function disclosure(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.type !== 'AI_GENERATED' || typeof value.text !== 'string') return null;
  const text = value.text.trim();
  return text && text.length <= 200 ? { type: 'AI_GENERATED', text } : null;
}

export function imagePageDisclosure(result, page) {
  if (!Number.isInteger(page) || page < 1) return null;
  const image = result?.images?.[page - 1];
  if (!image || typeof image !== 'object' || Array.isArray(image)) return null;
  const explicit = disclosure(image.imageEditDisclosure);
  if (explicit) return explicit;
  const legacy = disclosure(result?.imageEditValidation?.disclosure?.added);
  if (!legacy || !Array.isArray(image.imageEditRequiredText)) return null;
  return image.imageEditRequiredText.some(text => (
    typeof text === 'string' && cleanText(text) === cleanText(legacy.text)
  )) ? legacy : null;
}

// Older executors read the run-level field. Scope that compatibility field to
// the requested page without changing the immutable result stored in PostgreSQL.
export function imageResultScopedToPage(result, page) {
  const validation = result?.imageEditValidation;
  if (!validation || typeof validation !== 'object' || Array.isArray(validation)
      || !validation.disclosure || typeof validation.disclosure !== 'object') return result;
  return {
    ...result,
    imageEditValidation: {
      ...validation,
      disclosure: { ...validation.disclosure, added: imagePageDisclosure(result, page) },
    },
  };
}

// Version-1 executors infer a disclosure from production settings whenever a
// non-text AI edit has no run-level disclosure. Prevent that legacy fallback
// for pages whose immutable lineage does not prove the label is present.
export function imageSettingsScopedToPage(settings, result, page) {
  if (imagePageDisclosure(result, page)) return settings;
  return { ...(settings ?? {}), aiDisclosureEnabled: false };
}
