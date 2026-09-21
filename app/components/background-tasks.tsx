'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Bell, LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { apiRequest } from './api-client';
import { notifyWorkspaceUpdated } from './workspace-updates';
import { backgroundTaskGroup, backgroundTaskMessage, backgroundTaskStatus, backgroundTaskTitle, createBackgroundTaskStore, isBackgroundTaskRunning, type BackgroundTask } from './background-task-store';
import styles from './background-tasks.module.css';

type Store = ReturnType<typeof createBackgroundTaskStore>;
type TaskOpener = (task: BackgroundTask) => Promise<boolean>;
const BackgroundTasksContext = createContext<{
  tasks: BackgroundTask[]; store: Store | null; openTask: TaskOpener;
  registerTaskOpener: (opener: TaskOpener) => () => void;
}>({ tasks: [], store: null, openTask: async () => false, registerTaskOpener: () => () => {} });

export function useBackgroundTasks() { return useContext(BackgroundTasksContext); }

export function BackgroundTasksProvider({ accountKey, children }: { accountKey: string; children: ReactNode }) {
  const [store, setStore] = useState<Store | null>(null);
  const [tasks, setTasks] = useState<BackgroundTask[]>([]);
  const storeRef = useRef<Store | null>(null);
  const openerRef = useRef<TaskOpener | null>(null);
  const registerTaskOpener = useCallback((opener: TaskOpener) => {
    openerRef.current = opener;
    return () => { if (openerRef.current === opener) openerRef.current = null; };
  }, []);
  const openTask = useCallback(async (task: BackgroundTask) => {
    const activeStore = storeRef.current;
    try {
      if (openerRef.current) {
        if (!await openerRef.current(task)) return false;
      } else {
        window.location.assign(`/workbench/personal?taskId=${task.taskId}`);
      }
      if (activeStore === storeRef.current) activeStore?.markRead(task.id);
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '打开任务失败，请重试');
      return false;
    }
  }, []);
  useEffect(() => {
    let storage: Storage | undefined;
    try { storage = window.localStorage; } catch {}
    const storageKey = `xhs:background-tasks:v1:${accountKey}`;
    const next = createBackgroundTaskStore({
      storage, storageKey,
      request: path => apiRequest(`/api/control-plane${path}`, { signal: AbortSignal.timeout(15_000), cache: 'no-store' }),
      onComplete: task => {
        notifyWorkspaceUpdated();
        const notify = ['SUCCEEDED', 'PREVIEW_READY', 'ACCEPTED'].includes(task.status) ? toast.success : toast.warning;
        notify(backgroundTaskTitle(task), { id: `background:${task.id}`, description: backgroundTaskMessage(task), duration: 12_000,
          action: { label: '查看任务', onClick: () => { void openTask(task); } } });
      },
    });
    setStore(next);
    storeRef.current = next;
    setTasks(next.getSnapshot());
    const unsubscribe = next.subscribe(() => {
      setTasks(next.getSnapshot());
      next.getSnapshot().filter(task => task.read || task.consumed).forEach(task => toast.dismiss(`background:${task.id}`));
    });
    // Only one tab polls at a time, so a completion produces one toast.
    const poll = () => {
      next.sync();
      if (navigator.locks) void navigator.locks.request(storageKey, { ifAvailable: true }, async lock => {
        if (lock) await next.poll();
      }).catch(() => { void next.poll(); });
      else void next.poll();
    };
    const sync = (event: StorageEvent) => { if (event.key === storageKey) next.sync(event.newValue ?? '[]'); };
    poll();
    const timer = window.setInterval(poll, 4_000);
    window.addEventListener('focus', poll);
    window.addEventListener('storage', sync);
    return () => {
      next.stop(); unsubscribe(); storeRef.current = null;
      next.getSnapshot().forEach(task => toast.dismiss(`background:${task.id}`));
      window.clearInterval(timer); window.removeEventListener('focus', poll); window.removeEventListener('storage', sync);
    };
  }, [accountKey, openTask]);
  return <BackgroundTasksContext.Provider value={{ tasks, store, openTask, registerTaskOpener }}>{children}</BackgroundTasksContext.Provider>;
}

export function BackgroundTaskNotifications() {
  const { tasks, store, openTask } = useBackgroundTasks();
  const [open, setOpen] = useState(false);
  const running = tasks.filter(isBackgroundTaskRunning).length;
  const unread = tasks.filter(task => !task.read && !isBackgroundTaskRunning(task)).length;
  const groups = [
    { id: 'running', title: '处理中' }, { id: 'ready', title: '待确认' },
    { id: 'failed', title: '需要处理' }, { id: 'history', title: '已处理记录' },
  ];
  function taskItem(task: BackgroundTask) {
    return <article key={task.id} className={styles.item} data-unread={!task.read && !isBackgroundTaskRunning(task)}>
      <div className={styles.itemHeading}><strong>{backgroundTaskTitle(task)}</strong><span className={styles.badge} data-state={backgroundTaskGroup(task)}>{backgroundTaskStatus(task)}</span></div>
      <p>{backgroundTaskMessage(task)}</p>
      <div className={styles.actions}>
        <Button unstyled className="button small" type="button" onClick={() => { setOpen(false); void openTask(task); }}>查看任务</Button>
        {!task.read && !isBackgroundTaskRunning(task) && <Button unstyled className="button small" type="button" onClick={() => store?.markRead(task.id)}>标为已读</Button>}
      </div>
    </article>;
  }
  return <>
    <Button unstyled type="button" className={`button small ${styles.trigger}`} onClick={() => setOpen(true)} aria-label={`后台任务，${running} 项处理中，${unread} 条未读提醒`}>
      {running ? <LoaderCircle size={16} className="animate-spin" /> : <Bell size={16} />}
      <span>后台任务</span>
      {running > 0 && <span>{running} 项处理中</span>}
      {unread > 0 && <span className={styles.unread}>{unread} 条新提醒</span>}
    </Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className={styles.dialog}>
      <DialogTitle>后台任务与提醒</DialogTitle>
      <DialogDescription>文案规划和图片修复可在关闭操作窗口后继续。处理完成或失败后会在这里保留提醒；重新打开网页也会继续查询进度。</DialogDescription>
      {!!unread && <div className={styles.toolbar}><Button unstyled className="button small" type="button" onClick={() => store?.markAllRead()}>全部标为已读</Button></div>}
      <div className={styles.list} aria-live="polite">
        {!tasks.length && <p className={styles.empty}>暂无后台任务。</p>}
        {groups.map(group => {
          const rows = tasks.filter(task => backgroundTaskGroup(task) === group.id).sort((a, b) => Number(a.read) - Number(b.read) || b.createdAt - a.createdAt);
          if (!rows.length) return null;
          if (group.id === 'history') return <details className={styles.group} key={group.id}><summary>{group.title} · {rows.length}</summary>{rows.map(taskItem)}</details>;
          return <section className={styles.group} key={group.id} aria-label={group.title}><h3>{group.title} · {rows.length}</h3>{rows.map(taskItem)}</section>;
        })}
      </div>
    </DialogContent></Dialog>
  </>;
}
