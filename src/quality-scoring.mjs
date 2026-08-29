export const QUALITY_SCORING_RULE_ID = 'production-v2';

const LAYERS = {
  satisfaction: ['queryRelevance', 'contentOriginality'],
  usability: [
    'imageBaseQuality',
    'imageTextQuality',
    'imageConsistency',
    'noteTone',
    'platformAdaptation',
  ],
  quality: ['informationValue', 'imageAesthetics', 'imageDiversity'],
};

const DIMENSION_NAMES = Object.values(LAYERS).flat();
const DIMENSION_NAME_SET = new Set(DIMENSION_NAMES);
const EVIDENCE_SOURCES = new Set(['mechanical', 'vlm', 'human', 'hybrid']);
const ISSUE_SEVERITIES = new Set(['minor', 'major', 'redline']);
const PLATFORM_EVIDENCE_LEVELS = new Set([
  'sufficient',
  'limited',
  'missing',
  'unverified',
  'direct_review',
  'not_applicable',
]);

function requiredText(value, name, maxLength = 2_000) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new RangeError(`${name} is too long`);
  return normalized;
}

function normalizeEvidence(value, name) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new TypeError(`${name} must contain between 1 and 20 evidence strings`);
  }
  return value.map((item, index) => requiredText(item, `${name}[${index}]`));
}

