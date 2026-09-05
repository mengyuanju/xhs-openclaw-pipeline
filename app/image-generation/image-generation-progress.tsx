import { Ban, CircleCheck, Clock3, Images, LoaderCircle } from 'lucide-react';

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
  CANCELLED: '已取消',
  FAILED: '运行失败',
};

function remainingLabel(progress: ImageGenerationProgressValue) {
  if (progress.status !== 'RUNNING') return '0 秒';
  if (progress.estimatedRemainingMs === null) return '暂时无法准确估算';
  return `约 ${formatDuration(progress.estimatedRemainingMs)}`;
}

export function ImageGenerationProgress({
  progress,
  disabled = false,
  cancelling = false,
  onCancel,
  onResume,
}: {
  progress: ImageGenerationProgressValue;
  disabled?: boolean;
  cancelling?: boolean;
  onCancel?: () => void;
  onResume?: () => void;
}) {
  return <section className="panel standalone-image-progress" aria-labelledby="image-progress-heading" aria-live="polite">
    <div className="panel-head">
      <div>
        <span className="section-kicker">Live progress</span>
        <h2 id="image-progress-heading">图片生成进度</h2>
      </div>
      <span className={['FAILED', 'CANCELLED'].includes(progress.status) ? 'pill pill-rejected' : 'pill'}>
        {progress.status === 'COMPLETED'
          ? <><CircleCheck aria-hidden="true" size={14} />已完成</>
          : progress.status === 'CANCELLED'
            ? <><Ban aria-hidden="true" size={14} />已取消</>
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
      <div><dt><Images aria-hidden="true" size={13} />已生成</dt><dd>{progress.generatedImages}/{progress.totalImages} 页</dd></div>
      <div><dt><CircleCheck aria-hidden="true" size={13} />已验收</dt><dd>{progress.validatedImages}/{progress.totalImages} 页</dd></div>
    </dl>
    {progress.status === 'RUNNING' && onCancel && <div className="standalone-image-progress-actions">
      <button className="button small danger" type="button" onClick={onCancel} disabled={cancelling}>
        {cancelling
          ? <><LoaderCircle aria-hidden="true" className="animate-spin" size={14} />正在取消…</>
          : <><Ban aria-hidden="true" size={14} />取消生成</>}
      </button>
      <span>已产生的模型费用无法撤回；取消后不会继续发起后续页面生成。</span>
    </div>}
    {progress.canResume && onResume && <div className="notice warning standalone-image-resume">
      <span>已生成图片会先重新验收；通过的图片直接复用，只为剩余或不合格页面重新生成。</span>
      <button className="button small" type="button" onClick={onResume} disabled={disabled}>
        {disabled && <LoaderCircle aria-hidden="true" className="animate-spin" size={14} />}
        重新验收并继续
      </button>
    </div>}
    <small>{progress.estimateBasis === 'stage-history'
      ? `预计时间参考同配置最近 ${progress.estimateSampleSize ?? 0} 次运行的阶段耗时中位数。`
      : progress.estimateBasis === 'stage-defaults'
        ? '历史样本不足，预计时间按页数、思考等级和出图并发初步估算。'
        : '旧记录使用按页数估算的预计时间。'}
      {' '}随阶段完成更新；超出预估时不显示虚假的倒计时，仅供参考。
    </small>
  </section>;
}
