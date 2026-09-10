'use client';

import {
  ArrowUpRight,
  Ban,
  Check,
  Copy,
  FileImage,
  Images,
  Link2,
  LoaderCircle,
  LogOut,
  RefreshCw,
  Upload,
} from 'lucide-react';
import Image from 'next/image';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  BatchPreviewCreator,
  type BatchPreviewDraft,
} from '@/components/batch-preview-creator';
import { ApiKeyManagerDialog } from '@/components/api-key-manager-dialog';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  usePreviewWebMcp,
  type BatchStageFields,
} from '@/hooks/use-preview-webmcp';
import {
  formatBytes,
  MAX_BODY_LENGTH,
  MAX_IMAGE_COUNT,
  MAX_TITLE_LENGTH,
} from '@/lib/preview-contract';
import { adminFetch } from '@/lib/admin-fetch';
import type { PreviewSummary } from '@/lib/preview-types';
import { getPublicPreviewPath } from '@/lib/preview-url';
import { cn } from '@/lib/utils';

interface ApiErrorBody {
  error?: { message?: string };
}

type CreationMode = 'single' | 'batch';

export function PreviewManager({ username }: { username: string }) {
  const [previews, setPreviews] = useState<PreviewSummary[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [creationMode, setCreationMode] = useState<CreationMode>('single');
  const [batchDrafts, setBatchDrafts] = useState<BatchPreviewDraft[]>([
    createEmptyBatchDraft('batch-1'),
  ]);
  const [createdPublicIds, setCreatedPublicIds] = useState<string[]>([]);
  const [createdLinksCopied, setCreatedLinksCopied] = useState(false);
  const [copiedPublicId, setCopiedPublicId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const stageBatch = useCallback((items: BatchStageFields[]) => {
    setCreationMode('batch');
    setError('');
    setBatchDrafts(
      items.map((item, index) => ({
        id: `staged-${index + 1}`,
        title: item.title,
        body: item.body,
        files: [],
      })),
    );
  }, []);

  const selectSingle = useCallback(() => {
    setCreationMode('single');
  }, []);

  usePreviewWebMcp({ previews, formRef, revoke, stageBatch, selectSingle });

  const loadPreviews = useCallback(async () => {
    try {
      const response = await adminFetch('/api/admin/previews', {
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new Error(await readApiError(response));
      }
      const data = (await response.json()) as { previews: PreviewSummary[] };
      setPreviews(data.previews);
    } catch (loadError) {
      setError(messageFrom(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadPreviews(), 0);
    return () => window.clearTimeout(timer);
  }, [loadPreviews]);

  async function createPreview(
    event: React.SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ) {
    event.preventDefault();
    const form = event.currentTarget;
    if (selectedFiles.length === 0) {
      setError('请先选择至少 1 张原图。');
      fileInputRef.current?.focus();
      return;
    }

    setSubmitting(true);
    setError('');
    setCreatedPublicIds([]);
    setCreatedLinksCopied(false);
    try {
      const response = await adminFetch('/api/admin/previews', {
        method: 'POST',
        body: new FormData(form),
      });
      if (!response.ok) {
        throw new Error(await readApiError(response));
      }
      const data = (await response.json()) as { preview: PreviewSummary };
      setPreviews((current) => [
        data.preview,
        ...current.filter((item) => item.id !== data.preview.id),
      ]);
      setCreatedPublicIds([data.preview.publicId]);
      setSelectedFiles([]);
      form.reset();
    } catch (submitError) {
      setError(messageFrom(submitError));
    } finally {
      setSubmitting(false);
    }
  }

  async function revoke(id: string) {
    setRevokingId(id);
    setError('');
    try {
      const response = await adminFetch(`/api/admin/previews/${id}/revoke`, {
        method: 'POST',
      });
      if (!response.ok) {
        throw new Error(await readApiError(response));
      }
      const data = (await response.json()) as { revokedAt: number };
      setPreviews((current) =>
        current.map((preview) =>
          preview.id === id
            ? { ...preview, status: 'REVOKED', revokedAt: data.revokedAt }
            : preview,
        ),
      );
      return true;
    } catch (revokeError) {
      setError(messageFrom(revokeError));
      return false;
    } finally {
      setRevokingId(null);
    }
  }

  async function copyLink(publicId: string) {
    const url = `${window.location.origin}${getPublicPreviewPath(publicId)}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedPublicId(publicId);
      window.setTimeout(() => setCopiedPublicId(null), 1600);
    } catch {
      setError('复制失败，请打开预览后从地址栏复制链接。');
    }
  }

  async function copyCreatedLinks() {
    const urls = createdPublicIds.map(
      (publicId) =>
        `${window.location.origin}${getPublicPreviewPath(publicId)}`,
    );
    try {
      await navigator.clipboard.writeText(urls.join('\n'));
      setCreatedLinksCopied(true);
      window.setTimeout(() => setCreatedLinksCopied(false), 1600);
    } catch {
      setError('复制失败，请从下方预览记录逐条打开或复制。');
    }
  }

  function acceptBatch(previews: PreviewSummary[]) {
    const createdIds = new Set(previews.map((preview) => preview.id));
    setPreviews((current) => [
      ...previews,
      ...current.filter((preview) => !createdIds.has(preview.id)),
    ]);
    setCreatedPublicIds(previews.map((preview) => preview.publicId));
    setCreatedLinksCopied(false);
    setBatchDrafts([createEmptyBatchDraft(crypto.randomUUID())]);
  }

  function beginBatchCreation() {
    setCreatedPublicIds([]);
    setCreatedLinksCopied(false);
  }

  async function logout() {
    setLoggingOut(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      window.location.assign('/login');
    }
  }

  const totalSelectedBytes = selectedFiles.reduce(
    (total, file) => total + file.size,
    0,
  );

  return (
    <main className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex min-h-[74px] max-w-[1100px] flex-wrap items-center justify-between gap-3 px-3.5 py-3.5 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <Image
              src="/favicon.png"
              alt=""
              width={44}
              height={44}
              unoptimized
              className="size-11 shrink-0 rounded-xl"
            />
            <h1 className="truncate text-xl font-medium tracking-tight text-foreground sm:text-2xl">
              海默信息小红书编辑器
            </h1>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <span className="hidden max-w-32 truncate text-sm text-muted-foreground lg:block">
              {username}
            </span>
            <ApiKeyManagerDialog />
            <Button
              type="button"
              variant="ghost"
              disabled={loggingOut}
              onClick={() => void logout()}
            >
              {loggingOut ? (
                <LoaderCircle
                  className="animate-spin"
                  data-icon="inline-start"
                />
              ) : (
                <LogOut data-icon="inline-start" />
              )}
              退出
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1100px] px-3.5 pb-[30px] pt-[26px] sm:px-6">
        {error ? (
          <div
            role="alert"
            className="mb-[18px] flex items-start justify-between gap-4 rounded-[13px] border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          >
            <span>{error}</span>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => setError('')}
            >
              知道了
            </Button>
          </div>
        ) : null}

        {createdPublicIds.length > 0 ? (
          <section className="mb-[18px] grid gap-4 rounded-[13px] border border-emerald-700/20 bg-emerald-50/80 p-4 sm:grid-cols-[1fr_auto] sm:items-center">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-emerald-700 text-white">
                <Check className="size-4" aria-hidden="true" />
              </span>
              <div>
                <p className="text-sm font-semibold text-emerald-950">
                  {createdPublicIds.length} 个预览链接已生成
                </p>
                <div className="mt-1 grid max-h-20 gap-0.5 overflow-y-auto font-mono text-xs text-emerald-800">
                  {createdPublicIds.map((publicId) => (
                    <span key={publicId} className="break-all">
                      {getPublicPreviewPath(publicId)}
                    </span>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => void copyCreatedLinks()}
              >
                {createdLinksCopied ? (
                  <Check data-icon="inline-start" />
                ) : (
                  <Copy data-icon="inline-start" />
                )}
                {createdLinksCopied
                  ? '已复制'
                  : createdPublicIds.length > 1
                    ? '复制全部链接'
                    : '复制链接'}
              </Button>
              <a
                href={getPublicPreviewPath(createdPublicIds[0])}
                target="_blank"
                rel="noreferrer"
                className={buttonVariants()}
              >
                {createdPublicIds.length > 1 ? '打开第一个' : '打开预览'}
                <ArrowUpRight data-icon="inline-end" />
              </a>
            </div>
          </section>
        ) : null}

        <div className="grid gap-[22px] min-[761px]:grid-cols-[minmax(0,1.15fr)_minmax(330px,0.85fr)] min-[761px]:items-start">
          <section className="min-w-0">
            <div
              role="tablist"
              aria-label="创建方式"
              className="mb-3.5 grid min-h-[46px] w-full grid-cols-2 rounded-[13px] bg-muted p-1 sm:w-[304px]"
            >
              <button
                id="single-create-tab"
                type="button"
                role="tab"
                aria-selected={creationMode === 'single'}
                aria-controls="single-create-panel"
                onClick={() => setCreationMode('single')}
                className={cn(
                  'inline-flex min-h-[38px] items-center justify-center gap-1.5 rounded-[9px] px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  creationMode === 'single'
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Link2 className="size-4" aria-hidden="true" />
                单条创建
              </button>
              <button
                id="batch-create-tab"
                type="button"
                role="tab"
                aria-selected={creationMode === 'batch'}
                aria-controls="batch-create-panel"
                onClick={() => setCreationMode('batch')}
                className={cn(
                  'inline-flex min-h-[38px] items-center justify-center gap-1.5 rounded-[9px] px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  creationMode === 'batch'
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Images className="size-4" aria-hidden="true" />
                批量创建
              </button>
            </div>

            <div
              id="single-create-panel"
              role="tabpanel"
              aria-labelledby="single-create-tab"
              hidden={creationMode !== 'single'}
            >
              <form
                ref={formRef}
                onSubmit={createPreview}
                className="overflow-hidden rounded-[18px] border border-border bg-card shadow-[0_12px_34px_rgb(24_25_34/6%)]"
              >
                <div className="flex min-h-[62px] items-center border-b border-border px-5 py-3.5">
                  <h2 className="text-lg font-medium">创建预览</h2>
                </div>

                <div className="grid gap-[22px] p-5">
                  <div className="grid gap-2">
                    <label htmlFor="title" className="text-sm font-medium">
                      标题 <span className="text-primary">*</span>
                    </label>
                    <Input
                      id="title"
                      name="title"
                      required
                      maxLength={MAX_TITLE_LENGTH}
                      placeholder="输入预览标题"
                      className="h-11 bg-background px-3"
                    />
                  </div>

                  <div className="grid gap-2">
                    <label htmlFor="body" className="text-sm font-medium">
                      正文
                    </label>
                    <Textarea
                      id="body"
                      name="body"
                      maxLength={MAX_BODY_LENGTH}
                      placeholder="输入需要展示的文案……"
                      className="min-h-32 resize-y bg-background px-3 py-3 leading-7"
                    />
                  </div>

                  <div className="grid gap-2">
                    <span className="text-sm font-medium">
                      原图 <span className="text-primary">*</span>
                    </span>
                    <Input
                      ref={fileInputRef}
                      id="images"
                      name="images"
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
                      multiple
                      className="sr-only"
                      onChange={(event) =>
                        setSelectedFiles(Array.from(event.target.files ?? []))
                      }
                    />
                    <label
                      htmlFor="images"
                      aria-label="选择原始图片"
                      className="group grid min-h-[126px] cursor-pointer place-items-center rounded-[13px] border border-dashed border-primary/35 bg-primary/[0.025] p-5 text-center transition-colors hover:border-primary/60 hover:bg-primary/[0.045] focus-within:ring-2 focus-within:ring-ring"
                    >
                      <span>
                        <span className="mx-auto mb-3 grid size-10 place-items-center rounded-full bg-primary/10 text-primary transition-transform group-hover:-translate-y-0.5">
                          <Upload className="size-5" aria-hidden="true" />
                        </span>
                        <span className="block text-sm font-semibold">
                          点击选择原始图片
                        </span>
                        <span className="mt-1.5 block text-xs leading-5 text-muted-foreground">
                          PNG / JPG / WebP / GIF / AVIF，最多 {MAX_IMAGE_COUNT}{' '}
                          张
                        </span>
                      </span>
                    </label>

                    {selectedFiles.length > 0 ? (
                      <div className="overflow-hidden rounded-xl border border-border/80 bg-muted/35">
                        <div className="flex items-center justify-between border-b border-border/70 px-3 py-2 text-xs">
                          <span className="font-medium">
                            已选择 {selectedFiles.length} 张
                          </span>
                          <span className="font-mono text-muted-foreground">
                            {formatBytes(totalSelectedBytes)}
                          </span>
                        </div>
                        <ul className="divide-y divide-border/60">
                          {selectedFiles.slice(0, 6).map((file, index) => (
                            <li
                              key={`${file.name}-${file.size}-${index}`}
                              className="flex items-center gap-3 px-3 py-2 text-xs"
                            >
                              <FileImage
                                className="size-4 shrink-0 text-primary"
                                aria-hidden="true"
                              />
                              <span className="min-w-0 flex-1 truncate">
                                {file.name}
                              </span>
                              <span className="font-mono text-muted-foreground">
                                {formatBytes(file.size)}
                              </span>
                            </li>
                          ))}
                        </ul>
                        {selectedFiles.length > 6 ? (
                          <p className="border-t border-border/60 px-3 py-2 text-xs text-muted-foreground">
                            另有 {selectedFiles.length - 6} 张图片
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </div>

                  <div className="flex justify-end border-t border-border pt-4">
                    <Button
                      type="submit"
                      size="lg"
                      disabled={submitting}
                      className="h-11 w-full px-5 shadow-sm sm:w-auto"
                    >
                      {submitting ? (
                        <LoaderCircle
                          className="animate-spin"
                          data-icon="inline-start"
                        />
                      ) : (
                        <Link2 data-icon="inline-start" />
                      )}
                      {submitting ? '正在保存原图…' : '生成预览链接'}
                    </Button>
                  </div>
                </div>
              </form>
            </div>

            <div
              id="batch-create-panel"
              role="tabpanel"
              aria-labelledby="batch-create-tab"
              hidden={creationMode !== 'batch'}
            >
              <BatchPreviewCreator
                drafts={batchDrafts}
                onDraftsChange={setBatchDrafts}
                onStart={beginBatchCreation}
                onCreated={acceptBatch}
                onError={setError}
              />
            </div>
          </section>

          <section className="min-w-0 overflow-hidden rounded-[18px] border border-border bg-card shadow-[0_12px_34px_rgb(24_25_34/6%)] min-[761px]:sticky min-[761px]:top-[26px]">
            <div className="flex min-h-[62px] items-center justify-between gap-4 border-b border-border px-5 py-3.5">
              <div className="min-w-0">
                <h2 className="text-lg font-medium">预览记录</h2>
                {!loading ? (
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {previews.length} 条
                  </span>
                ) : null}
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setLoading(true);
                  setError('');
                  void loadPreviews();
                }}
                disabled={loading}
                className="h-9 px-3"
              >
                <RefreshCw
                  className={loading ? 'animate-spin' : ''}
                  data-icon="inline-start"
                />
                刷新
              </Button>
            </div>

            {loading ? (
              <div className="grid min-h-48 place-items-center px-6 text-sm text-muted-foreground">
                <div className="text-center">
                  <LoaderCircle className="mx-auto mb-3 size-5 animate-spin" />
                  正在读取记录…
                </div>
              </div>
            ) : previews.length === 0 ? (
              <div className="grid min-h-48 place-items-center px-6 text-center">
                <div>
                  <Images className="mx-auto mb-3 size-6 text-muted-foreground" />
                  <p className="text-sm font-medium">还没有预览记录</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    创建后，链接会显示在这里。
                  </p>
                </div>
              </div>
            ) : (
              <div className="preview-copy-scrollbar grid divide-y divide-border min-[761px]:max-h-[calc(100dvh-116px)] min-[761px]:overflow-y-auto">
                {previews.map((preview) => (
                  <PreviewRow
                    key={preview.id}
                    preview={preview}
                    copied={copiedPublicId === preview.publicId}
                    revoking={revokingId === preview.id}
                    onCopy={() => void copyLink(preview.publicId)}
                    onRevoke={() => revoke(preview.id)}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

function PreviewRow({
  preview,
  copied,
  revoking,
  onCopy,
  onRevoke,
}: {
  preview: PreviewSummary;
  copied: boolean;
  revoking: boolean;
  onCopy: () => void;
  onRevoke: () => Promise<boolean>;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const published = preview.status === 'PUBLISHED';

  async function confirmRevoke() {
    const succeeded = await onRevoke();
    if (succeeded) {
      setDialogOpen(false);
    }
  }

  return (
    <article
      className={cn(
        'grid grid-cols-[64px_minmax(0,1fr)] gap-[13px] p-4',
        !published && 'bg-muted/40',
      )}
    >
      <div className="relative size-16 overflow-hidden rounded-[10px] bg-muted">
        {published ? (
          <Image
            src={`/api/public/previews/${preview.publicId}/images/1`}
            alt=""
            fill
            unoptimized
            sizes="64px"
            className="object-cover"
          />
        ) : (
          <div className="grid size-full place-items-center text-muted-foreground">
            <Ban className="size-5" aria-hidden="true" />
          </div>
        )}
        <span className="absolute bottom-1 right-1 rounded bg-foreground/85 px-1.5 py-0.5 text-xs leading-none text-background">
          {preview.imageCount}P
        </span>
      </div>

      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 font-medium',
              published
                ? 'text-emerald-700 dark:text-emerald-300'
                : 'text-muted-foreground',
            )}
          >
            <span className="size-1.5 rounded-full bg-current" />
            {published ? '可访问' : '已撤销'}
          </span>
          <span className="text-xs text-muted-foreground">
            {formatDate(preview.createdAt)}
          </span>
        </div>
        <h3 className="mt-2 truncate text-sm font-medium">{preview.title}</h3>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {getPublicPreviewPath(preview.publicId)}
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          {published ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onCopy}
              >
                {copied ? (
                  <Check data-icon="inline-start" />
                ) : (
                  <Copy data-icon="inline-start" />
                )}
                {copied ? '已复制' : '复制'}
              </Button>
              <a
                href={getPublicPreviewPath(preview.publicId)}
                target="_blank"
                rel="noreferrer"
                className={cn(
                  buttonVariants({ variant: 'outline', size: 'sm' }),
                )}
              >
                打开
                <ArrowUpRight data-icon="inline-end" />
              </a>
              <AlertDialog open={dialogOpen} onOpenChange={setDialogOpen}>
                <AlertDialogTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    />
                  }
                >
                  <Ban data-icon="inline-start" />
                  撤销
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>撤销这个公开链接？</AlertDialogTitle>
                    <AlertDialogDescription>
                      访客将无法继续查看页面和原图。原图母版仍会保留在存储中，便于后续审计或恢复能力扩展。
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={revoking}>
                      取消
                    </AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      disabled={revoking}
                      onClick={() => void confirmRevoke()}
                    >
                      {revoking ? (
                        <LoaderCircle className="animate-spin" />
                      ) : null}
                      确认撤销
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          ) : (
            <span className="text-xs text-muted-foreground">
              公开读取已停止
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

async function readApiError(response: Response) {
  try {
    const body = (await response.json()) as ApiErrorBody;
    return body.error?.message || `请求失败（${response.status}）`;
  } catch {
    return `请求失败（${response.status}）`;
  }
}

function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : '操作失败，请重试。';
}

function createEmptyBatchDraft(id: string): BatchPreviewDraft {
  return { id, title: '', body: '', files: [] };
}

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
}
