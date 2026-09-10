'use client';

import { Layers3, LoaderCircle, Plus, Trash2, Upload } from 'lucide-react';
import {
  useState,
  type Dispatch,
  type SetStateAction,
  type SyntheticEvent,
} from 'react';

import { Textarea } from '@/components/ui/textarea';
import { adminFetch } from '@/lib/admin-fetch';
import {
  formatBytes,
  MAX_BATCH_IMAGE_COUNT,
  MAX_BATCH_PREVIEW_COUNT,
  MAX_BODY_LENGTH,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_COUNT,
  MAX_TITLE_LENGTH,
  MAX_TOTAL_IMAGE_BYTES,
} from '@/lib/preview-contract';
import type { PreviewSummary } from '@/lib/preview-types';

export interface BatchPreviewDraft {
  id: string;
  title: string;
  body: string;
  files: File[];
}

interface BatchPreviewCreatorProps {
  drafts: BatchPreviewDraft[];
  onDraftsChange: Dispatch<SetStateAction<BatchPreviewDraft[]>>;
  onStart: () => void;
  onCreated: (previews: PreviewSummary[]) => void;
  onError: (message: string) => void;
}

interface ApiErrorBody {
  error?: { message?: string };
}

function emptyBatchDraft(id: string): BatchPreviewDraft {
  return { id, title: '', body: '', files: [] };
}

