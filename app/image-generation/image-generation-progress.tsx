import { CircleCheck, Clock3, Images, LoaderCircle } from 'lucide-react';

import { formatDuration } from '../components/time-format';
import type { ImageGenerationProgressValue } from './use-image-generation-run';

const STAGE_LABELS: Record<ImageGenerationProgressValue['stage'], string> = {
  PREPARING: '准备运行',
  PLANNING: '视觉规划',
  GENERATING: '生成图片',
  ALIGNING: 'OCR 与图文对齐',
  QUALITY_CHECK: '整套质量检查',
  FINALIZING: '保存结果',
  COMPLETED: '已完成',
  FAILED: '运行失败',
};

function remainingLabel(progress: ImageGenerationProgressValue) {
  if (progress.status !== 'RUNNING') return '0 秒';
  if (progress.estimatedRemainingMs === null) return '暂时无法准确估算';
  return `约 ${formatDuration(progress.estimatedRemainingMs)}`;
}

export function ImageGenerationProgress({
  progress,
}: {
  progress: ImageGenerationProgressValue;
}) {
  return <section className="panel standalone-image-progress" aria-labelledby="image-progress-heading" aria-live="polite">
    <div className="panel-head">
      <div>
        <span className="section-kicker">Live progress</span>
        <h2 id="image-progress-heading">图片生成进度</h2>
      </div>
      <span className={progress.status === 'FAILED' ? 'pill pill-rejected' : 'pill'}>
        {progress.status === 'COMPLETED'
          ? <><CircleCheck aria-hidden="true" size={14} />已完成</>
          : progress.status === 'FAILED'
            ? '运行失败'
            : <><LoaderCircle aria-hidden="true" className="animate-spin" size={14} />{progress.progressPercent}%</>}
      </span>
    </div>
    <progress
      className="standalone-image-progress-bar"
      max={100}
      value={progress.progressPercent}
      aria-label="图片生成进度"
    >
      {progress.progressPercent}%
    </progress>
    <p className="standalone-image-progress-message">{progress.message}</p>
    <dl className="standalone-image-progress-facts">
      <div><dt>当前阶段</dt><dd>{STAGE_LABELS[progress.stage]}</dd></div>
      <div><dt><Clock3 aria-hidden="true" size={13} />已用时间</dt><dd>{formatDuration(progress.elapsedMs)}</dd></div>
      <div><dt>预计剩余</dt><dd>{remainingLabel(progress)}</dd></div>
      <div><dt><Images aria-hidden="true" size={13} />完成图片</dt><dd>{progress.completedImages}/{progress.totalImages} 页</dd></div>
    </dl>
    <small>预计时间根据运行模式、图片页数和当前阶段计算，会随实际耗时向上修正，仅供参考。</small>
  </section>;
}
