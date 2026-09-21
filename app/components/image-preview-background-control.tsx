'use client';

import { Button } from '@/components/ui/button';

export type PreviewBackdrop = 'white' | 'checker' | 'dark';

const BACKDROP_OPTIONS: Array<{
  value: PreviewBackdrop;
  label: string;
  title: string;
}> = [
  { value: 'white', label: '白底', title: '白色预览底色' },
  { value: 'checker', label: '棋盘', title: '棋盘格，便于检查透明区域' },
  { value: 'dark', label: '深底', title: '深色预览底色' },
];

export function ImagePreviewBackgroundControl({
  value,
  onChange,
  tone = 'light',
}: {
  value: PreviewBackdrop;
  onChange: (value: PreviewBackdrop) => void;
  tone?: 'light' | 'dark';
}) {
  return <div className="image-preview-backdrop-control" data-tone={tone} role="group" aria-label="预览底色">
    <span className="image-preview-backdrop-label">预览底色</span>
    <div className="image-preview-backdrop-options">
      {BACKDROP_OPTIONS.map(option => <Button
        unstyled
        className="image-preview-backdrop-option"
        type="button"
        key={option.value}
        aria-label={option.title}
        aria-pressed={value === option.value}
        title={option.title}
        onClick={() => onChange(option.value)}
      >
        <i data-backdrop={option.value} aria-hidden="true" />
        <span>{option.label}</span>
      </Button>)}
    </div>
  </div>;
}
