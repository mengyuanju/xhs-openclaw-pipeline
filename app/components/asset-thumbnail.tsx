'use client';

import { useState, type ComponentProps } from 'react';
import { thumbnailUrl } from '../../src/control-plane/asset-proxy.mjs';

// A thumbnail failure must not prevent an operator from opening the actual image.
export function AssetThumbnail({ src, onError, ...props }: ComponentProps<'img'> & { src: string }) {
  const [failedSource, setFailedSource] = useState('');
  const preview = thumbnailUrl(src);
  return <img {...props} src={failedSource === src ? src : preview} decoding="async"
    onError={event => {
      if (preview !== src && failedSource !== src) setFailedSource(src);
      else onError?.(event);
    }} />;
}
