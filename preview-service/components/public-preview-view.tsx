'use client';

import { useState } from 'react';

import type { PublicPreview } from '@/lib/preview-types';

export function PublicPreviewView({ preview }: { preview: PublicPreview }) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const imagePositions = Array.from(
    { length: preview.imageCount },
    (_, index) => index + 1,
  );

  return (
    <main className="flex h-screen w-full select-none items-center justify-center overflow-hidden bg-white p-5 font-sans text-black">
      <div className="flex h-[80vh] max-h-[80vh] w-[95%] max-w-[1200px] items-stretch justify-center">
        <section
          className="relative flex w-[54.33%] max-w-[640px] shrink-0 items-center justify-center overflow-hidden bg-[#f8f8fa]"
          aria-roledescription="轮播图"
          aria-label={`${preview.title}，共 ${preview.imageCount} 张图片`}
        >
          <div className="relative h-full w-full overflow-hidden">
            <div
              className="flex h-full w-full transition-transform duration-300 ease-in-out"
              style={{ transform: `translateX(-${currentIndex * 100}%)` }}
            >
              {imagePositions.map((position, index) => (
                <div
                  key={position}
                  className="flex h-full w-full shrink-0 items-center justify-center"
                >
                  {/* The preview endpoint returns the stored original bytes. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/public/previews/${preview.publicId}/images/${position}`}
                    alt={`${preview.title}，第 ${position} 张图片`}
                    className="h-auto max-h-full w-auto max-w-full object-contain"
                    draggable={false}
                    loading={index === 0 ? 'eager' : 'lazy'}
                  />
                </div>
              ))}
            </div>

            {currentIndex > 0 ? (
              <button
                type="button"
                aria-label="上一张"
                onClick={() => setCurrentIndex((index) => index - 1)}
                className="absolute left-2.5 top-1/2 z-[1] flex size-[30px] -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border-0 bg-black/60 p-0 text-2xl leading-none text-white transition-opacity hover:opacity-75 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
              >
                <span className="relative -top-[3px]">‹</span>
              </button>
            ) : null}

            {currentIndex < preview.imageCount - 1 ? (
              <button
                type="button"
                aria-label="下一张"
                onClick={() => setCurrentIndex((index) => index + 1)}
                className="absolute right-2.5 top-1/2 z-[1] flex size-[30px] -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border-0 bg-black/60 p-0 text-2xl leading-none text-white transition-opacity hover:opacity-75 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
              >
                <span className="relative -top-[3px]">›</span>
              </button>
            ) : null}

            <div
              className="absolute right-5 top-5 z-10 rounded-xl bg-black/60 px-3 py-1 text-xs leading-[18px] text-white"
              aria-live="polite"
            >
              {currentIndex + 1} / {preview.imageCount}
            </div>
          </div>
        </section>

        <article className="preview-copy-scrollbar flex max-h-[90vh] max-w-[560px] flex-1 select-text flex-col overflow-y-auto px-[clamp(20px,3.125vw,40px)] text-base">
          <div className="w-full p-0 leading-[1.8] text-[#333]">
            <h1 className="mb-8 mt-6 text-[22px] font-semibold leading-[1.4] text-black">
              {preview.title}
            </h1>
            {preview.body ? (
              <div className="whitespace-pre-line break-words">
                {preview.body}
              </div>
            ) : null}
          </div>
        </article>
      </div>
    </main>
  );
}
