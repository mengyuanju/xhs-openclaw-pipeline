'use client';

import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

type ImageCarouselNavigationProps = {
  children: ReactNode;
  currentIndex: number;
  total: number;
  onPrevious: () => void;
  onNext: () => void;
};

function formatPage(page: number) {
  return String(page).padStart(2, '0');
}

export function ImageCarouselNavigation({
  children,
  currentIndex,
  total,
  onPrevious,
  onNext,
}: ImageCarouselNavigationProps) {
  const canPrevious = currentIndex > 0;
  const canNext = currentIndex < total - 1;
  const previousLabel = canPrevious ? `上一张图片，第 ${formatPage(currentIndex)} 页` : '上一张图片，当前已经是首张';
  const nextLabel = canNext ? `下一张图片，第 ${formatPage(currentIndex + 2)} 页` : '下一张图片，当前已经是末张';

  return <div className="image-carousel-navigation" aria-label="图片翻页">
    <Button
      unstyled
      className="image-carousel-navigation-button"
      type="button"
      data-direction="previous"
      aria-label={previousLabel}
      title={previousLabel}
      disabled={!canPrevious}
      onClick={onPrevious}
    >
      <span className="image-carousel-navigation-icon"><ChevronLeft size={19} aria-hidden="true" /></span>
      <strong>上张</strong>
    </Button>

    <div className="image-carousel-navigation-viewport">{children}</div>

    <Button
      unstyled
      className="image-carousel-navigation-button"
      type="button"
      data-direction="next"
      aria-label={nextLabel}
      title={nextLabel}
      disabled={!canNext}
      onClick={onNext}
    >
      <span className="image-carousel-navigation-icon"><ChevronRight size={19} aria-hidden="true" /></span>
      <strong>下张</strong>
    </Button>
  </div>;
}
