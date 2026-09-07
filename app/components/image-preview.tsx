'use client';

import { Button } from '@/components/ui/button';
import { Checkbox, Slider, Input } from '@/components/ui/input';

import { useEffect, useId, useLayoutEffect, useState, type ComponentProps, type FormEvent, type RefObject } from 'react';

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ImagePreviewPreference, useDefaultPreviewMode, type PreviewMode } from './image-preview-preference';
import { thumbnailUrl } from '../../src/control-plane/asset-proxy.mjs';

type ImagePreviewProps = {
  src: string;
  alt: string;
  sourceSrc?: string;
  deliverySrc?: string;
  format?: string;
  transparency?: { source: boolean; delivery: boolean };
  width?: number;
  height?: number;
  needsCrop?: boolean;
  busy?: boolean;
  isOpen?: boolean;
  hideTrigger?: boolean;
  restoreFocusRef?: RefObject<HTMLElement | null>;
  preloads?: string[];
  position?: number;
  total?: number;
  onOpen?: () => void;
  onClose?: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  onCrop?: () => Promise<boolean>;
  onAiEdit?: (instruction: string) => Promise<boolean>;
};

function detectImageAlpha(image: HTMLImageElement): boolean | null {
  if (image.naturalWidth * image.naturalHeight > 40_000_000) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let offset = 3; offset < pixels.length; offset += 4) {
      if (pixels[offset] < 255) return true;
    }
    return false;
  } catch {
    return null;
  }
}

export function ImagePreviewThumbnail({ src, alt, ...props }: { src: string; alt: string } & ComponentProps<'button'>) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const previewSrc = thumbnailUrl(src);
  return <Button unstyled className="image-preview-trigger" type="button" aria-label={`预览图片：${alt}`} {...props}>
    <img className="image-preview-thumbnail" src={failedSrc === src ? src : previewSrc} alt="" loading="lazy" decoding="async"
      onError={previewSrc !== src && failedSrc !== src ? () => setFailedSrc(src) : undefined} />
    <span className="image-preview-hint" aria-hidden="true">预览与调整</span>
  </Button>;
}

