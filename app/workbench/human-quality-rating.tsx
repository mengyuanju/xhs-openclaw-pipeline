'use client';

import { Checkbox, Textarea } from '@/components/ui/input';

export type HumanScore = 1 | 2 | 2.5 | 3;

export type HumanQualityAssessment = {
  id: number;
  taskId: number;
  stage: 'COPY' | 'IMAGE';
  copyRevisionId: number | null;
  imageRunId: string | null;
  score: HumanScore;
  scoreX10: 10 | 20 | 25 | 30;
  ratingContext: 'ORIGINAL' | 'EDITED' | 'IMAGE';
  action: string;
  reasonCodes: string[];
  problemAssetIds: number[];
  note: string | null;
  reviewerUsername: string;
  reviewSessionId: string;
  createdAt: string;
};

const SCORE_OPTIONS: Array<{ score: HumanScore; title: string; action: string }> = [
  { score: 1, title: '不可用', action: '废弃或重新处理' },
  { score: 2, title: '可修改', action: '改后需重新评分' },
  { score: 2.5, title: '已达标', action: '可放行 · 小修易达 3 分' },
  { score: 3, title: '优质可用', action: '无需修改 · 直接放行' },
];

export function isPassingHumanScore(score: HumanScore | null): score is 2.5 | 3 {
  return score === 2.5 || score === 3;
}

export function HumanScoreField({
  id,
  legend,
  value,
  disabled = false,
  onChange,
}: {
  id: string;
  legend: string;
  value: HumanScore | null;
  disabled?: boolean;
  onChange: (score: HumanScore) => void;
}) {
  return <fieldset className="human-rating-field" disabled={disabled}>
    <legend>{legend}<span>人工评分</span></legend>
    <div className="human-rating-options">
      {SCORE_OPTIONS.map((option) => <label key={option.score} data-score={option.score}
        data-passing={isPassingHumanScore(option.score)} data-selected={value === option.score}>
        <input
          type="radio"
          name={id}
          value={option.score}
          checked={value === option.score}
          onChange={() => onChange(option.score)}
        />
        <span className="human-rating-card-body">
          <span className="human-rating-card-heading">
            <span className="human-rating-card-score"><strong>{option.score}</strong><small>分</small></span>
            <strong className="human-rating-card-verdict">{option.title}</strong>
          </span>
          <span className="human-rating-card-action">{option.action}</span>
        </span>
      </label>)}
    </div>
    <p>2.5 分和 3 分达到放行标准；1 分和 2 分保留在当前阶段处理。</p>
  </fieldset>;
}

export function HumanScoreBadge({ score }: { score: HumanScore }) {
  return <strong className="human-score-badge" data-passing={isPassingHumanScore(score)}>{score} 分</strong>;
}

export function HumanRatingFeedback({
  id,
  reasonOptions,
  reasons,
  note,
  disabled = false,
  onToggleReason,
  onNoteChange,
}: {
  id: string;
  reasonOptions: ReadonlyArray<{ code: string; label: string }>;
  reasons: string[];
  note: string;
  disabled?: boolean;
  onToggleReason: (code: string) => void;
  onNoteChange: (note: string) => void;
}) {
  return <div className="human-rating-feedback">
    <fieldset disabled={disabled}>
      <legend>扣分原因 <span>原因或说明至少填写一项</span></legend>
      <div className="human-rating-reasons">
        {reasonOptions.map(reason => <label key={reason.code} data-selected={reasons.includes(reason.code)}>
          <Checkbox checked={reasons.includes(reason.code)} onChange={() => onToggleReason(reason.code)} />
          <span>{reason.label}</span>
        </label>)}
      </div>
    </fieldset>
    <div className="field full">
      <label htmlFor={`${id}-note`}>评分说明 <small>{note.length}/500，可代替原因选项</small></label>
      <Textarea
        id={`${id}-note`}
        className="textarea human-rating-note"
        value={note}
        maxLength={500}
        readOnly={disabled}
        placeholder="说明具体问题与建议处理方式"
        onChange={(event) => onNoteChange(event.target.value)}
      />
    </div>
  </div>;
}

const CONTEXT_LABELS: Record<HumanQualityAssessment['ratingContext'], string> = {
  ORIGINAL: '机器原稿初评',
  EDITED: '修改后自评',
  IMAGE: '整套图片评分',
};

const ACTION_LABELS: Record<string, string> = {
  SAVE: '已保存',
  APPROVE: '已放行',
  RETRY: '已重试',
  DISCARD: '已废弃',
};

const REASON_LABELS: Record<string, string> = {
  FACT_OR_COMPLIANCE: '事实或合规风险',
  STRUCTURE: '结构需要调整',
  EXPRESSION: '措辞或语气问题',
  TITLE: '标题吸引力不足',
  INFORMATION_VALUE: '信息价值不足',
  PLATFORM_FIT: '不符合平台表达',
  TAGS: '标签需要调整',
  IMAGE_PLAN: '图片文案规划问题',
  TEXT_ERROR: '画面文字错误',
  CONTENT_MISMATCH: '与文案内容不符',
  READABILITY: '排版或可读性',
  AESTHETICS: '风格或美观度',
  COMPOSITION: '构图或主体问题',
  ARTIFACT: '图片瑕疵或清晰度',
  COHERENCE: '图集重复或不连贯',
  COMPLIANCE: '合规或版权风险',
};

export function HumanAssessmentHistory({ assessments }: { assessments: HumanQualityAssessment[] }) {
  if (assessments.length === 0) return null;
  return <details className="human-rating-history">
    <summary>人工评分记录 · {assessments.length} 条</summary>
    <ol>
      {[...assessments].reverse().map((assessment) => <li key={assessment.id}>
        <div>
          <span>{CONTEXT_LABELS[assessment.ratingContext]} · {ACTION_LABELS[assessment.action] ?? assessment.action}</span>
          <HumanScoreBadge score={assessment.score} />
        </div>
        <small>{assessment.reviewerUsername || '历史审核人'} · {new Date(assessment.createdAt).toLocaleString('zh-CN')}</small>
        {assessment.reasonCodes.length > 0 && <p>{assessment.reasonCodes.map(reason => REASON_LABELS[reason] ?? reason).join('、')}</p>}
        {assessment.problemAssetIds.length > 0 && <p>问题图片：{assessment.problemAssetIds.map(id => `#${id}`).join('、')}</p>}
        {assessment.note && <p>{assessment.note}</p>}
      </li>)}
    </ol>
  </details>;
}
