'use client';

import { Disclosure, DisclosureTrigger, DisclosureContent } from '@/components/ui/disclosure';

import { useRef, useState } from 'react';

import { ImagePreview, ImagePreviewThumbnail } from '../../components/image-preview';
import { ImagePreviewPreference } from '../../components/image-preview-preference';
import { StatusPill } from '../../components/status-pill';
import { formatDuration } from '../../components/time-format';
import { PromptTrace } from './generation-prompt-trace';
import { StageReviewTrace } from './generation-stage-reviews';
import { VisualPlanTrace } from './generation-visual-plan';
import { QualityIssueList } from './quality-issue-list';
import {
  imageNeedsCrop,
  qualityDimensionRows,
  qualityIssueRows,
  qualityReasons,
} from './review-presentation.mjs';

type ImageOperation =
  | { type: 'crop-3x4' }
  | { type: 'ai-edit'; instruction: string };

type ImageGenerationBatchProps = {
  batch: any;
  config: any;
  visualReference: any;
  imageEditRequests: any[];
  busy: boolean;
  qualityScoreLabel: (score: unknown) => string;
  onEdit: (assetId: number, operation: ImageOperation, label: string) => Promise<boolean>;
};

function batchTitle(batch: any) {
  if (batch.kind === 'reference') return '参考图片';
  if (batch.kind === 'historical') return '历史图片批次';
  return `图片生成批次 ${batch.run.attempt}`;
}

function assetKindLabel(kind: string) {
  if (kind === 'REFERENCE') return '参考图';
  if (kind === 'EDITED') return '编辑版本';
  return '生成图';
}

function BatchQuality({ run, qualityScoreLabel }: { run: any; qualityScoreLabel: (score: unknown) => string }) {
  const reasons = qualityReasons(run);
  const dimensions = qualityDimensionRows(run);
  const issues = qualityIssueRows(run);
  const qualityRepair = run?.qcDetail?.qualityRepair;
  const repairAttempts = Array.isArray(qualityRepair?.attempts) ? qualityRepair.attempts : [];
  const settings = run?.qcDetail?.productionSettings;
  return <div className="batch-quality">
    <div className="batch-score-row">
      <span className="batch-score">{qualityScoreLabel(run?.qcScore)}</span>
      <span className="subtle">{run?.qcDisposition || '尚未质检'}</span>
    </div>
    <div>
      <strong className="batch-label">评分原因</strong>
      <ul className="quality-reason-list">{reasons.map((reason: string) => <li key={reason}>{reason}</li>)}</ul>
    </div>
    <QualityIssueList issues={issues} />
    {settings && <div className="batch-policy-summary"><span>整套修复：{settings.qualityRepairEnabled ? `${settings.qualityRepairTriggerScore} 分触发，目标 ${settings.qualityRepairTargetScore} 分，最多 ${settings.qualityRepairMaxAttempts} 次` : '关闭'}</span><span>合规标识：{settings.aiDisclosureEnabled ? settings.aiDisclosureText : '关闭'}</span></div>}
    {repairAttempts.length > 0 && <section className="quality-repair-history" aria-label="质量修复历史">
      <div className="quality-repair-summary"><strong>质量修复</strong><span>{qualityRepair.initialScore} 分 → {qualityRepair.finalScore} 分 · 共 {repairAttempts.length} 次</span></div>
      <ol>{repairAttempts.map((attempt: any) => <li key={attempt.round}>
        <div className="quality-repair-attempt-head"><strong>第 {attempt.round} 次修复{attempt.status === 'FAILED' ? '（未完成）' : ''}</strong><span>{attempt.scoreBefore} 分 → {attempt.scoreAfter ?? '未重新评分'} · {formatDuration(attempt.durationMs)}</span></div>
        <div className="quality-repair-evidence"><strong>修复原因</strong><ul>{attempt.reasons.map((reason: string) => <li key={reason}>{reason}</li>)}</ul></div>
        <div className="quality-repair-evidence"><strong>修复方法</strong><ul>{attempt.methods.map((method: string) => <li key={method}>{method}</li>)}</ul></div>
      </li>)}</ol>
    </section>}
    {dimensions.length > 0 && <Disclosure className="quality-details">
      <DisclosureTrigger>查看全部逐项评分</DisclosureTrigger><DisclosureContent>
      <dl>{dimensions.map((dimension: any) => <div key={dimension.key}>
        <dt>{dimension.label}<strong>{dimension.score ?? '—'} 分</strong></dt>
        <dd>{dimension.evidence.map((item: string) => <span key={item}>{item}</span>)}</dd>
      </div>)}</dl>
    </DisclosureContent></Disclosure>}
  </div>;
}