export function ImagePreview({
  src,
  alt,
  sourceSrc,
  deliverySrc,
  format,
  transparency,
  width,
  height,
  needsCrop = false,
  busy = false,
  isOpen,
  hideTrigger = false,
  restoreFocusRef,
  preloads = [],
  position,
  total,
  onOpen,
  onClose,
  onPrevious,
  onNext,
  onCrop,
  onAiEdit,
}: ImagePreviewProps) {
  const id = useId();
  const [internalOpen, setInternalOpen] = useState(false);
  const defaultMode = useDefaultPreviewMode();
  const [modeOverride, setViewMode] = useState<PreviewMode | null>(null);
  const viewMode = modeOverride ?? defaultMode;
  const [zoom, setZoom] = useState(100);
  const [rotation, setRotation] = useState(0);
  const [instruction, setInstruction] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const [backdrop, setBackdrop] = useState('checker');
  const [showSource, setShowSource] = useState(false);
  const [detectedAlpha, setDetectedAlpha] = useState<boolean | null>(null);
  const [loadedImage, setLoadedImage] = useState<{ src: string; width: number; height: number } | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const open = isOpen ?? internalOpen;
  useLayoutEffect(() => { setShowSource(false); setRotation(0); setInstruction(''); }, [src]);
  const previewSrc = showSource && sourceSrc ? sourceSrc : src;
  useEffect(() => { setDetectedAlpha(null); }, [previewSrc]);
  const transparent = transparency ? (showSource ? transparency.source : transparency.delivery) : detectedAlpha;
  const imagePending = loadedImage?.src !== previewSrc;
  const imageFailed = failedSrc === previewSrc;
  const [previousSrc, nextSrc] = preloads;
  const hasTransparency = Boolean(transparency);

  useEffect(() => {
    if (!open) {
      setViewMode(null);
      setZoom(100);
      setRotation(0);
      setActionBusy(false);
      setShowSource(false);
      setLoadedImage(null);
      setFailedSrc(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const image = new Image();
    image.src = previewSrc;
    setFailedSrc(null);
    // Keep the current bitmap visible until the next one is fully decoded.
    void image.decode().then(() => {
      if (cancelled) return;
      setLoadedImage({ src: previewSrc, width: image.naturalWidth, height: image.naturalHeight });
      if (!hasTransparency) setDetectedAlpha(detectImageAlpha(image));
    }).catch(() => {
      if (!cancelled) setFailedSrc(previewSrc);
    });
    return () => { cancelled = true; };
  }, [open, previewSrc, retry, hasTransparency]);

  useEffect(() => {
    if (!open) return;
    for (const adjacentSrc of [previousSrc, nextSrc]) {
      if (!adjacentSrc) continue;
      const image = new Image();
      image.src = adjacentSrc;
      void image.decode().catch(() => { /* A failed preload is retried when selected. */ });
    }
  }, [open, previousSrc, nextSrc]);

  function resetPreview() {
    setViewMode(null);
    setZoom(100);
    setRotation(0);
  }

  function setPreviewOpen(nextOpen: boolean) {
    if (isOpen === undefined) setInternalOpen(nextOpen);
    if (nextOpen) {
      onOpen?.();
      return;
    }
    resetPreview();
    onClose?.();
  }

  function closePreview() {
    setPreviewOpen(false);
  }

  async function cropImage() {
    if (!onCrop || controlsDisabled) return;
    setActionBusy(true);
    try {
      if (await onCrop()) closePreview();
    } finally {
      setActionBusy(false);
    }
  }

  async function editWithAi(event: FormEvent) {
    event.preventDefault();
    const normalized = instruction.trim();
    if (!onAiEdit || !normalized || controlsDisabled) return;
    setActionBusy(true);
    try {
      if (await onAiEdit(normalized)) {
        setInstruction('');
        closePreview();
      }
    } finally {
      setActionBusy(false);
    }
  }

  const controlsDisabled = busy || actionBusy || imagePending;
  const isQuarterTurn = Math.abs(rotation % 180) === 90;
  const hasNavigation = typeof position === 'number' && typeof total === 'number' && total > 1;

  return <Dialog open={open} onOpenChange={setPreviewOpen}>
    {!hideTrigger && <DialogTrigger asChild><ImagePreviewThumbnail src={src} alt={alt} /></DialogTrigger>}
    <DialogContent
      className="image-preview-dialog"
      aria-label={`图片预览：${alt}`}
      aria-describedby={undefined}
      showCloseButton={false}
      onCloseAutoFocus={restoreFocusRef ? event => {
        event.preventDefault();
        restoreFocusRef.current?.focus();
      } : undefined}
    >
      <div className="image-preview-surface">
        <header className="image-preview-head">
          <div className="image-preview-title">
            <DialogTitle asChild><strong>{alt}</strong></DialogTitle>
            {width && height ? <span>{width} × {height}px</span> : null}
          </div>
          {hasNavigation && <nav className="image-preview-navigation" aria-label="图片切换">
            <Button unstyled
              className="image-preview-nav-button"
              type="button"
              aria-label="上一张图片"
              disabled={!onPrevious || busy || actionBusy}
              onClick={onPrevious}
            ><span aria-hidden="true">←</span> 上一张</Button>
            <span className="image-preview-position" aria-live="polite">{position} / {total}</span>
            <Button unstyled
              className="image-preview-nav-button"
              type="button"
              aria-label="下一张图片"
              disabled={!onNext || busy || actionBusy}
              onClick={onNext}
            >下一张 <span aria-hidden="true">→</span></Button>
          </nav>}
          <DialogClose asChild>
            <Button unstyled
              className="image-preview-close"
              type="button"
              aria-label="关闭图片预览"
            ><span aria-hidden="true">×</span></Button>
          </DialogClose>
        </header>

        <div className="image-preview-toolbar" aria-label="图片预览工具">
          <div className="image-preview-background-controls">
            <div className="image-preview-background-choice"><label htmlFor={`${id}-backdrop`}>观察底色</label>
              <Select value={backdrop} onValueChange={setBackdrop}>
                <SelectTrigger id={`${id}-backdrop`} aria-label="预览观察底色"><SelectValue /></SelectTrigger>
                <SelectContent className="image-preview-select-content">
                  <SelectItem value="checker">棋盘格 · 检查透明</SelectItem><SelectItem value="white">白色</SelectItem><SelectItem value="dark">深色</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <span role="status">{transparent === true ? '含透明像素' : transparent === false ? '不透明图片' : '透明度待检查'}{format && !showSource ? ` · ${format}` : ''}</span>
            {sourceSrc && <label><Checkbox  checked={showSource} onChange={event => setShowSource(event.target.checked)} />查看处理前源图</label>}
            {deliverySrc && <a className="button preview-button" href={deliverySrc} download>下载交付文件</a>}
            <small>观察底色只影响查看；实际填色请修改“背景处理”。</small>
          </div>
          <div className="preview-view-controls">
            <ImagePreviewPreference />
            <div className="preview-mode-control" role="group" aria-label="图片显示模式">
              <Button unstyled
                className="preview-mode-button"
                type="button"
                aria-pressed={viewMode === 'actual'}
                onClick={() => setViewMode('actual')}
              >100% 查看</Button>
              <Button unstyled
                className="preview-mode-button"
                type="button"
                aria-pressed={viewMode === 'fit'}
                onClick={() => setViewMode('fit')}
              >完整显示</Button>
            </div>
            <div className="preview-zoom-control">
              <label htmlFor={`image-zoom-${alt}`}>预览倍数</label>
              <Slider
                id={`image-zoom-${alt}`}

                min="50"
                max="250"
                step="10"
                value={zoom}
                disabled={viewMode === 'fit'}
                aria-label="调整预览倍数"
                onChange={(event) => setZoom(Number(event.target.value))}
              />
              <output htmlFor={`image-zoom-${alt}`}>{viewMode === 'fit' ? '适配' : `${zoom}%`}</output>
            </div>
          </div>
          <div className="inline preview-transform-actions">
            <Button unstyled className="button preview-button" type="button" onClick={() => setRotation((value) => value - 90)}>向左旋转</Button>
            <Button unstyled className="button preview-button" type="button" onClick={() => setRotation((value) => value + 90)}>向右旋转</Button>
            <Button unstyled className="button preview-button" type="button" onClick={resetPreview}>恢复预览</Button>
            {needsCrop && onCrop
              ? <Button unstyled className="button preview-button emphasis" type="button" disabled={controlsDisabled} onClick={cropImage}>裁成 3:4</Button>
              : <span className="preview-size-ok">尺寸已符合 3:4，无需裁剪</span>}
          </div>
        </div>

        <div className="image-preview-canvas">
          {imagePending && <div className="image-preview-loading" role={imageFailed ? 'alert' : 'status'}>
            {imageFailed ? <>无法加载 {alt}<Button unstyled type="button" className="button preview-button" onClick={() => setRetry(value => value + 1)}>重试加载</Button></> : `正在加载 ${alt}…`}
          </div>}
          <div className={`image-preview-viewport preview-background-${backdrop}${viewMode === 'fit' ? ' is-fit' : ''}`} aria-busy={imagePending && !imageFailed}>
            <div className={`image-preview-stage${viewMode === 'fit' ? ' is-fit' : ''}`}>
              <img
                className={`image-preview-full${viewMode === 'fit' ? ' is-fit' : ''}${isQuarterTurn ? ' is-quarter-turn' : ''}`}
                src={loadedImage?.src ?? previewSrc}
                alt={imagePending && loadedImage ? '上一张预览，正在加载所选图片' : alt}
                loading="eager"
                style={viewMode === 'actual'
                  ? { width: loadedImage ? loadedImage.width * zoom / 100 : width ? width * zoom / 100 : undefined, transform: `rotate(${rotation}deg)` }
                  : { transform: `rotate(${rotation}deg)` }}
              />
            </div>
          </div>
        </div>

        {onAiEdit && <form className="image-preview-ai" onSubmit={editWithAi}>
          <label htmlFor={`image-ai-${alt}`}>AI 图片修改要求</label>
          <div className="inline">
            <Input
              className="input"
              id={`image-ai-${alt}`}
              value={instruction}
              maxLength={1_000}
              placeholder="如：保留桌面主体，移除背景杂物，保持自然光"
              onChange={(event) => setInstruction(event.target.value)}
            />
            <Button unstyled className="button primary" type="submit" disabled={controlsDisabled || !instruction.trim()}>{actionBusy ? '处理中…' : '提交 AI 编辑'}</Button>
          </div>
          <p>AI 编辑会生成一个可追溯的新版本；预览旋转不会修改文件。</p>
        </form>}
      </div>
    </DialogContent>
  </Dialog>;
}