function normalizeDimension(name, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} assessment must be an object`);
  }
  const applicable = value.applicable !== false;
  const source = requiredText(value.source, `${name}.source`, 30);
  if (!EVIDENCE_SOURCES.has(source)) throw new TypeError(`${name}.source is invalid`);
  const evidence = normalizeEvidence(value.evidence, `${name}.evidence`);
  if (!applicable) {
    if (name !== 'platformAdaptation') {
      throw new TypeError(`${name} cannot be not applicable`);
    }
    if (value.score !== null && value.score !== undefined) {
      throw new TypeError(`${name}.score must be null when the dimension is not applicable`);
    }
    return {
      initialScore: null,
      score: null,
      evidence,
      source,
      applicable: false,
    };
  }
  if (!Number.isInteger(value.score) || value.score < 0 || value.score > 3) {
    throw new TypeError(`${name}.score must be an integer between 0 and 3`);
  }
  return {
    initialScore: value.score,
    score: value.score,
    evidence,
    source,
    applicable: true,
  };
}

export function normalizeQualityDimensionAssessment(name, value) {
  if (!DIMENSION_NAME_SET.has(name)) throw new TypeError(`unknown dimension: ${name}`);
  return normalizeDimension(name, value);
}

function normalizeDimensions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('dimensions must be an object');
  }
  const unknown = Object.keys(value).find((name) => !DIMENSION_NAME_SET.has(name));
  if (unknown) throw new TypeError(`unknown dimension: ${unknown}`);
  const dimensions = {};
  const missingDimensions = [];
  for (const name of DIMENSION_NAMES) {
    if (!(name in value)) {
      missingDimensions.push(name);
      continue;
    }
    dimensions[name] = normalizeQualityDimensionAssessment(name, value[name]);
  }
  return { dimensions, missingDimensions };
}

function normalizeIssueLabels(value = []) {
  if (!Array.isArray(value) || value.length > 50) throw new TypeError('issueLabels must be an array');
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new TypeError(`issueLabels[${index}] must be an object`);
    }
    const severity = requiredText(item.severity, `issueLabels[${index}].severity`, 20);
    if (!ISSUE_SEVERITIES.has(severity)) {
      throw new TypeError(`issueLabels[${index}].severity is invalid`);
    }
    return {
      severity,
      label: requiredText(item.label, `issueLabels[${index}].label`, 100),
      evidence: requiredText(item.evidence, `issueLabels[${index}].evidence`),
    };
  });
}

function normalizeAdjustments(value = [], dimensions) {
  if (!Array.isArray(value) || value.length > DIMENSION_NAMES.length) {
    throw new TypeError('typeAdjustments must be an array');
  }
  const seen = new Set();
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new TypeError(`typeAdjustments[${index}] must be an object`);
    }
    const dimension = requiredText(item.dimension, `typeAdjustments[${index}].dimension`, 100);
    if (!DIMENSION_NAME_SET.has(dimension)) throw new TypeError(`unknown dimension: ${dimension}`);
    if (seen.has(dimension)) throw new TypeError(`duplicate adjustment for ${dimension}`);
    seen.add(dimension);
    if (item.delta !== 0.5 && item.delta !== -0.5) {
      throw new TypeError(`typeAdjustments[${index}].delta must be 0.5 or -0.5`);
    }
    if (!dimensions[dimension]) {
      throw new TypeError(`type adjustment requires an assessment for ${dimension}`);
    }
    return {
      dimension,
      delta: item.delta,
      reason: requiredText(item.reason, `typeAdjustments[${index}].reason`),
    };
  });
}

function applyAdjustments(dimensions, adjustments) {
  for (const adjustment of adjustments) {
    const target = dimensions[adjustment.dimension];
    let score = target.score;
    if (target.applicable && score === 2 && adjustment.delta === 0.5) score = 3;
    if (target.applicable && score === 3 && adjustment.delta === -0.5) score = 2;
    target.score = score;
    target.adjustment = {
      delta: adjustment.delta,
      reason: adjustment.reason,
      applied: score !== target.initialScore,
    };
  }
}

function capPlatformDimension(dimensions, targetPlatform, platformSampleEvidence) {
  const platform = dimensions.platformAdaptation;
  if (!targetPlatform) {
    if (platform && platform.applicable) {
      throw new TypeError('platformAdaptation must be not applicable when targetPlatform is absent');
    }
    return;
  }
  if (!platform || !platform.applicable) {
    throw new TypeError('platformAdaptation must be applicable when targetPlatform is specified');
  }
  if (['limited', 'missing', 'unverified'].includes(platformSampleEvidence) && platform.score > 2) {
    platform.score = 2;
    platform.cap = 'platform_samples_missing';
  }
}

function applicableScores(dimensions, names) {
  return names
    .map((name) => ({ name, assessment: dimensions[name] }))
    .filter(({ assessment }) => assessment?.applicable);
}

function layerMinimum(dimensions, names) {
  const scores = applicableScores(dimensions, names);
  if (scores.length === 0) return null;
  return Math.min(...scores.map(({ assessment }) => assessment.score));
}

function namesAtScore(dimensions, names, score) {
  return applicableScores(dimensions, names)
    .filter(({ assessment }) => assessment.score === score)
    .map(({ name }) => name);
}

function resultBase({ dimensions, issueLabels, adjustments, missingDimensions, targetPlatform, platformSampleEvidence }) {
  return {
    ruleId: QUALITY_SCORING_RULE_ID,
    finalScore: null,
    action: 'supplement_evidence',
    stoppedAt: 'evidence',
    layerScores: { satisfaction: null, usability: null, quality: null },
    dimensions,
    issueLabels,
    typeAdjustments: adjustments,
    targetPlatform,
    platformSampleEvidence,
    lowestObstacleDimensions: [],
    missingDimensions,
  };
}

export function scoreQualityAssessment(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('quality assessment must be an object');
  }
  const { dimensions, missingDimensions } = normalizeDimensions(input.dimensions);
  const issueLabels = normalizeIssueLabels(input.issueLabels);
  const adjustments = normalizeAdjustments(input.typeAdjustments, dimensions);
  const targetPlatform = input.targetPlatform === null || input.targetPlatform === undefined
    ? null
    : requiredText(input.targetPlatform, 'targetPlatform', 100);
  const platformSampleEvidence = requiredText(
    input.platformSampleEvidence,
    'platformSampleEvidence',
    30,
  );
  if (!PLATFORM_EVIDENCE_LEVELS.has(platformSampleEvidence)) {
    throw new TypeError('platformSampleEvidence is invalid');
  }
  if (!targetPlatform && platformSampleEvidence !== 'not_applicable') {
    throw new TypeError('platformSampleEvidence must be not_applicable without a target platform');
  }
  if (targetPlatform && platformSampleEvidence === 'not_applicable') {
    throw new TypeError('platformSampleEvidence cannot be not_applicable with a target platform');
  }

  applyAdjustments(dimensions, adjustments);
  capPlatformDimension(dimensions, targetPlatform, platformSampleEvidence);
  const result = resultBase({
    dimensions,
    issueLabels,
    adjustments,
    missingDimensions,
    targetPlatform,
    platformSampleEvidence,
  });

  const redlineLabels = issueLabels.filter(({ severity }) => severity === 'redline');
  const redlineDimensions = DIMENSION_NAMES.filter((name) => dimensions[name]?.applicable
    && dimensions[name].score === 0);
  if (redlineLabels.length > 0 || redlineDimensions.length > 0) {
    return {
      ...result,
      finalScore: 0,
      action: 'redline_block',
      stoppedAt: 'redline',
      lowestObstacleDimensions: [
        ...redlineDimensions,
        ...redlineLabels.map(({ label }) => `issue:${label}`),
      ],
    };
  }

  const majorLabels = issueLabels.filter(({ severity }) => severity === 'major');
  if (majorLabels.length > 0) {
    return {
      ...result,
      finalScore: 1,
      action: 'return_for_revision',
      stoppedAt: 'issue',
      lowestObstacleDimensions: majorLabels.map(({ label }) => `issue:${label}`),
    };
  }

  const satisfaction = layerMinimum(dimensions, LAYERS.satisfaction);
  result.layerScores.satisfaction = satisfaction;
  if (satisfaction === 1) {
    return {
      ...result,
      finalScore: 1,
      action: 'return_for_revision',
      stoppedAt: 'satisfaction',
      lowestObstacleDimensions: namesAtScore(dimensions, LAYERS.satisfaction, 1),
    };
  }
  const missingSatisfaction = LAYERS.satisfaction.filter((name) => !dimensions[name]);
  if (missingSatisfaction.length > 0) return result;

  const usability = layerMinimum(dimensions, LAYERS.usability);
  result.layerScores.usability = usability;
  if (usability === 1) {
    return {
      ...result,
      finalScore: 1,
      action: 'return_for_revision',
      stoppedAt: 'usability',
      lowestObstacleDimensions: namesAtScore(dimensions, LAYERS.usability, 1),
    };
  }
  const missingUsability = LAYERS.usability.filter((name) => !dimensions[name]);
  if (missingUsability.length > 0) return result;

  const quality = layerMinimum(dimensions, LAYERS.quality);
  result.layerScores.quality = quality;
  if (quality === 1) {
    return {
      ...result,
      finalScore: 1,
      action: 'return_for_revision',
      stoppedAt: 'quality',
      lowestObstacleDimensions: namesAtScore(dimensions, LAYERS.quality, 1),
    };
  }
  const missingQuality = LAYERS.quality.filter((name) => !dimensions[name]);
  if (missingQuality.length > 0) return result;

  const minorLabels = issueLabels.filter(({ severity }) => severity === 'minor');
  const scoreTwoDimensions = DIMENSION_NAMES.filter((name) => dimensions[name]?.applicable
    && dimensions[name].score === 2);
  if (scoreTwoDimensions.length > 0 || minorLabels.length > 0) {
    return {
      ...result,
      finalScore: 2,
      action: 'normal_review',
      stoppedAt: 'complete',
      lowestObstacleDimensions: [
        ...scoreTwoDimensions,
        ...minorLabels.map(({ label }) => `issue:${label}`),
      ],
    };
  }

  return {
    ...result,
    finalScore: 3,
    action: 'priority_review',
    stoppedAt: 'complete',
    lowestObstacleDimensions: [],
  };
}
