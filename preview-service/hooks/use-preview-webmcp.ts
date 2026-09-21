'use client';

import { useEffect, useRef, type RefObject } from 'react';

import {
  MAX_BATCH_PREVIEW_COUNT,
  MAX_BODY_LENGTH,
  MAX_TITLE_LENGTH,
} from '@/lib/preview-contract';
import type { PreviewSummary } from '@/lib/preview-types';

export interface BatchStageFields {
  title: string;
  body: string;
}

interface UsePreviewWebMcpOptions {
  previews: PreviewSummary[];
  formRef: RefObject<HTMLFormElement | null>;
  revoke: (id: string) => Promise<boolean>;
  stageBatch: (items: BatchStageFields[]) => void;
  selectSingle: () => void;
}

export function usePreviewWebMcp({
  previews,
  formRef,
  revoke,
  stageBatch,
  selectSingle,
}: UsePreviewWebMcpOptions) {
  const previewsRef = useRef(previews);
  const revokeRef = useRef(revoke);
  const stageBatchRef = useRef(stageBatch);
  const selectSingleRef = useRef(selectSingle);

  useEffect(() => {
    previewsRef.current = previews;
  }, [previews]);

  useEffect(() => {
    revokeRef.current = revoke;
  }, [revoke]);

  useEffect(() => {
    stageBatchRef.current = stageBatch;
  }, [stageBatch]);

  useEffect(() => {
    selectSingleRef.current = selectSingle;
  }, [selectSingle]);

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) {
      return;
    }

    const lifecycle = new AbortController();
    const register = (tool: Parameters<typeof context.registerTool>[0]) => {
      try {
        void Promise.resolve(
          context.registerTool(tool, { signal: lifecycle.signal }),
        ).catch((error: unknown) => {
          console.warn('webmcp_tool_registration_failed', tool.name, error);
        });
      } catch (error) {
        console.warn('webmcp_tool_registration_failed', tool.name, error);
      }
    };

    register({
      name: 'list_preview_links',
      title: '读取预览记录',
      description: '读取当前独立预览服务中的预览记录及状态，不会修改任何内容。',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute() {
        return {
          previews: previewsRef.current.map((preview) => ({
            id: preview.id,
            publicId: preview.publicId,
            title: preview.title,
            status: preview.status,
            imageCount: preview.imageCount,
            createdAt: preview.createdAt,
          })),
        };
      },
    });

    register({
      name: 'stage_preview_creation',
      title: '填写预览内容',
      description:
        '把标题和正文填入创建表单，并将页面定位到原图选择步骤；此操作不会创建公开链接，仍需用户选择本地原图并提交。',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1, maxLength: MAX_TITLE_LENGTH },
          body: { type: 'string', maxLength: MAX_BODY_LENGTH },
        },
        required: ['title'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute(input) {
        const fields = validateStageInput(input);
        selectSingleRef.current();
        const form = formRef.current;
        if (!form) {
          throw new Error('创建表单当前不可用。');
        }

        setFormValue(form, 'title', fields.title);
        setFormValue(form, 'body', fields.body);
        form.scrollIntoView({ behavior: 'smooth', block: 'start' });
        const imageInput = form.elements.namedItem('images');
        if (imageInput instanceof HTMLInputElement) {
          imageInput.focus({ preventScroll: true });
        }

        return {
          status: 'STAGED',
          nextRequiredAction: 'SELECT_ORIGINAL_IMAGES_AND_SUBMIT',
        };
      },
    });

    register({
      name: 'stage_batch_preview_creation',
      title: '批量填写预览内容',
      description: `把最多 ${MAX_BATCH_PREVIEW_COUNT} 条标题和正文填入批量创建区；此操作不会创建公开链接，仍需用户为每条内容选择本地原图并统一提交。`,
      inputSchema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_BATCH_PREVIEW_COUNT,
            items: {
              type: 'object',
              properties: {
                title: {
                  type: 'string',
                  minLength: 1,
                  maxLength: MAX_TITLE_LENGTH,
                },
                body: { type: 'string', maxLength: MAX_BODY_LENGTH },
              },
              required: ['title'],
              additionalProperties: false,
            },
          },
        },
        required: ['items'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute(input) {
        const items = validateBatchStageInput(input);
        stageBatchRef.current(items);
        return {
          status: 'STAGED',
          itemCount: items.length,
          nextRequiredAction: 'SELECT_ORIGINAL_IMAGES_FOR_EACH_ITEM_AND_SUBMIT',
        };
      },
    });

    register({
      name: 'revoke_preview_link',
      title: '撤销预览链接',
      description:
        '立即撤销指定预览记录的公开访问；原图仍保留，但公开页面和图片读取会停止。',
      inputSchema: {
        type: 'object',
        properties: {
          previewId: {
            type: 'string',
            pattern:
              '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
          },
        },
        required: ['previewId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      async execute(input) {
        const previewId = readPreviewId(input);
        const preview = previewsRef.current.find(
          (item) => item.id === previewId,
        );
        if (!preview) {
          throw new Error('预览记录不存在。');
        }
        if (preview.status !== 'PUBLISHED') {
          return { previewId, status: 'REVOKED', changed: false };
        }

        const changed = await revokeRef.current(previewId);
        if (!changed) {
          throw new Error('撤销失败。');
        }
        return { previewId, status: 'REVOKED', changed: true };
      },
    });

    return () => lifecycle.abort();
  }, [formRef]);
}

function validateBatchStageInput(input: unknown): BatchStageFields[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('输入必须是对象。');
  }
  const items = (input as Record<string, unknown>).items;
  if (
    !Array.isArray(items) ||
    items.length === 0 ||
    items.length > MAX_BATCH_PREVIEW_COUNT
  ) {
    throw new Error(`批量内容必须为 1–${MAX_BATCH_PREVIEW_COUNT} 条。`);
  }
  return items.map((item, index) => {
    try {
      return validateStageInput(item);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : '内容格式不正确。';
      throw new Error(`第 ${index + 1} 条：${message}`);
    }
  });
}

function validateStageInput(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('输入必须是对象。');
  }
  const value = input as Record<string, unknown>;
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  const body = typeof value.body === 'string' ? value.body : '';

  if (!title || title.length > MAX_TITLE_LENGTH) {
    throw new Error(`标题必须为 1–${MAX_TITLE_LENGTH} 个字符。`);
  }
  if (body.length > MAX_BODY_LENGTH) {
    throw new Error(`正文不能超过 ${MAX_BODY_LENGTH} 个字符。`);
  }
  return { title, body };
}

function readPreviewId(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('输入必须是对象。');
  }
  const previewId = (input as Record<string, unknown>).previewId;
  if (
    typeof previewId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      previewId,
    )
  ) {
    throw new Error('previewId 格式不正确。');
  }
  return previewId;
}

function setFormValue(form: HTMLFormElement, name: string, value: string) {
  const control = form.elements.namedItem(name);
  if (
    control instanceof HTMLInputElement ||
    control instanceof HTMLTextAreaElement
  ) {
    control.value = value;
    control.dispatchEvent(new Event('input', { bubbles: true }));
  }
}
