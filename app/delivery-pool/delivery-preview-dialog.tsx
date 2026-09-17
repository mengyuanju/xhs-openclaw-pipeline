'use client';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { ChevronLeft, ChevronRight, ExternalLink, Images, LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';

import { apiRequest } from '../components/api-client';
import styles from './delivery-pool.module.css';
import {
  normalizeDeliveryContentPreview,
  type DeliveryContentPreview,
  type DeliveryEntry,
} from './types';

const apiPath = (path: string) => `/api/control-plane${path}`;

export function DeliveryPreviewDialog({
  entry,
  onClose,
}: {
  entry: DeliveryEntry | null;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<DeliveryContentPreview | null>(null);
  const [activePage, setActivePage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!entry) {
      setPreview(null);
      setActivePage(0);
      setError('');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError('');
    setPreview(null);
    setActivePage(0);
    void apiRequest<unknown>(apiPath(`/v1/tasks/${entry.taskId}`))
      .then((value) => {
        if (!cancelled) setPreview(normalizeDeliveryContentPreview(value, {
          copyRevisionId: entry.copyRevisionId,
          imageRunId: entry.imageRunId,
        }));
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : '交付内容预览读取失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [entry]);

  const image = preview?.images[activePage] ?? null;
  return <Dialog open={entry !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent
      className={styles.previewDialog}
      aria-describedby="delivery-preview-description"
    >
      <header className={styles.previewDialogHeader}>
        <div>
          <span className={styles.previewEyebrow}><Images size={14} />交付前核对</span>
          <DialogTitle>任务 #{entry?.taskId} 图文预览</DialogTitle>
          <DialogDescription id="delivery-preview-description">
            按当前冻结的文案与图片版本展示，不会修改交付内容。
          </DialogDescription>
        </div>
        {preview && <div className={styles.previewVersion}>
          <span>文案 #{preview.copyRevisionId}</span>
          <span>图片 {preview.imageRunId.slice(0, 8)}…</span>
        </div>}
      </header>

      {loading && <div className={styles.previewLoading}>
        <LoaderCircle className="animate-spin" size={22} />正在读取冻结交付版本…
      </div>}
      {error && <div className={styles.previewError} role="alert">{error}</div>}
      {preview && image && <div className={styles.previewBody}>
        <section className={styles.previewVisual} aria-label="交付图片预览">
          <div className={styles.previewCanvas}>
            <img
              src={apiPath(image.url)}
              alt={`任务 ${preview.taskId} 第 ${image.page} 页交付图`}
              decoding="async"
            />
          </div>
          <div className={styles.previewPager}>
            <Button unstyled className={styles.previewNavButton} type="button"
              disabled={activePage === 0} onClick={() => setActivePage((page) => page - 1)}>
              <ChevronLeft size={16} />上一页
            </Button>
            <strong>{image.page} / {preview.images.length}</strong>
            <Button unstyled className={styles.previewNavButton} type="button"
              disabled={activePage === preview.images.length - 1}
              onClick={() => setActivePage((page) => page + 1)}>
              下一页<ChevronRight size={16} />
            </Button>
          </div>
          <div className={styles.previewThumbnails} aria-label="选择预览页">
            {preview.images.map((item, index) => <Button
              unstyled
              className={styles.previewThumbnail}
              data-active={index === activePage}
              type="button"
              key={item.id}
              aria-label={`查看第 ${item.page} 页`}
              aria-pressed={index === activePage}
              onClick={() => setActivePage(index)}
            >
              <img src={apiPath(item.url)} alt="" loading="lazy" decoding="async" />
              <span>{String(item.page).padStart(2, '0')}</span>
            </Button>)}
          </div>
        </section>

        <section className={styles.previewCopy} aria-label="交付文案预览">
          <div className={styles.previewQuery}><span>原始 Query</span><p>{preview.query || '未记录'}</p></div>
          <article>
            <span>发布标题</span>
            <h3>{preview.copy.title || '未填写标题'}</h3>
          </article>
          <article className={styles.previewCopyBody}>
            <span>正文</span>
            <p>{preview.copy.body || '未填写正文'}</p>
          </article>
          <article>
            <span>标签</span>
            <div className={styles.previewTags}>{preview.copy.tags.length
              ? preview.copy.tags.map((tag) => <em key={tag}>#{tag.replace(/^#/u, '')}</em>)
              : <small>未填写标签</small>}</div>
          </article>
          <a className="button small" href={apiPath(image.url)} target="_blank" rel="noreferrer">
            <ExternalLink size={14} />新窗口查看当前原图
          </a>
        </section>
      </div>}
    </DialogContent>
  </Dialog>;
}
