export const DEFAULT_PRODUCTION_SETTINGS = Object.freeze({
  qualityRepairEnabled: true,
  qualityRepairTriggerScore: 1,
  qualityRepairTargetScore: 2,
  qualityRepairMaxAttempts: 2,
  aiDisclosureEnabled: true,
  aiDisclosureText: 'AI生成',
});

function booleanSetting(value, fallback, name) {
  const resolved = value ?? fallback;
  if (typeof resolved !== 'boolean') throw new TypeError(`${name} must be a boolean`);
  return resolved;
}

function integerSetting(value, fallback, name, minimum, maximum) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return resolved;
}

function textSetting(value, fallback, name, maximum) {
  const resolved = value ?? fallback;
  if (typeof resolved !== 'string' || resolved.trim() === '') {
    throw new TypeError(`${name} cannot be empty`);
  }
  const text = resolved.trim();
  if ([...text].length > maximum) throw new RangeError(`${name} cannot exceed ${maximum} characters`);
  if (!/^[\p{L}\p{N}_-]+$/u.test(text)) {
    throw new TypeError(`${name} can contain only letters, numbers, underscores, or hyphens`);
  }
  return text;
}

export function normalizeProductionSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('production settings must be an object');
  }
  const settings = {
    qualityRepairEnabled: booleanSetting(
      input.qualityRepairEnabled,
      DEFAULT_PRODUCTION_SETTINGS.qualityRepairEnabled,
      'qualityRepairEnabled',
    ),
    qualityRepairTriggerScore: integerSetting(
      input.qualityRepairTriggerScore,
      DEFAULT_PRODUCTION_SETTINGS.qualityRepairTriggerScore,
      'qualityRepairTriggerScore',
      0,
      2,
    ),
    qualityRepairTargetScore: integerSetting(
      input.qualityRepairTargetScore,
      DEFAULT_PRODUCTION_SETTINGS.qualityRepairTargetScore,
      'qualityRepairTargetScore',
      1,
      3,
    ),
    qualityRepairMaxAttempts: integerSetting(
      input.qualityRepairMaxAttempts,
      DEFAULT_PRODUCTION_SETTINGS.qualityRepairMaxAttempts,
      'qualityRepairMaxAttempts',
      0,
      2,
    ),
    aiDisclosureEnabled: booleanSetting(
      input.aiDisclosureEnabled,
      DEFAULT_PRODUCTION_SETTINGS.aiDisclosureEnabled,
      'aiDisclosureEnabled',
    ),
    aiDisclosureText: textSetting(
      input.aiDisclosureText,
      DEFAULT_PRODUCTION_SETTINGS.aiDisclosureText,
      'aiDisclosureText',
      12,
    ),
  };
  if (settings.qualityRepairTargetScore <= settings.qualityRepairTriggerScore) {
    throw new RangeError('quality repair target score must be greater than trigger score');
  }
  return settings;
}

export function productionDisclosure(settings) {
  const normalized = normalizeProductionSettings(settings);
  return normalized.aiDisclosureEnabled ? normalized.aiDisclosureText : '';
}
