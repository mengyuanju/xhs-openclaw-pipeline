import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

const contexts = new AsyncLocalStorage();
const hash = value => createHash('sha256').update(value).digest('hex');

export function withPromptTraceContext(snapshot, action) {
  const versions = Object.entries(snapshot?.prompts ?? {}).flatMap(([kind, item]) =>
    typeof item?.content === 'string' ? [{ kind, versionId: item.versionId ?? item.id ?? null,
      version: item.version ?? null, templateSha256: hash(item.content), source: 'EXECUTION_SNAPSHOT' }] : []);
  return contexts.run({ versions, rendered: new Map(), capturedAt: snapshot?.capturedAt ?? null }, action);
}

// Register at rendering time. A later request only claims versions whose rendered
// text is actually included; a template used in an earlier call is not enough.
export function recordPromptRendering({ template, rendered, kind, version, source }) {
  const context = contexts.getStore();
  if (!context || !rendered.trim()) return;
  const templateSha256 = hash(template);
  const renderedSha256 = hash(rendered);
  const candidates = source ? [{ kind, versionId: version?.versionId ?? version?.id ?? null,
    version: version?.version ?? null, templateSha256, source }]
    : context.versions.filter(item => item.templateSha256 === templateSha256 && (!kind || item.kind === kind));
  const matches = candidates.length === 1 ? candidates : [{ kind: kind ?? 'UNVERSIONED',
    versionId: null, version: null, templateSha256, source: candidates.length ? 'AMBIGUOUS' : 'UNVERSIONED' }];
  const matchText = source && kind ? `<trusted_business_rules kind="${kind}">\n${rendered}\n</trusted_business_rules>` : rendered;
  for (const item of matches) context.rendered.set(`${item.kind}:${renderedSha256}`, { ...item, renderedSha256, matchText });
}

function textParts(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(textParts);
  return value && typeof value === 'object' ? Object.values(value).flatMap(textParts) : [];
}

export function requestPromptProvenance(prompt) {
  const context = contexts.getStore();
  const parts = textParts(prompt);
  return { capturedAt: context?.capturedAt ?? null,
    versions: [...(context?.rendered.values() ?? [])]
      .filter(item => parts.some(part => part.includes(item.matchText)))
      .map(({ matchText, ...version }) => version) };
}
