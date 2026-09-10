'use client';

import { Checkbox, Textarea } from '@/components/ui/input';

import type { HumanScore, HumanScoreDefinition } from './human-quality-settings';

export type { HumanScore } from './human-quality-settings';

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

export type HumanScorePresentation = {
  scoreDefinitions: ReadonlyArray<HumanScoreDefinition>;
  passingScores: ReadonlyArray<HumanScore>;
  guidance: string;
};

const DEFAULT_PASSING_SCORES: ReadonlyArray<HumanScore> = Object.freeze([2.5, 3]);
const DEFAULT_SCORE_GUIDANCE = '2.5 分和 3 分达到放行标准；1 分和 2 分保留在当前阶段处理。';

export const COPY_MACHINE_DRAFT_SCORE_PRESENTATION: HumanScorePresentation = Object.freeze({
  scoreDefinitions: Object.freeze([
    Object.freeze({ score: 1, title: '废弃', description: '原稿不可用，填写反馈后废弃任务' }),
    Object.freeze({ score: 2, title: '必须修改', description: '完成真实修改后，最终稿自动记为 3 分' }),
    Object.freeze({ score: 2.5, title: '必须小修', description: '完成真实修改后，最终稿自动记为 3 分' }),
    Object.freeze({ score: 3, title: '可直接通过', description: '原稿无需修改，可直接通过' }),
  ]),
  passingScores: Object.freeze<HumanScore[]>([3]),
  guidance: '机器原稿：1 分废弃；2 分和 2.5 分必须真实修改，修改后的最终稿自动记为 3 分；只有原稿 3 分可直接通过。',
});

export function isPassingHumanScore(score: HumanScore | null): score is 2.5 | 3 {
  return score === 2.5 || score === 3;
}

export function HumanScoreField({
  id,
  legend,
  value,
  scoreDefinitions,
  passingScores = DEFAULT_PASSING_SCORES,
  guidance = DEFAULT_SCORE_GUIDANCE,
  showDescriptions = true,
  disabled = false,
  onChange,
}: {
  id: string;
  legend: string;
  value: HumanScore | null;
  scoreDefinitions: ReadonlyArray<HumanScoreDefinition>;
  passingScores?: ReadonlyArray<HumanScore>;
  guidance?: string;
  showDescriptions?: boolean;
  disabled?: boolean;
  onChange: (score: HumanScore) => void;
}) {
  return <fieldset className="human-rating-field" disabled={disabled}>
    <legend>{legend}<span>人工评分</span></legend>
    <div className="human-rating-options">
      {scoreDefinitions.map((option) => <label key={option.score} data-score={option.score}
        data-passing={passingScores.includes(option.score)} data-selected={value === option.score}>
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
            {showDescriptions && <strong className="human-rating-card-verdict">{option.title}</strong>}
          </span>
          {showDescriptions && <span className="human-rating-card-action">{option.description}</span>}
        </span>
      </label>)}
    </div>
    <p>{guidance}</p>
  </fieldset>;
}

export function CopyMachineDraftScoreField({
  id,
  legend,
  value,
  showDescriptions = true,
  disabled = false,
  onChange,
}: Omit<Parameters<typeof HumanScoreField>[0], 'scoreDefinitions' | 'passingScores' | 'guidance'>) {
  return <HumanScoreField
    id={id}
    legend={legend}
    value={value}
    scoreDefinitions={COPY_MACHINE_DRAFT_SCORE_PRESENTATION.scoreDefinitions}
    passingScores={COPY_MACHINE_DRAFT_SCORE_PRESENTATION.passingScores}
    guidance={COPY_MACHINE_DRAFT_SCORE_PRESENTATION.guidance}
    showDescriptions={showDescriptions}
    disabled={disabled}
    onChange={onChange}
  />;
}

