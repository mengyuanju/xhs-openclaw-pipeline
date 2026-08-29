'use client';

import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';

type PreviewMode = 'actual' | 'fit';

type ImagePreviewProps = {
  src: string;
  alt: string;
  width?: number;
  height?: number;
  needsCrop?: boolean;
  busy?: boolean;
  isOpen?: boolean;
  position?: number;
  total?: number;
  onOpen?: () => void;
  onClose?: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  onCrop?: () => Promise<boolean>;
  onAiEdit?: (instruction: string) => Promise<boolean>;
};

export function ImagePreview({
  src,
  alt,
  width,
  height,
  needsCrop = false,
  busy = false,
  isOpen,
  position,
  total,
  onOpen,
  onClose,
  onPrevious,
  onNext,
  onCrop,
  onAiEdit,
}: ImagePreviewProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [viewMode, setViewMode] = useState<PreviewMode>('actual');
  const [zoom, setZoom] = useState(100);
  const [rotation, setRotation] = useState(0);
  const [instruction, setInstruction] = useState('');
  const [actionBusy, setActionBusy] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || isOpen === undefined) return;
    if (isOpen && !dialog.open) {
      dialog.showModal();
      closeRef.current?.focus();
    } else if (!isOpen && dialog.open) {
      dialog.close();
    }
  }, [isOpen]);

  function openPreview() {
    if (onOpen) {
      onOpen();
      return;
    }
    if (!dialogRef.current?.open) {
      dialogRef.current?.showModal();
      closeRef.current?.focus();
    }
  }

  function closePreview() {
    dialogRef.current?.close();
  }

  function resetPreview() {
    setViewMode('actual');
    setZoom(100);
    setRotation(0);
    setActionBusy(false);
  }

  function handleDialogClose() {
    resetPreview();
    onClose?.();
  }

  function closeOnBackdrop(event: MouseEvent<HTMLDialogElement>) {
    if (event.target === event.currentTarget) event.currentTarget.close();
  }

  async function cropImage() {
    if (!onCrop) return;
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
    if (!onAiEdit || !normalized) return;
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

  const controlsDisabled = busy || actionBusy;
  const isQuarterTurn = Math.abs(rotation % 180) === 90;
  const hasNavigation = typeof position === 'number' && typeof total === 'number' && total > 1;

  return <>
    <button
      className="image-preview-trigger"
      type="button"
      aria-label={`预览图片：${alt}`}
      onClick={openPreview}
    >
      <img className="image-preview-thumbnail" src={src} alt="" />
      <span className="image-preview-hint" aria-hidden="true">预览与调整</span>
    </button>
    <dialog
      ref={dialogRef}
      className="image-preview-dialog"
      aria-label={`图片预览：${alt}`}
      onClick={closeOnBackdrop}
      onClose={handleDialogClose}
    >
      <div className="image-preview-surface">
        <header className="image-preview-head">
          <div className="image-preview-title">
            <strong>{alt}</strong>
            {width && height ? <span>{width} × {height}px</span> : null}
          </div>
          {hasNavigation && <nav className="image-preview-navigation" aria-label="图片切换">
            <button
              className="image-preview-nav-button"
              type="button"
              aria-label="上一张图片"
              disabled={!onPrevious}
              onClick={onPrevious}
            ><span aria-hidden="true">←</span> 上一张</button>
            <span className="image-preview-position" aria-live="polite">{position} / {total}</span>
            <button
              className="image-preview-nav-button"
              type="button"
              aria-label="下一张图片"
              disabled={!onNext}
              onClick={onNext}
            >下一张 <span aria-hidden="true">→</span></button>
          </nav>}
          <button
            ref={closeRef}
            className="image-preview-close"
            type="button"
            aria-label="关闭图片预览"
            onClick={closePreview}
          ><span aria-hidden="true">×</span></button>
        </header>

        <div className="image-preview-toolbar" aria-label="图片预览工具">
          <div className="preview-view-controls">
            <div className="preview-mode-control" role="group" aria-label="图片显示模式">
              <button
                className="preview-mode-button"
                type="button"
                aria-pressed={viewMode === 'actual'}
                onClick={() => setViewMode('actual')}
              >100% 查看</button>
              <button
                className="preview-mode-button"
                type="button"
                aria-pressed={viewMode === 'fit'}
                onClick={() => setViewMode('fit')}
              >完整显示</button>
            </div>
            <div className="preview-zoom-control">
              <label htmlFor={`image-zoom-${alt}`}>预览倍数</label>
              <input
                id={`image-zoom-${alt}`}
                type="range"
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
            <button className="button preview-button" type="button" onClick={() => setRotation((value) => value - 90)}>向左旋转</button>
            <button className="button preview-button" type="button" onClick={() => setRotation((value) => value + 90)}>向右旋转</button>
            <button className="button preview-button" type="button" onClick={() => { setViewMode('actual'); setZoom(100); setRotation(0); }}>恢复预览</button>
            {needsCrop && onCrop
              ? <button className="button preview-button emphasis" type="button" disabled={controlsDisabled} onClick={cropImage}>裁成 3:4</button>
              : <span className="preview-size-ok">尺寸已符合 3:4，无需裁剪</span>}
          </div>
        </div>

        <div className={`image-preview-viewport${viewMode === 'fit' ? ' is-fit' : ''}`}>
          <div className={`image-preview-stage${viewMode === 'fit' ? ' is-fit' : ''}`}>
            <img
              className={`image-preview-full${viewMode === 'fit' ? ' is-fit' : ''}${isQuarterTurn ? ' is-quarter-turn' : ''}`}
              src={src}
              alt={alt}
              loading="lazy"
              style={viewMode === 'actual'
                ? { width: `${zoom}%`, transform: `rotate(${rotation}deg)` }
                : { transform: `rotate(${rotation}deg)` }}
            />
          </div>
        </div>

        {onAiEdit && <form className="image-preview-ai" onSubmit={editWithAi}>
          <label htmlFor={`image-ai-${alt}`}>AI 图片修改要求</label>
          <div className="inline">
            <input
              className="input"
              id={`image-ai-${alt}`}
              value={instruction}
              maxLength={1_000}
              placeholder="如：保留桌面主体，移除背景杂物，保持自然光"
              onChange={(event) => setInstruction(event.target.value)}
            />
            <button className="button primary" type="submit" disabled={controlsDisabled || !instruction.trim()}>{actionBusy ? '处理中…' : '提交 AI 编辑'}</button>
          </div>
          <p>AI 编辑会生成一个可追溯的新版本；预览旋转不会修改文件。</p>
        </form>}
      </div>
    </dialog>
  </>;
}