export function ImageGenerationBatch({
  batch,
  config,
  visualReference,
  imageEditRequests,
  busy,
  qualityScoreLabel,
  onEdit,
}: ImageGenerationBatchProps) {
  const [activeAssetIndex, setActiveAssetIndex] = useState<number | null>(null);
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const activeAsset = activeAssetIndex === null ? undefined : batch.assets[activeAssetIndex];
  const run = batch.run;
  const sourceTextRevisionId = batch.assets.find((asset: any) => asset.sourceTextRevisionId)?.sourceTextRevisionId;
  const isReference = batch.kind === 'reference';
  const isEmptyFailure = run?.status === 'FAILED' && batch.assets.length === 0;
  const runTiming = run
    ? `${run.startedAt ? new Date(run.startedAt).toLocaleString('zh-CN') : '开始时间暂无'} → ${run.finishedAt ? new Date(run.finishedAt).toLocaleString('zh-CN') : '尚未结束'} · ${formatDuration(run.durationMs)}`
    : '';

  if (isEmptyFailure) {
    const [failureReason] = qualityReasons(run);
    return <Disclosure className="image-generation-batch compact-failed-batch">
      <DisclosureTrigger>
        <span className="compact-failed-main">
          <strong>{batchTitle(batch)}</strong>
          <StatusPill value="FAILED" />
        </span>
        <span className="compact-failed-reason">{failureReason}</span>
        {run.finishedAt && <time dateTime={run.finishedAt}>{new Date(run.finishedAt).toLocaleString('zh-CN')}</time>}
      </DisclosureTrigger><DisclosureContent>
      <div className="compact-failed-body">
        <div className="batch-context-grid">
          <section className="batch-version-summary" aria-label="批次版本信息">
            <strong className="batch-label">版本信息</strong>
            <dl>
              <div><dt>文案版本</dt><dd>#{sourceTextRevisionId || '—'}</dd></div>
              <div><dt>视觉配方</dt><dd>{visualReference ? `${visualReference.type} · v#${visualReference.versionId}` : '未锁定'}</dd></div>
              <div><dt>图片策略</dt><dd>自动 3–5 张 · 本次 {config?.imageCount || '—'} 张</dd></div>
            </dl>
          </section>
          <BatchQuality run={run} qualityScoreLabel={qualityScoreLabel} />
        </div>
        {runTiming && <p className="batch-timing-line">批次时间：{runTiming}</p>}
        <Disclosure className="batch-trace">
          <DisclosureTrigger>查看 Query 与文本审核</DisclosureTrigger><DisclosureContent>
          <StageReviewTrace stageReviews={run?.stageReviews} />
        </DisclosureContent></Disclosure>
        <Disclosure className="batch-trace">
          <DisclosureTrigger>查看本批次用户提示词</DisclosureTrigger><DisclosureContent>
          <PromptTrace run={run} />
        </DisclosureContent></Disclosure>
        <Disclosure className="batch-trace">
          <DisclosureTrigger>查看本批次 VisualPlan</DisclosureTrigger><DisclosureContent>
          <VisualPlanTrace visualPlan={run?.visualPlan} />
        </DisclosureContent></Disclosure>
      </div>
    </DisclosureContent></Disclosure>;
  }

  return <article className={`image-generation-batch${batch.isCurrent ? ' current' : ''}`}>
    <header className="image-generation-batch-head">
      <div>
        <div className="inline batch-heading-line">
          <h3>{batchTitle(batch)}</h3>
          {batch.isCurrent && <span className="current-batch-mark">当前文案</span>}
          {run && <StatusPill value={run.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED'} />}
        </div>
        <p>{isReference
          ? '人工上传的参考素材，供后续生成和编辑使用。'
          : `${run?.mode === 'mock' ? 'Mock 生成' : run ? 'Live 生成' : '历史记录'} · ${batch.assets.length} 个图片版本`}</p>
      </div>
      <div className="inline"><ImagePreviewPreference />{runTiming && <span className="batch-timing-line">{runTiming}</span>}</div>
    </header>

    {!isReference && <div className="batch-context-grid">
      <section className="batch-version-summary" aria-label="批次版本信息">
        <strong className="batch-label">版本信息</strong>
        <dl>
          <div><dt>文案版本</dt><dd>#{sourceTextRevisionId || '—'}</dd></div>
          <div><dt>视觉配方</dt><dd>{visualReference ? `${visualReference.type} · v#${visualReference.versionId}` : '未锁定'}</dd></div>
          <div><dt>图片策略</dt><dd>自动 3–5 张 · 本次 {config?.imageCount || '—'} 张</dd></div>
        </dl>
      </section>
      <BatchQuality run={run} qualityScoreLabel={qualityScoreLabel} />
    </div>}

    {batch.assets.length === 0
      ? <div className="batch-empty">这个运行批次没有保存可预览图片。</div>
      : <div className="asset-grid">{batch.assets.map((asset: any, assetIndex: number) => {
          const requests = imageEditRequests.filter((request: any) => request.sourceAssetId === asset.id);
          const alt = `${assetKindLabel(asset.kind)} · 版本 ${asset.revision}${asset.pageIndex ? ` · 第 ${asset.pageIndex} 页` : ''}`;
          return <article className="asset-card" key={asset.id}>
            <ImagePreviewThumbnail
              src={`/api/assets/${asset.id}?v=${asset.sha256}`}
              alt={alt}
              onClick={event => { previewTriggerRef.current = event.currentTarget; setActiveAssetIndex(assetIndex); }}
            />
            <div className="asset-meta">
              <div className="asset-meta-title">
                <strong>{asset.pageIndex ? `第 ${asset.pageIndex} 页` : assetKindLabel(asset.kind)}</strong>
                <StatusPill value={asset.kind === 'REFERENCE' ? 'DRAFT' : asset.alignmentStatus} />
              </div>
              <span>图片版本 #{asset.revision} · {asset.width} × {asset.height}px</span>
              {asset.sourceTextRevisionId && <span>对应文案 #{asset.sourceTextRevisionId}</span>}
              {typeof asset.alignmentResult?.ocrConfidence === 'number' && <span>GPT OCR {Math.round(asset.alignmentResult.ocrConfidence * 100)}% · {asset.alignmentResult.ocrExactMatch ? '逐字一致' : '需要修复'}</span>}
              {requests.map((request: any) => <span className="asset-request-status" key={request.id}>AI 编辑 #{request.id}：{request.status}{request.error ? ` · ${request.error}` : ''}</span>)}
            </div>
          </article>;
        })}</div>}
    {activeAsset && activeAssetIndex !== null && <ImagePreview
      hideTrigger
      isOpen
      restoreFocusRef={previewTriggerRef}
      src={`/api/assets/${activeAsset.id}?v=${activeAsset.sha256}`}
      alt={`${assetKindLabel(activeAsset.kind)} · 版本 ${activeAsset.revision}${activeAsset.pageIndex ? ` · 第 ${activeAsset.pageIndex} 页` : ''}`}
      width={activeAsset.width}
      height={activeAsset.height}
      needsCrop={imageNeedsCrop(activeAsset.width, activeAsset.height)}
      busy={busy}
      position={activeAssetIndex + 1}
      total={batch.assets.length}
      preloads={batch.assets.slice(Math.max(0, activeAssetIndex - 1), activeAssetIndex + 2).filter((asset: any) => asset.id !== activeAsset.id).map((asset: any) => `/api/assets/${asset.id}?v=${asset.sha256}`)}
      onClose={() => setActiveAssetIndex(null)}
      onPrevious={activeAssetIndex > 0 ? () => setActiveAssetIndex(index => index === null ? null : index - 1) : undefined}
      onNext={activeAssetIndex < batch.assets.length - 1 ? () => setActiveAssetIndex(index => index === null ? null : index + 1) : undefined}
      onCrop={() => onEdit(activeAsset.id, { type: 'crop-3x4' }, '3:4 裁切')}
      onAiEdit={instruction => onEdit(activeAsset.id, { type: 'ai-edit', instruction }, 'AI 编辑请求入队')}
    />}

    {!isReference && <Disclosure className="batch-trace">
      <DisclosureTrigger>查看 Query 与文本审核</DisclosureTrigger><DisclosureContent>
      <StageReviewTrace stageReviews={run?.stageReviews} />
    </DisclosureContent></Disclosure>}
    {!isReference && <Disclosure className="batch-trace">
      <DisclosureTrigger>查看本批次用户提示词</DisclosureTrigger><DisclosureContent>
      <PromptTrace run={run} />
    </DisclosureContent></Disclosure>}
    {!isReference && <Disclosure className="batch-trace">
      <DisclosureTrigger>查看本批次 VisualPlan</DisclosureTrigger><DisclosureContent>
      <VisualPlanTrace visualPlan={run?.visualPlan} />
    </DisclosureContent></Disclosure>}
  </article>;
}
