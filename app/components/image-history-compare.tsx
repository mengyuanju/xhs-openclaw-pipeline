'use client';

import { Disclosure, DisclosureTrigger, DisclosureContent } from '@/components/ui/disclosure';
import { Button } from '@/components/ui/button';

import { useId, useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ImagePreview } from './image-preview';
import type { ImageSettings, PageLayout } from './image-controls';

export type ImageArtifactInfo = { assetId?: number; sourceUrl?: string; deliveryUrl?: string; deliveryAssetId?: number; imageSettings?: ImageSettings; transparency?: { source: boolean; delivery: boolean } };
export type ImageRunHistory = { id: string; result: { images?: ImageArtifactInfo[]; imageSettings?: ImageSettings; imagePlan?: Array<{ layout?: PageLayout }>; processing?: { type: string } } | null };

export function ImageHistoryCompare({ runs, currentRunId, assets, onRestore }: {
  runs: ImageRunHistory[]; currentRunId: string | null; assets: Array<{ id: number; url: string }>;
  onRestore?: (settings: ImageSettings) => void;
}) {
  const [selected, setSelected] = useState('');
  const id = useId();
  const previous = runs.filter(run => run.id !== currentRunId && run.result?.images?.length);
  const run = previous.find(item => item.id === selected) ?? previous[0];
  if (!run) return null;
  const url = (path: string) => `/api/control-plane${path}`;
  return <Disclosure className="image-history-compare"><DisclosureTrigger>历史图片 · 对照当前成品</DisclosureTrigger><DisclosureContent>
    <div className="field"><label htmlFor={id}>查看历史版本</label>
      <Select value={run.id} onValueChange={setSelected}>
        <SelectTrigger id={id} aria-label="历史图片版本"><SelectValue /></SelectTrigger>
        <SelectContent>{previous.map((item, index) => <SelectItem key={item.id} value={item.id}>历史 {index + 1} · {item.result?.imageSettings?.format ?? 'PNG'} · {item.id.slice(0, 8)}</SelectItem>)}</SelectContent>
      </Select>
    </div>
    <div className="distributed-asset-grid">{run.result?.images?.map((image, index) => {
      const asset = assets.find(item => item.id === image.assetId);
      return asset ? <figure key={asset.id}><ImagePreview src={url(asset.url)} alt={`历史版本第 ${index + 1} 张`} sourceSrc={image.sourceUrl ? url(image.sourceUrl) : undefined} deliverySrc={image.deliveryUrl ? url(image.deliveryUrl) : undefined} transparency={image.transparency} format={image.imageSettings?.format} /><figcaption>历史第 {index + 1} 张</figcaption></figure> : null;
    })}</div>
    {onRestore && run.result?.imageSettings && <Button unstyled className="button small" type="button" onClick={() => onRestore(run.result!.imageSettings!)}>恢复此版本的格式与背景参数</Button>}
    <p className="subtle">恢复参数后仍需提交生成或转换；当前交付文件和审核状态不会立即改变。</p>
  </DisclosureContent></Disclosure>;
}
