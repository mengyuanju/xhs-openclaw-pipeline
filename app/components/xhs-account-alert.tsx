'use client';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';

import { ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { apiRequest } from './api-client';
import {
  type XhsSearchNodeStatus,
  xhsAuthStatusLabel,
  xhsHostKindLabel,
  xhsSearchNeedsAttention,
} from './xhs-search-status';

const STATUS_POLL_MS = 15_000;

export function XhsAccountAlert({ enabled }: { enabled: boolean }) {
  const [nodes, setNodes] = useState<XhsSearchNodeStatus[]>([]);
  const [open, setOpen] = useState(false);
  const [dismissedSignature, setDismissedSignature] = useState('');

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      setNodes(await apiRequest<XhsSearchNodeStatus[]>('/api/control-plane/v1/xhs-search-statuses'));
    } catch {
      // A background status reminder must not replace the current page with a
      // transient connectivity error. The dedicated executor page still
      // exposes manual refresh errors.
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return undefined;
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, STATUS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, refresh]);

  const attention = useMemo(
    () => nodes.filter(xhsSearchNeedsAttention),
    [nodes],
  );
  const signature = useMemo(() => attention
    .map((node) => `${node.id}:${node.authStatus}:${node.authStatusChangedAt}`)
    .sort()
    .join('|'), [attention]);

  useEffect(() => {
    if (!signature) {
      setOpen(false);
      setDismissedSignature('');
    } else if (signature !== dismissedSignature) {
      setOpen(true);
    }
  }, [dismissedSignature, signature]);

  if (!enabled) return null;

  return <Dialog open={open} onOpenChange={(nextOpen) => {
    setOpen(nextOpen);
    if (!nextOpen) setDismissedSignature(signature);
  }}>
    <DialogContent className="xhs-account-alert-dialog">
      <div className="xhs-account-alert-heading">
        <span aria-hidden="true"><ShieldAlert size={22} /></span>
        <div>
          <DialogTitle>小红书账号需要人工处理</DialogTitle>
          <DialogDescription>
            搜索队列已暂停领取后续 Query。请到对应主机完成登录或安全验证，再恢复搜索进程。
          </DialogDescription>
        </div>
      </div>
      <div className="xhs-account-alert-list">
        {attention.map((node) => <article key={node.id}>
          <div><strong>{node.accountLabel || '未设置账号标识'}</strong><span>{xhsAuthStatusLabel(node)}</span></div>
          <p>{xhsHostKindLabel(node)} · {node.name}</p>
          <small>{node.online ? '搜索进程当前在线' : '搜索进程当前离线，请先在该主机启动'}</small>
        </article>)}
      </div>
      <div className="xhs-account-alert-actions">
        <DialogClose asChild><Button unstyled className="button" type="button">稍后处理</Button></DialogClose>
        <DialogClose asChild><Button unstyled asChild className="button primary"><Link href="/executors">查看搜索节点</Link></Button></DialogClose>
      </div>
    </DialogContent>
  </Dialog>;
}
