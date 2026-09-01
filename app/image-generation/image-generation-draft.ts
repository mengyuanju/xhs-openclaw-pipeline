export const IMAGE_GENERATION_DRAFT_STORAGE_KEY = 'xhs:image-generation-draft:v1';

const IMAGE_KINDS = new Set(['hero', 'steps', 'checklist', 'comparison', 'detail', 'summary']);

export type ImageGenerationDraftPage = {
  kind: 'hero' | 'steps' | 'checklist' | 'comparison' | 'detail' | 'summary';
  headline: string;
  subtitle: string;
  bullets: string[];
  prompt: string;
};

export type ImageGenerationDraft = {
  version: 1;
  createdAt: string;
  query: string;
  copy: {
    title: string;
    body: string;
    tags: string[];
  };
  imagePlan: ImageGenerationDraftPage[];
};

type DraftStorage = Pick<Storage, 'getItem' | 'setItem'>;

type ImageGenerationDraftInput = Pick<ImageGenerationDraft, 'query' | 'copy' | 'imagePlan'>;

function isBoundedString(value: unknown, minimum: number, maximum: number) {
  return typeof value === 'string'
    && value === value.trim()
    && value.length >= minimum
    && value.length <= maximum;
}

function isDraftPage(value: unknown, index: number): value is ImageGenerationDraftPage {
  if (!value || typeof value !== 'object') return false;
  const page = value as Record<string, unknown>;
  if (typeof page.kind !== 'string' || !IMAGE_KINDS.has(page.kind)) return false;
  if (index === 0 ? page.kind !== 'hero' : page.kind === 'hero') return false;
  return isBoundedString(page.headline, 1, 18)
    && isBoundedString(page.subtitle, 1, 30)
    && Array.isArray(page.bullets)
    && page.bullets.length >= 2
    && page.bullets.length <= 5
    && page.bullets.every((bullet) => isBoundedString(bullet, 1, 40)
      && (page.kind === 'checklist' || [...bullet].length <= 30))
    && isBoundedString(page.prompt, 10, 1_000);
}

function isImageGenerationDraft(value: unknown): value is ImageGenerationDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Record<string, unknown>;
  if (draft.version !== 1 || typeof draft.createdAt !== 'string' || Number.isNaN(Date.parse(draft.createdAt))) return false;
  if (!isBoundedString(draft.query, 1, 500) || !draft.copy || typeof draft.copy !== 'object') return false;
  const copy = draft.copy as Record<string, unknown>;
  if (!isBoundedString(copy.title, 1, 25) || !isBoundedString(copy.body, 200, 700)) return false;
  if (!Array.isArray(copy.tags) || copy.tags.length < 3 || copy.tags.length > 8) return false;
  if (!copy.tags.every((tag) => isBoundedString(tag, 2, 20) && /^#[^#\s]+$/u.test(tag))) return false;
  return Array.isArray(draft.imagePlan)
    && draft.imagePlan.length >= 3
    && draft.imagePlan.length <= 5
    && draft.imagePlan.every(isDraftPage);
}

export function createImageGenerationDraft(input: ImageGenerationDraftInput): ImageGenerationDraft {
  const draft: ImageGenerationDraft = {
    version: 1,
    createdAt: new Date().toISOString(),
    query: input.query,
    copy: {
      title: input.copy.title,
      body: input.copy.body,
      tags: [...input.copy.tags],
    },
    imagePlan: input.imagePlan.map((page) => ({
      ...page,
      bullets: [...page.bullets],
    })),
  };
  if (!isImageGenerationDraft(draft)) {
    throw new Error('当前质检版不能导入图片生成，请检查文案长度、标签和图片策划');
  }
  return draft;
}

export function writeImageGenerationDraft(storage: DraftStorage, draft: ImageGenerationDraft) {
  storage.setItem(IMAGE_GENERATION_DRAFT_STORAGE_KEY, JSON.stringify(draft));
}

export function readImageGenerationDraft(storage: DraftStorage) {
  const raw = storage.getItem(IMAGE_GENERATION_DRAFT_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isImageGenerationDraft(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
