const AUTH_FAILURE = /\b401\b|token[_ -]?invalidated|invalid[_ -]?token|authentication (?:failed|unavailable|required)|oauth[^\n]{0,80}(?:expired|invalid|unavailable)|login required|not authenticated|unauthorized/iu;
const TRANSIENT_FAILURE = /\b(?:ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|UND_ERR_SOCKET|429)\b|fetch failed|connection error|other side closed|socket hang up|timed? out|server_is_overloaded|service_unavailable|temporar(?:y|ily) unavailable|temporary (?:transport|network|image|model).*?(?:failure|outage)|model service[^\n]{0,80}unavailable|rate limit/iu;
const QUALITY_FAILURE = /质量门禁未通过|(?:三|3)分(?:质量门禁|终审).*未通过|quality gate.*(?:blocked|failed)|final review.*(?:blocked|failed)/iu;
const STRUCTURE_FAILURE = /结构校验|结构化输出|invalid json|valid json|returned an invalid result|正文输出未通过|visual(?: |-)?plan[^\n]{0,80}(?:invalid|failed)|layout contract|must contain/iu;
const CONFIGURATION_FAILURE = /unknown model|legacy provider|tool choice|image_generation[^\n]{0,80}(?:unsupported|unavailable|invalid)|missing config|configuration (?:invalid|error)|prompt version[^\n]{0,80}(?:missing|invalid)/iu;

const RECOVERY_RULES = Object.freeze({
  TRANSIENT: Object.freeze({ delaysMs: [15_000, 60_000] }),
  QUALITY: Object.freeze({ delaysMs: [0] }),
  STRUCTURE: Object.freeze({ delaysMs: [5_000] }),
});

const MAX_TOTAL_RECOVERIES = 4;

function failureText(error) {
  return error instanceof Error ? error.message : String(error ?? '');
}

function nonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return value;
}

export function classifyTaskFailure(error) {
  const text = failureText(error);
  if (AUTH_FAILURE.test(text)) return 'AUTH';
  if (TRANSIENT_FAILURE.test(text)) return 'TRANSIENT';
  if (QUALITY_FAILURE.test(text)) return 'QUALITY';
  if (STRUCTURE_FAILURE.test(text)) return 'STRUCTURE';
  if (CONFIGURATION_FAILURE.test(text)) return 'CONFIGURATION';
  return 'UNKNOWN';
}

export function planTaskRecovery({
  error,
  recoveryAttempts = 0,
  recoveryTotalAttempts = 0,
}) {
  const classAttempts = nonNegativeInteger(recoveryAttempts, 'recoveryAttempts');
  const totalAttempts = nonNegativeInteger(recoveryTotalAttempts, 'recoveryTotalAttempts');
  const failureClass = classifyTaskFailure(error);

  if (failureClass === 'AUTH') {
    return {
      failureClass,
      action: 'MANUAL',
      delayMs: null,
      manualRequired: true,
      haltWorker: true,
      reason: 'authentication_required',
    };
  }
  if (totalAttempts >= MAX_TOTAL_RECOVERIES) {
    return {
      failureClass,
      action: 'MANUAL',
      delayMs: null,
      manualRequired: true,
      haltWorker: false,
      reason: 'overall_retry_limit_reached',
    };
  }

  const rule = RECOVERY_RULES[failureClass];
  if (rule && classAttempts < rule.delaysMs.length) {
    return {
      failureClass,
      action: 'RETRY',
      delayMs: rule.delaysMs[classAttempts],
      manualRequired: false,
      haltWorker: false,
      reason: `${failureClass.toLowerCase()}_failure`,
    };
  }
  if (rule) {
    return {
      failureClass,
      action: 'MANUAL',
      delayMs: null,
      manualRequired: true,
      haltWorker: false,
      reason: 'class_retry_limit_reached',
    };
  }
  return {
    failureClass,
    action: 'MANUAL',
    delayMs: null,
    manualRequired: true,
    haltWorker: false,
    reason: failureClass === 'CONFIGURATION'
      ? 'configuration_requires_fix'
      : 'unclassified_failure',
  };
}

export { MAX_TOTAL_RECOVERIES, RECOVERY_RULES };
