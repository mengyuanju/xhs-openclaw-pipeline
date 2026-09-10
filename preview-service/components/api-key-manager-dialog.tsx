'use client';

import {
  Ban,
  Check,
  Copy,
  KeyRound,
  LoaderCircle,
  Plus,
  ShieldCheck,
} from 'lucide-react';
import { useState, type SyntheticEvent } from 'react';

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
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  API_KEY_SCOPE_OPTIONS,
  type ApiKeyScope,
  type ApiKeySummary,
} from '@/lib/auth-contract';
import { adminFetch } from '@/lib/admin-fetch';
import { cn } from '@/lib/utils';

interface ApiErrorBody {
  error?: { message?: string };
}

export function ApiKeyManagerDialog() {
  const [open, setOpen] = useState(false);
  const [keys, setKeys] = useState<ApiKeySummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [name, setName] = useState('主系统上传');
  const [scopes, setScopes] = useState<ApiKeyScope[]>(['preview:create']);
  const [createdKey, setCreatedKey] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  function changeOpen(nextOpen: boolean) {
    setOpen(nextOpen);
    if (nextOpen) {
      setLoading(true);
      setError('');
      void loadKeys();
    } else {
      setCreatedKey('');
      setCopied(false);
      setError('');
    }
  }

  async function loadKeys() {
    try {
      const response = await adminFetch('/api/admin/api-keys', {
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new Error(await readApiError(response));
      }
      const data = (await response.json()) as { keys: ApiKeySummary[] };
      setKeys(data.keys);
    } catch (loadError) {
      setError(messageFrom(loadError));
    } finally {
      setLoading(false);
    }
  }

  async function createKey(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    setCreatedKey('');
    setCopied(false);
    try {
      const response = await adminFetch('/api/admin/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, scopes }),
      });
      if (!response.ok) {
        throw new Error(await readApiError(response));
      }
      const data = (await response.json()) as {
        apiKey: string;
        key: ApiKeySummary;
      };
      setCreatedKey(data.apiKey);
      setKeys((current) => [
        data.key,
        ...current.filter((key) => key.id !== data.key.id),
      ]);
    } catch (createError) {
      setError(messageFrom(createError));
    } finally {
      setSubmitting(false);
    }
  }

  async function revokeKey(id: string) {
    setRevokingId(id);
    setError('');
    try {
      const response = await adminFetch(`/api/admin/api-keys/${id}/revoke`, {
        method: 'POST',
      });
      if (!response.ok) {
        throw new Error(await readApiError(response));
      }
      const data = (await response.json()) as { revokedAt: number };
      setKeys((current) =>
        current.map((key) =>
          key.id === id ? { ...key, revokedAt: data.revokedAt } : key,
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

  async function copyCreatedKey() {
    try {
      await navigator.clipboard.writeText(createdKey);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setError('复制失败，请手动选择密钥文本。');
    }
  }

  function toggleScope(scope: ApiKeyScope, checked: boolean) {
    setScopes((current) =>
      checked
        ? [...new Set([...current, scope])]
        : current.filter((item) => item !== scope),
    );
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger render={<Button type="button" variant="outline" />}>
        <KeyRound data-icon="inline-start" />
        接口密钥
      </DialogTrigger>
      <DialogContent className="preview-copy-scrollbar max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-[18px] p-5 sm:max-w-[620px]">
        <DialogHeader>
          <DialogTitle className="text-lg">接口密钥</DialogTitle>
          <DialogDescription>
            为主系统创建独立凭证。密钥只在创建后显示一次，可随时撤销和轮换。
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p
            role="alert"
            className="rounded-[10px] border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}

        {createdKey ? (
          <section className="rounded-[13px] border border-emerald-700/20 bg-emerald-50/80 p-4 text-emerald-950">
            <div className="flex items-start gap-3">
              <ShieldCheck className="mt-0.5 size-5 shrink-0 text-emerald-700" />
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-medium">新密钥已生成</h3>
                <p className="mt-1 text-xs leading-5 text-emerald-800">
                  关闭窗口后将无法再次查看，请现在复制到主系统的服务器配置中。
                </p>
                <code className="mt-3 block break-all rounded-[9px] bg-white/75 px-3 py-2.5 text-xs leading-5 text-emerald-950 ring-1 ring-emerald-900/10 select-all">
                  {createdKey}
                </code>
                <Button
                  type="button"
                  variant="outline"
                  className="mt-3 border-emerald-700/20 bg-white/70 hover:bg-white"
                  onClick={() => void copyCreatedKey()}
                >
                  {copied ? (
                    <Check data-icon="inline-start" />
                  ) : (
                    <Copy data-icon="inline-start" />
                  )}
                  {copied ? '已复制' : '复制密钥'}
                </Button>
              </div>
            </div>
          </section>
        ) : null}

        <form
          onSubmit={createKey}
          className="grid gap-4 rounded-[13px] bg-muted/65 p-4"
        >
          <div className="grid gap-2">
            <label htmlFor="api-key-name" className="text-sm font-medium">
              密钥名称
            </label>
            <Input
              id="api-key-name"
              value={name}
              required
              maxLength={60}
              onChange={(event) => setName(event.target.value)}
              className="h-10 bg-card"
            />
          </div>

          <fieldset className="grid gap-2.5">
            <legend className="mb-2 text-sm font-medium">权限</legend>
            {API_KEY_SCOPE_OPTIONS.map((option) => (
              <label
                key={option.value}
                htmlFor={`api-key-scope-${option.value.replace(':', '-')}`}
                className="flex cursor-pointer items-start gap-3 rounded-[10px] bg-card px-3 py-2.5 ring-1 ring-border"
              >
                <Checkbox
                  id={`api-key-scope-${option.value.replace(':', '-')}`}
                  checked={scopes.includes(option.value)}
                  onCheckedChange={(checked) =>
                    toggleScope(option.value, checked)
                  }
                  aria-label={option.label}
                  className="mt-0.5"
                />
                <span>
                  <span className="block text-sm font-medium">
                    {option.label}
                  </span>
                  <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                    {option.description}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>

          <div className="flex justify-end">
            <Button
              type="submit"
              disabled={submitting || scopes.length === 0}
              className="h-10 px-4"
            >
              {submitting ? (
                <LoaderCircle
                  className="animate-spin"
                  data-icon="inline-start"
                />
              ) : (
                <Plus data-icon="inline-start" />
              )}
              {submitting ? '正在生成…' : '生成新密钥'}
            </Button>
          </div>
        </form>

        <section>
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium">已有密钥</h3>
            {!loading ? (
              <span className="text-xs text-muted-foreground">
                {keys.filter((key) => !key.revokedAt).length} 个有效
              </span>
            ) : null}
          </div>

          {loading ? (
            <div className="grid min-h-24 place-items-center text-sm text-muted-foreground">
              <LoaderCircle className="size-5 animate-spin" />
            </div>
          ) : keys.length === 0 ? (
            <div className="rounded-[12px] border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
              暂无接口密钥
            </div>
          ) : (
            <div className="overflow-hidden rounded-[12px] border border-border">
              {keys.map((key, index) => (
                <ApiKeyRow
                  key={key.id}
                  apiKey={key}
                  revoking={revokingId === key.id}
                  onRevoke={() => revokeKey(key.id)}
                  className={index > 0 ? 'border-t border-border' : undefined}
                />
              ))}
            </div>
          )}
        </section>
      </DialogContent>
    </Dialog>
  );
}

function ApiKeyRow({
  apiKey,
  revoking,
  onRevoke,
  className,
}: {
  apiKey: ApiKeySummary;
  revoking: boolean;
  onRevoke: () => Promise<boolean>;
  className?: string;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const active = !apiKey.revokedAt;

  async function confirmRevoke() {
    if (await onRevoke()) {
      setConfirmOpen(false);
    }
  }

  return (
    <article
      className={cn('grid gap-2.5 p-3.5', !active && 'bg-muted/45', className)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="truncate text-sm font-medium">{apiKey.name}</h4>
            <span
              className={cn(
                'inline-flex items-center gap-1.5 text-xs',
                active ? 'text-emerald-700' : 'text-muted-foreground',
              )}
            >
              <span className="size-1.5 rounded-full bg-current" />
              {active ? '有效' : '已撤销'}
            </span>
          </div>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {apiKey.keyPrefix}.••••••••
          </p>
        </div>

        {active ? (
          <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
            <AlertDialogTrigger
              render={<Button type="button" variant="ghost" size="sm" />}
            >
              <Ban data-icon="inline-start" />
              撤销
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>撤销“{apiKey.name}”？</AlertDialogTitle>
                <AlertDialogDescription>
                  使用此密钥的系统会立即无法调用接口，已生成的公开预览不受影响。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={revoking}>取消</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  disabled={revoking}
                  onClick={() => void confirmRevoke()}
                >
                  {revoking ? <LoaderCircle className="animate-spin" /> : null}
                  确认撤销
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </div>

      <p className="text-xs leading-5 text-muted-foreground">
        {apiKey.scopes.map(scopeLabel).join('、')} · 创建于{' '}
        {formatDate(apiKey.createdAt)}
        {apiKey.lastUsedAt
          ? ` · 最近使用 ${formatDate(apiKey.lastUsedAt)}`
          : ''}
      </p>
    </article>
  );
}

function scopeLabel(scope: ApiKeyScope) {
  return (
    API_KEY_SCOPE_OPTIONS.find((option) => option.value === scope)?.label ??
    scope
  );
}

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(timestamp);
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
