import { businessPrompt } from './prompt-runtime.mjs';
import { normalizeProductionSettings } from './production-settings.mjs';

const IMAGE_REPAIR_DIMENSIONS = [
  'imageBaseQuality',
  'imageTextQuality',
  'imageConsistency',
  'imageAesthetics',
  'imageDiversity',
  'queryRelevance',
  'informationValue',
  'platformAdaptation',
  'contentOriginality',
  'noteTone',
];
const CONTENT_REGENERATION_DIMENSIONS = Object.freeze([
  'queryRelevance',
  'informationValue',
  'noteTone',
]);
const CONTENT_BLOCKING_CHECKS = new Set([
  'fabricated_experience',
  'risk_flags',
  'unverified_claims',
]);

function boundedText(value, maximum = 300) {
  return [...String(value ?? '').replace(/\s+/gu, ' ').trim()].slice(0, maximum).join('');
}

function score(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 3) {
    throw new TypeError(`${name} must be an integer between 0 and 3`);
  }
  return number;
}

export function shouldRunQualityRepair({
  initialScore,
  currentScore,
  previousScore = null,
  attempts,
  settings,
}) {
  const normalized = normalizeProductionSettings(settings);
  const initial = score(initialScore, 'initialScore');
  const current = score(currentScore, 'currentScore');
  const previous = previousScore === null ? null : score(previousScore, 'previousScore');
  if (!Number.isInteger(attempts) || attempts < 0) throw new TypeError('attempts must be a non-negative integer');
  return normalized.qualityRepairEnabled
    && initial === normalized.qualityRepairTriggerScore
    && current < normalized.qualityRepairTargetScore
    && (previous === null || current > previous)
    && attempts < normalized.qualityRepairMaxAttempts;
}

export function shouldRegenerateContentAfterQualityFailure(qc) {
  if (qc?.disposition !== 'blocked') return false;
  if (Array.isArray(qc?.checks) && qc.checks.some((check) =>
    check?.passed === false && CONTENT_BLOCKING_CHECKS.has(check?.id))) return true;
  const dimensions = qc?.rubric?.dimensions;
  if (!dimensions || typeof dimensions !== 'object' || Array.isArray(dimensions)) return false;
  return CONTENT_REGENERATION_DIMENSIONS.some((key) => {
    const dimension = dimensions[key];
    return dimension?.applicable !== false && Number(dimension?.score) <= 1;
  });
}

export function shouldRegenerateWholeImageSetAfterQualityFailure(qc) {
  if (qc?.disposition !== 'blocked') return false;
  if (Array.isArray(qc?.checks) && qc.checks.some((check) =>
    check?.id === 'image_text_alignment' && check?.passed === false)) return false;
  const dimensions = qc?.rubric?.dimensions;
  if (!dimensions || typeof dimensions !== 'object' || Array.isArray(dimensions)) return false;
  return IMAGE_REPAIR_DIMENSIONS.some((key) => {
    const dimension = dimensions[key];
    return dimension?.applicable !== false && Number(dimension?.score) <= 1;
  });
}

export function shouldRefreshResearchAfterQualityFailure(qc, researchSnapshot) {
  return shouldRegenerateContentAfterQualityFailure(qc)
    && researchSnapshot?.status === 'COMPLETED'
    && !String(researchSnapshot?.summary ?? '').trim();
}

function repairEvidence(qc) {
  const rubric = qc?.rubric;
  const dimensions = rubric?.dimensions && typeof rubric.dimensions === 'object'
    ? rubric.dimensions
    : {};
  const issues = Array.isArray(rubric?.issueLabels) ? rubric.issueLabels : [];
  const issueByLabel = new Map(issues.map((issue) => [issue?.label, issue]));
  const obstacleKeys = Array.isArray(rubric?.lowestObstacleDimensions)
    ? rubric.lowestObstacleDimensions
    : [];
  const entries = [];
  const seen = new Set();

  for (const obstacle of obstacleKeys) {
    if (typeof obstacle !== 'string') continue;
    if (obstacle.startsWith('issue:')) {
      const label = obstacle.slice('issue:'.length);
      const issue = issueByLabel.get(label);
      const evidence = boundedText(issue?.evidence || label);
      if (evidence && !seen.has(evidence)) entries.push({ key: label, reason: evidence });
      seen.add(evidence);
      continue;
    }
    const dimension = dimensions[obstacle];
    const evidence = boundedText(Array.isArray(dimension?.evidence) ? dimension.evidence.at(-1) : '');
    if (evidence && !seen.has(evidence)) entries.push({ key: obstacle, reason: evidence });
    seen.add(evidence);
  }
  for (const key of IMAGE_REPAIR_DIMENSIONS) {
    const dimension = dimensions[key];
    if (Number(dimension?.score) > Number(qc?.overallScore)) continue;
    const evidence = boundedText(Array.isArray(dimension?.evidence) ? dimension.evidence.at(-1) : '');
    if (evidence && !seen.has(evidence)) entries.push({ key, reason: evidence });
    seen.add(evidence);
  }
  for (const issue of issues) {
    const evidence = boundedText(issue?.evidence || issue?.label);
    if (evidence && !seen.has(evidence)) entries.push({ key: issue?.label, reason: evidence });
    seen.add(evidence);
  }
  return entries.slice(0, 6);
}

function repairMethod(key) {
  return `根据实际证据修复维度 ${key}，保留无关的正确内容`;
}

export function createQualityRepairPlan({ qc, round, imageCount }) {
  if (!qc || typeof qc !== 'object' || Array.isArray(qc)) throw new TypeError('QC result is required');
  if (!Number.isInteger(round) || round < 1 || round > 2) throw new RangeError('repair round must be 1 or 2');
  if (!Number.isInteger(imageCount) || imageCount < 3 || imageCount > 5) {
    throw new RangeError('repair imageCount must be between 3 and 5');
  }
  const evidence = repairEvidence(qc);
  const reasons = evidence.map(({ reason }) => reason);
  if (reasons.length === 0) reasons.push('整套终审为 1 分，但终审未返回可定位的独立证据。');
  const methods = [...new Set(evidence.map(({ key }) => repairMethod(String(key ?? ''))))].slice(0, 6);
  if (methods.length === 0) methods.push(repairMethod(''));
  return {
    round,
    scoreBefore: score(qc.overallScore, 'qc.overallScore'),
    imageCount,
    affectedPages: Array.from({ length: imageCount }, (_, index) => index + 1),
    reasons,
    methods,
  };
}

export function appendQualityRepairPrompt(basePrompt, plan, { pageIndex }) {
  if (typeof basePrompt !== 'string' || !basePrompt.trim()) throw new TypeError('base image prompt is required');
  if (!Number.isInteger(pageIndex) || pageIndex < 1 || pageIndex > plan?.imageCount) throw new RangeError('repair pageIndex is outside the image set');
  const suffix = businessPrompt('IMAGE_REPAIR_SYSTEM', {
    contract: '保留原事实、allowedVisibleText 和页归属。仅修复本页实际问题，不能按页码指定新的内容职责。',
    data: { pageIndex, imageCount: plan.imageCount, round: plan.round, scoreBefore: plan.scoreBefore,
      reasons: plan.reasons, methods: plan.methods },
  });
  const prompt = `${basePrompt}\n\n${suffix}`;
  if (Buffer.byteLength(prompt, 'utf8') > 200_000) throw new RangeError('图片修复提示词超出限制，未截断或发送');
  return prompt;
}