export function BatchPreviewCreator({
  drafts,
  onDraftsChange,
  onStart,
  onCreated,
  onError,
}: BatchPreviewCreatorProps) {
  const [submitting, setSubmitting] = useState(false);
  const totalImageCount = drafts.reduce(
    (total, draft) => total + draft.files.length,
    0,
  );
  const totalBytes = drafts.reduce(
    (total, draft) =>
      total + draft.files.reduce((sum, file) => sum + file.size, 0),
    0,
  );

  function updateDraft(id: string, patch: Partial<BatchPreviewDraft>) {
    onDraftsChange((current) =>
      current.map((draft) =>
        draft.id === id ? { ...draft, ...patch, id: draft.id } : draft,
      ),
    );
  }

  function addDraft() {
    if (drafts.length >= MAX_BATCH_PREVIEW_COUNT) {
      onError(`每批最多创建 ${MAX_BATCH_PREVIEW_COUNT} 条预览。`);
      return;
    }
    onError('');
    onDraftsChange((current) => [
      ...current,
      emptyBatchDraft(crypto.randomUUID()),
    ]);
  }

  function removeDraft(id: string) {
    if (drafts.length === 1) {
      return;
    }
    onDraftsChange((current) => current.filter((draft) => draft.id !== id));
  }

  async function createBatch(
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ) {
    event.preventDefault();
    const validationError = validateDrafts(drafts);
    if (validationError) {
      onError(validationError);
      return;
    }

    const form = event.currentTarget;
    const formData = new FormData();
    formData.set(
      'manifest',
      JSON.stringify({
        items: drafts.map((draft) => ({
          clientId: draft.id,
          title: draft.title,
          body: draft.body,
        })),
      }),
    );
    for (const draft of drafts) {
      for (const file of draft.files) {
        formData.append(`images.${draft.id}`, file, file.name);
      }
    }

    setSubmitting(true);
    onStart();
    onError('');
    try {
      const response = await adminFetch('/api/admin/previews/batch', {
        method: 'POST',
        body: formData,
      });
      if (!response.ok) {
        throw new Error(await readApiError(response));
      }
      const data = (await response.json()) as {
        items?: Array<{ preview?: PreviewSummary }>;
      };
      const previews =
        data.items?.map((item) => item.preview).filter(isPreviewSummary) ?? [];
      if (previews.length !== drafts.length) {
        throw new Error('批量创建返回的记录数量不正确，请刷新记录确认结果。');
      }
      form.reset();
      onCreated(previews);
    } catch (error) {
      onError(
        error instanceof Error ? error.message : '批量创建失败，请重试。',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={createBatch}
      className="overflow-hidden rounded-[18px] border border-border bg-card shadow-[0_12px_34px_rgb(24_25_34/6%)]"
    >
      <div className="flex min-h-[62px] flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3.5">
        <h2 className="text-lg font-medium">批量创建预览</h2>
        <button
          type="button"
          onClick={addDraft}
          disabled={drafts.length >= MAX_BATCH_PREVIEW_COUNT || submitting}
          className="inline-flex h-9 items-center justify-center gap-1.5 rounded-[9px] border border-border bg-background px-3 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        >
          <Plus className="size-3.5" aria-hidden="true" />
          添加一条
        </button>
      </div>

      <div className="grid gap-3.5 p-5">
        {drafts.map((draft, index) => {
          const itemBytes = draft.files.reduce(
            (total, file) => total + file.size,
            0,
          );
          const imageInputId = `batch-images-${draft.id}`;
          return (
            <article
              key={draft.id}
              className="overflow-hidden rounded-[12px] bg-muted/70"
            >
              <div className="flex items-center justify-between px-3.5 pt-3.5">
                <span className="text-sm font-semibold">
                  第 {index + 1} 条预览
                </span>
                <button
                  type="button"
                  aria-label={`删除第 ${index + 1} 条`}
                  disabled={drafts.length === 1 || submitting}
                  onClick={() => removeDraft(draft.id)}
                  className="grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                </button>
              </div>

              <div className="grid gap-4 p-3.5 pt-3">
                <div className="grid gap-2">
                  <label
                    htmlFor={`batch-title-${draft.id}`}
                    className="text-sm font-medium"
                  >
                    标题 <span className="text-primary">*</span>
                  </label>
                  <input
                    id={`batch-title-${draft.id}`}
                    required
                    maxLength={MAX_TITLE_LENGTH}
                    value={draft.title}
                    onChange={(event) =>
                      updateDraft(draft.id, { title: event.target.value })
                    }
                    placeholder="输入预览标题"
                    className={batchInputClassName}
                  />
                </div>

                <div className="grid gap-2">
                  <label
                    htmlFor={`batch-body-${draft.id}`}
                    className="text-sm font-medium"
                  >
                    正文
                  </label>
                  <Textarea
                    id={`batch-body-${draft.id}`}
                    maxLength={MAX_BODY_LENGTH}
                    value={draft.body}
                    onChange={(event) =>
                      updateDraft(draft.id, { body: event.target.value })
                    }
                    placeholder="输入需要展示的文案……"
                    className="min-h-28 resize-y bg-card px-3 py-3 leading-6"
                  />
                </div>

                <div className="grid gap-2">
                  <span className="text-sm font-medium">
                    原图 <span className="text-primary">*</span>
                  </span>
                  <input
                    id={imageInputId}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
                    multiple
                    className="sr-only"
                    onChange={(event) => {
                      const files = Array.from(event.target.files ?? []);
                      if (files.length > MAX_IMAGE_COUNT) {
                        onError(
                          `第 ${index + 1} 条最多选择 ${MAX_IMAGE_COUNT} 张原图。`,
                        );
                        event.target.value = '';
                        updateDraft(draft.id, { files: [] });
                        return;
                      }
                      onError('');
                      updateDraft(draft.id, { files });
                    }}
                  />
                  <label
                    htmlFor={imageInputId}
                    className="flex min-h-20 cursor-pointer items-center gap-3 rounded-[13px] border border-dashed border-primary/35 bg-card px-4 py-3 transition-colors hover:border-primary/60 hover:bg-primary/[0.045]"
                  >
                    <span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
                      <Upload className="size-4" aria-hidden="true" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold">
                        {draft.files.length > 0
                          ? `已选择 ${draft.files.length} 张原图`
                          : '选择这条内容的原图'}
                      </span>
                      <span className="mt-1 block truncate text-xs text-muted-foreground">
                        {draft.files.length > 0
                          ? `${draft.files
                              .slice(0, 3)
                              .map((file) => file.name)
                              .join(
                                '、',
                              )}${draft.files.length > 3 ? '…' : ''} · ${formatBytes(itemBytes)}`
                          : `最多 ${MAX_IMAGE_COUNT} 张，单张不超过 ${formatBytes(MAX_IMAGE_BYTES)}`}
                      </span>
                    </span>
                  </label>
                </div>
              </div>
            </article>
          );
        })}

        <div className="flex flex-col gap-4 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {drafts.length}/{MAX_BATCH_PREVIEW_COUNT} 条 · {totalImageCount}/
            {MAX_BATCH_IMAGE_COUNT} 张 ·{' '}
            {totalBytes === 0 ? '0 KB' : formatBytes(totalBytes)}
          </p>
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-[9px] bg-primary px-5 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          >
            {submitting ? (
              <LoaderCircle
                className="size-4 animate-spin"
                aria-hidden="true"
              />
            ) : (
              <Layers3 className="size-4" aria-hidden="true" />
            )}
            {submitting ? '正在批量保存原图…' : `生成 ${drafts.length} 个链接`}
          </button>
        </div>
      </div>
    </form>
  );
}

const batchInputClassName =
  'h-11 w-full min-w-0 rounded-[10px] border border-input bg-card px-3 py-1 text-base outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 md:text-sm';

function validateDrafts(drafts: BatchPreviewDraft[]) {
  if (drafts.length === 0 || drafts.length > MAX_BATCH_PREVIEW_COUNT) {
    return `每批需要 1–${MAX_BATCH_PREVIEW_COUNT} 条预览。`;
  }

  let imageCount = 0;
  let totalBytes = 0;
  for (const [index, draft] of drafts.entries()) {
    if (!draft.title.trim()) {
      return `请填写第 ${index + 1} 条的标题。`;
    }
    if (draft.title.trim().length > MAX_TITLE_LENGTH) {
      return `第 ${index + 1} 条的标题不能超过 ${MAX_TITLE_LENGTH} 个字符。`;
    }
    if (draft.body.trim().length > MAX_BODY_LENGTH) {
      return `第 ${index + 1} 条的正文不能超过 ${MAX_BODY_LENGTH} 个字符。`;
    }
    if (draft.files.length === 0) {
      return `请为第 ${index + 1} 条选择至少 1 张原图。`;
    }
    if (draft.files.length > MAX_IMAGE_COUNT) {
      return `第 ${index + 1} 条最多上传 ${MAX_IMAGE_COUNT} 张原图。`;
    }
    for (const file of draft.files) {
      if (file.size <= 0) {
        return `第 ${index + 1} 条包含空图片。`;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        return `第 ${index + 1} 条的“${file.name}”超过 ${formatBytes(MAX_IMAGE_BYTES)}。`;
      }
      totalBytes += file.size;
    }
    imageCount += draft.files.length;
  }

  if (imageCount > MAX_BATCH_IMAGE_COUNT) {
    return `每批原图合计不能超过 ${MAX_BATCH_IMAGE_COUNT} 张。`;
  }
  if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
    return `每批原图合计不能超过 ${formatBytes(MAX_TOTAL_IMAGE_BYTES)}。`;
  }
  return '';
}

function isPreviewSummary(
  preview: PreviewSummary | undefined,
): preview is PreviewSummary {
  return Boolean(preview?.id && preview.publicId);
}

async function readApiError(response: Response) {
  try {
    const body = (await response.json()) as ApiErrorBody;
    return body.error?.message || `请求失败（${response.status}）`;
  } catch {
    return `请求失败（${response.status}）`;
  }
}