export function HumanScoreBadge({
  score,
  passingScores = DEFAULT_PASSING_SCORES,
}: {
  score: HumanScore;
  passingScores?: ReadonlyArray<HumanScore>;
}) {
  return <strong className="human-score-badge" data-passing={passingScores.includes(score)}>{score} 分</strong>;
}

export function HumanRatingFeedback({
  id,
  reasonOptions,
  reasons,
  note,
  notePlaceholder,
  showReasonOptions = true,
  disabled = false,
  onToggleReason,
  onNoteChange,
}: {
  id: string;
  reasonOptions: ReadonlyArray<{ code: string; label: string }>;
  reasons: string[];
  note: string;
  notePlaceholder: string;
  showReasonOptions?: boolean;
  disabled?: boolean;
  onToggleReason: (code: string) => void;
  onNoteChange: (note: string) => void;
}) {
  return <div className="human-rating-feedback">
    {showReasonOptions && <fieldset disabled={disabled}>
      <legend>扣分原因 <span>原因或说明至少填写一项</span></legend>
      <div className="human-rating-reasons">
        {reasonOptions.map(reason => <label key={reason.code} data-selected={reasons.includes(reason.code)}>
          <Checkbox checked={reasons.includes(reason.code)} onChange={() => onToggleReason(reason.code)} />
          <span>{reason.label}</span>
        </label>)}
      </div>
    </fieldset>}
    <div className="field full">
      <label htmlFor={`${id}-note`}>评分说明 <small>{note.length}/500，{showReasonOptions ? '可代替原因选项' : '低于 3 分时必填'}</small></label>
      <Textarea
        id={`${id}-note`}
        className="textarea human-rating-note"
        value={note}
        maxLength={500}
        readOnly={disabled}
        placeholder={notePlaceholder}
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

export function HumanAssessmentHistory({
  assessments,
  scoreDefinitions,
  reasonOptions,
  originalScorePresentation,
  showScoreDescriptions = true,
  showReasonOptions = true,
}: {
  assessments: HumanQualityAssessment[];
  scoreDefinitions: ReadonlyArray<HumanScoreDefinition>;
  reasonOptions: ReadonlyArray<{ code: string; label: string }>;
  originalScorePresentation?: HumanScorePresentation;
  showScoreDescriptions?: boolean;
  showReasonOptions?: boolean;
}) {
  if (assessments.length === 0) return null;
  const configuredReasonLabels = new Map(reasonOptions.map((reason) => [reason.code, reason.label]));
  return <details className="human-rating-history">
    <summary>人工评分记录 · {assessments.length} 条</summary>
    <ol>
      {[...assessments].reverse().map((assessment) => {
        const presentation = assessment.ratingContext === 'ORIGINAL' ? originalScorePresentation : undefined;
        const displayedScoreDefinitions = presentation?.scoreDefinitions ?? scoreDefinitions;
        const scoreDefinition = displayedScoreDefinitions.find((definition) => definition.score === assessment.score);
        return <li key={assessment.id}>
        <div>
          <span>{CONTEXT_LABELS[assessment.ratingContext]} · {ACTION_LABELS[assessment.action] ?? assessment.action}</span>
          <HumanScoreBadge score={assessment.score} passingScores={presentation?.passingScores} />
        </div>
        <small>{assessment.reviewerUsername || '历史审核人'} · {new Date(assessment.createdAt).toLocaleString('zh-CN')}</small>
        {showScoreDescriptions && scoreDefinition && <p><strong>{scoreDefinition.title}</strong> · {scoreDefinition.description}</p>}
        {showReasonOptions && assessment.reasonCodes.length > 0 && <p>{assessment.reasonCodes.map(reason => configuredReasonLabels.get(reason) ?? REASON_LABELS[reason] ?? reason).join('、')}</p>}
        {assessment.problemAssetIds.length > 0 && <p>问题图片：{assessment.problemAssetIds.map(id => `#${id}`).join('、')}</p>}
        {assessment.note && <p>{assessment.note}</p>}
      </li>})}
    </ol>
  </details>;
}
