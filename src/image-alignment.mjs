import { businessPrompt, promptPolicy, promptRuntimeSnapshot } from './prompt-runtime.mjs';

const FAILURE_CLASSES = new Set([
  'PASS',
  'MINOR_TEXT',
  'SEMANTIC',
  'EXTRA_FACT',
  'STYLE_LAYOUT',
  'OCR_MISMATCH',
  'OCR_UNCERTAIN',
]);
const MIN_OCR_CONFIDENCE = 0.9;
const MAX_ALIGNMENT_RESPONSE_ATTEMPTS = 3;
const PORTRAIT_PATTERN = /(?:人像|人物|真人|模特|肖像|半身|全身|面部|人物操作|人物示范)/u;
const PORTRAIT_EXCLUSION_PATTERN = /(?:无人物|无人像|不含人物|不出现人物|禁止人物|不要人物|没有人物)/u;
const REQUIRED_TEXT_CONTEXT_PATTERN = /(?:allowedVisibleText|白名单|任务(?:要求|预期)文字|业务文案|关键文字|主标题|副标题|标题|要点|项目符号|正文|步骤|清单|标签|合规标识|headline|subtitle|bullet|label)/iu;
const INCIDENTAL_UNREADABLE_TEXT_PATTERNS = [
  /^(?:背景|远景)(?:书架)?书脊(?:上|处)的?(?:微小|细小|极小)(?:的)?(?:装饰字|装饰文字|装饰性文字)(?:无法辨认|看不清|不可读|模糊不清)[。.]?$/u,
  /^(?:显示器|屏幕|设备)(?:边框|外壳)(?:上|处)的?(?:微小|细小|极小)(?:的)?(?:装饰字|装饰文字|装饰性文字)(?:无法辨认|看不清|不可读|模糊不清)[。.]?$/u,
  /^(?:背景|远景)(?:墙面|道具|摆件|书本)(?:边缘|角落|纹理)(?:上|处)?的?(?:微小|细小|极小)(?:的)?(?:装饰字|装饰文字|装饰性文字)(?:无法辨认|看不清|不可读|模糊不清)[。.]?$/u,
];
const CELSIUS_EQUIVALENCE_METHOD = 'U+2103_EQUIVALENT_TO_U+00B0_LATIN_CAPITAL_C';
const CELSIUS_FORM_PATTERN = /(?:℃|°C)/u;
const CELSIUS_DESCRIPTION_SOURCE = '(?:温度单位写法|温度单位符号|温度符号写法|温度标注写法|摄氏度单位|摄氏度符号|摄氏度写法|摄氏单位符号)';
const CELSIUS_DIFFERENCE_SOURCE = '(?:写法不同|写法不一致|符号不同|符号不一致|不同|不一致|存在差异|有差异|差异|等价写法|等价|相同|一致|无需修改|不应报错)';

export class ImageAlignmentResponseError extends SyntaxError {
  constructor(cause, responseAttempts = MAX_ALIGNMENT_RESPONSE_ATTEMPTS) {
    super('image alignment model repeatedly returned an invalid response', { cause });
    this.name = 'ImageAlignmentResponseError';
    this.code = 'ALIGNMENT_RESPONSE_INVALID';
    this.retryable = true;
    this.responseAttempts = responseAttempts;
  }
}

export class ImageAlignmentServiceError extends Error {
  constructor(cause) {
    super('image alignment service failed before returning a response', { cause });
    this.name = 'ImageAlignmentServiceError';
    this.code = 'ALIGNMENT_SERVICE_FAILED';
    this.retryable = true;
  }
}

export function imagePageUsesPortrait(page, extraDirection = '') {
  const description = [
    page?.visualSubject,
    page?.layoutDirection,
    ...(Array.isArray(page?.mustShow) ? page.mustShow : []),
    extraDirection,
  ].filter((value) => typeof value === 'string' && value.trim()).join('\n');
  return !PORTRAIT_EXCLUSION_PATTERN.test(description) && PORTRAIT_PATTERN.test(description);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(value, name, { min = 1, max = 1_000 } = {}) {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  const text = value.trim();
  if ([...text].length < min) throw new RangeError(`${name} cannot be empty`);
  if ([...text].length > max) throw new RangeError(`${name} cannot exceed ${max} characters`);
  return text;
}

function textList(value, name) {
  if (!Array.isArray(value) || value.length > 10) {
    throw new TypeError(`${name} must be an array of at most 10 items`);
  }
  return value.map((item, index) => requiredText(item, `${name}[${index}]`, { max: 300 }));
}

function ocrText(value, name, max = 200) {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  const text = promptRuntimeSnapshot() ? value : value.trim();
  if ([...text].length > max) throw new RangeError(`${name} cannot exceed ${max} characters`);
  return text;
}

function ocrTextList(value, name) {
  if (!Array.isArray(value) || value.length > 10) {
    throw new TypeError(`${name} must be an array of at most 10 items`);
  }
  return value.map((item, index) => ocrText(item, `${name}[${index}]`));
}

function ocrOtherTextList(value, name) {
  if (!Array.isArray(value) || value.length > 30) {
    throw new TypeError(`${name} must be an array of at most 30 items`);
  }
  return value.map((item, index) => ocrText(item, `${name}[${index}]`, 300));
}

function normalizeOcrTextWithoutCelsius(value) {
  if (promptRuntimeSnapshot() && promptPolicy().ocrComparison === 'LINE_BREAKS_ONLY') {
    return String(value ?? '').replace(/[\r\n]/gu, '');
  }
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[“”‘’"']/gu, '')
    .replace(/\s+/gu, '');
}

function normalizeCelsiusNotation(value) {
  return value.replace(/\u2103/gu, '°C');
}

function normalizeOcrText(value) {
  return normalizeCelsiusNotation(normalizeOcrTextWithoutCelsius(value));
}

function isCelsiusRepresentationPair(left, right) {
  const rawLeft = normalizeOcrTextWithoutCelsius(left);
  const rawRight = normalizeOcrTextWithoutCelsius(right);
  return rawLeft !== rawRight
    && CELSIUS_FORM_PATTERN.test(rawLeft)
    && CELSIUS_FORM_PATTERN.test(rawRight)
    && normalizeCelsiusNotation(rawLeft) === normalizeCelsiusNotation(rawRight);
}

function boundedAuditText(value) {
  return [...String(value ?? '')].slice(0, 300).join('');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function quotedExactPattern(values) {
  const source = [...new Set(values)].sort((left, right) => right.length - left.length)
    .map(escapeRegExp).join('|');
  return `(?:${source}|“(?:${source})”|‘(?:${source})’|"(?:${source})"|'(?:${source})')`;
}

function celsiusApplicationValues(applications, key) {
  const values = [];
  for (const application of applications) {
    const value = application[key];
    values.push(value);
    values.push(...(String(value).match(/[+-−－]?\d+(?:\.\d+)?(?:℃|°C)/gu) ?? []));
    values.push(String(value).includes('℃') ? '℃' : '°C');
  }
  return values;
}

function celsiusEquivalenceApplications(recognizedText, allowedVisibleText) {
  const applications = [];
  const addPair = (field, recognized, allowed, index = null) => {
    if (!isCelsiusRepresentationPair(recognized, allowed) || applications.length >= 10) return;
    applications.push({
      field,
      ...(index === null ? {} : { index }),
      recognized: boundedAuditText(recognized),
      allowed: boundedAuditText(allowed),
    });
  };
  addPair('headline', recognizedText.headline, allowedVisibleText.headline);
  addPair('subtitle', recognizedText.subtitle, allowedVisibleText.subtitle);
  for (const [field, recognizedValues, allowedValues] of [
    ['bullets', recognizedText.bullets, allowedVisibleText.bullets],
    ['otherText', recognizedText.otherText, allowedVisibleText.labels ?? []],
  ]) {
    const remaining = [...allowedValues];
    for (const [recognizedIndex, recognized] of recognizedValues.entries()) {
      const index = remaining.findIndex((allowed) =>
        normalizeOcrText(recognized) === normalizeOcrText(allowed));
      if (index < 0) continue;
      addPair(field, recognized, remaining[index], recognizedIndex);
      remaining.splice(index, 1);
    }
  }
  return applications;
}

function isCelsiusNotationOnlyMessage(value, applications) {
  const text = String(value ?? '').trim();
  if (!text || !text.includes('℃') || !text.includes('°C') || applications.length === 0) return false;
  const recognized = quotedExactPattern(celsiusApplicationValues(applications, 'recognized'));
  const allowed = quotedExactPattern(celsiusApplicationValues(applications, 'allowed'));
  const difference = new RegExp(`^(?:仅|只)?${CELSIUS_DESCRIPTION_SOURCE}${CELSIUS_DIFFERENCE_SOURCE}$`, 'u');
  const observed = new RegExp(`^(?:图片文字为|图片为|画面文字为|画面为|实际显示为|显示为|识别为|OCR识别为)${recognized}$`, 'u');
  const required = new RegExp(`^(?:allowedVisibleText要求|白名单要求|白名单为|要求为|要求|应为|原文为|正确文字为)${allowed}$`, 'u');
  const pair = new RegExp(`^${recognized}(?:与|和|而非)${allowed}$`, 'u');
  const repair = new RegExp(`^(?:请)?(?:将|把)?(?:${CELSIUS_DESCRIPTION_SOURCE})?(?:从)?${recognized}(?:改为|改成|替换为|替换成|调整为|统一为)${allowed}$`, 'u');
  const compact = text.replace(/[\s　]/gu, '').replace(/[。.]$/u, '');
  if (repair.test(compact)) return true;
  const clauses = compact.split(/[：:，,；;]/u).filter(Boolean);
  let differences = 0;
  let observedValues = 0;
  let requiredValues = 0;
  let pairedValues = 0;
  for (const clause of clauses) {
    if (difference.test(clause)) differences += 1;
    else if (observed.test(clause)) observedValues += 1;
    else if (required.test(clause)) requiredValues += 1;
    else if (pair.test(clause)) pairedValues += 1;
    else return false;
  }
  return differences === 1
    && ((observedValues >= 1 && requiredValues >= 1) || pairedValues >= 1)
    && observedValues + requiredValues + pairedValues + differences === clauses.length;
}

function isQuoteVariantOnlyError(value) {
  return /单双引号|单引号|双引号|引号样式|引号[^。；]*(?:不同|不一致|差异)/u.test(value);
}

function isSelfContradictoryExactMatchError(value) {
  const quoted = [...String(value).matchAll(/“([^”]+)”|‘([^’]+)’|"([^"]+)"|'([^']+)'/gu)]
    .map((match) => match.slice(1).find((item) => item !== undefined));
  return quoted.length >= 2
    && /(?:图片文字为|实际(?:显示)?为|显示为)/u.test(value)
    && /(?:allowedVisibleText要求|要求|应为|正确文字)/u.test(value)
    && normalizeOcrText(quoted[0]) === normalizeOcrText(quoted[1]);
}

function validateRecognizedText(value) {
  if (!isRecord(value)) throw new TypeError('recognizedText must be an object');
  return {
    headline: ocrText(value.headline, 'recognizedText.headline', 100),
    subtitle: ocrText(value.subtitle, 'recognizedText.subtitle', 100),
    bullets: ocrTextList(value.bullets, 'recognizedText.bullets'),
    otherText: ocrOtherTextList(value.otherText, 'recognizedText.otherText'),
  };
}

function clearlyIncidentalUnreadableText(value, allowedVisibleText) {
  if (REQUIRED_TEXT_CONTEXT_PATTERN.test(value)) return false;
  const normalized = normalizeOcrText(value);
  const expectedText = [
    allowedVisibleText.headline,
    allowedVisibleText.subtitle,
    ...allowedVisibleText.bullets,
    ...(allowedVisibleText.labels ?? []),
  ].map(normalizeOcrText).filter(Boolean);
  if (expectedText.some((item) => normalized.includes(item))) return false;
  return INCIDENTAL_UNREADABLE_TEXT_PATTERNS.some((pattern) => pattern.test(value));
}

function compareRecognizedText(recognizedText, allowedVisibleText, {
  unreadableText,
  hasTraditionalChinese,
  ocrConfidence,
}) {
  if (!isRecord(allowedVisibleText) || allowedVisibleText.language !== 'zh-CN'
    || !Array.isArray(allowedVisibleText.bullets)) {
    throw new TypeError('allowedVisibleText with zh-CN language is required for OCR comparison');
  }
  const mismatches = [];
  if (normalizeOcrText(recognizedText.headline) !== normalizeOcrText(allowedVisibleText.headline)) {
    mismatches.push('headline');
  }
  if (normalizeOcrText(recognizedText.subtitle) !== normalizeOcrText(allowedVisibleText.subtitle)) {
    mismatches.push('subtitle');
  }
  if (!compareTextMultiset(recognizedText.bullets, allowedVisibleText.bullets).passed) {
    mismatches.push('bullets');
  }
  if (!compareTextMultiset(recognizedText.otherText, allowedVisibleText.labels ?? []).passed) {
    mismatches.push('otherText');
  }
  if (unreadableText.length > 0) mismatches.push('unreadableText');
  if (hasTraditionalChinese) mismatches.push('traditionalChinese');
  if (ocrConfidence < (promptRuntimeSnapshot() ? promptPolicy().ocrMinimumConfidence : MIN_OCR_CONFIDENCE)) mismatches.push('confidence');
  return mismatches;
}

function boundedRepairItems(values, { maxItems = 10, maxLength = 80 } = {}) {
  return values.slice(0, maxItems).map((value) =>
    [...String(value).trim()].slice(0, maxLength).join(''));
}

function compareTextMultiset(recognizedValues, allowedValues) {
  const recognizedNormalized = recognizedValues.map(normalizeOcrText);
  const allowedNormalized = allowedValues.map(normalizeOcrText);
  const remainingAllowed = allowedValues.map((value, index) => ({
    value,
    normalized: allowedNormalized[index],
  }));
  const unexpected = [];
  const duplicates = [];
  for (const value of recognizedValues) {
    const normalized = normalizeOcrText(value);
    const remainingIndex = remainingAllowed.findIndex((item) => item.normalized === normalized);
    if (remainingIndex >= 0) remainingAllowed.splice(remainingIndex, 1);
    else if (allowedNormalized.includes(normalized)) duplicates.push(value);
    else unexpected.push(value);
  }
  return {
    passed: unexpected.length === 0 && duplicates.length === 0 && remainingAllowed.length === 0,
    orderMatched: recognizedNormalized.length === allowedNormalized.length
      && recognizedNormalized.every((value, index) => value === allowedNormalized[index]),
    unexpected,
    duplicates,
    missing: remainingAllowed.map((item) => item.value),
  };
}

function buildOcrRepairInstruction(result, allowedVisibleText) {
  const instructions = [];
  if (result.ocrMismatches.includes('otherText')) {
    const allowedLabels = allowedVisibleText.labels ?? [];
    const differences = compareTextMultiset(result.recognizedText.otherText, allowedLabels);
    const unexpected = boundedRepairItems(differences.unexpected, { maxItems: 5 });
    const duplicates = boundedRepairItems(differences.duplicates, { maxItems: 5 });
    const missing = boundedRepairItems(differences.missing, { maxItems: 5 });
    if (unexpected.length > 0) instructions.push(`删除白名单之外的可见文字：${unexpected.join('、')}`);
    if (duplicates.length > 0) instructions.push(`对象标签重复显示，仅保留一次：${duplicates.join('、')}`);
    if (missing.length > 0) instructions.push(`补充缺失的对象标签：${missing.join('、')}`);
  }
  if (result.ocrMismatches.includes('headline')) {
    instructions.push(`标题必须逐字显示为：${allowedVisibleText.headline}`);
  }
  if (result.ocrMismatches.includes('subtitle')) {
    instructions.push(`副标题必须逐字显示为：${allowedVisibleText.subtitle}`);
  }
  if (result.ocrMismatches.includes('bullets')) {
    instructions.push(`要点必须逐条精确显示为：${allowedVisibleText.bullets.join('、')}`);
    instructions.push('禁止添加序号、编号、项目符号或任何前后缀');
  }
  const allowed = boundedRepairItems([
    allowedVisibleText.headline,
    allowedVisibleText.subtitle,
    ...allowedVisibleText.bullets,
    ...(allowedVisibleText.labels ?? []),
  ]);
  instructions.push(`只允许逐字保留：${allowed.join('、')}`);
  if (result.ocrMismatches.includes('unreadableText')) instructions.push('所有白名单文字必须完整清晰可读');
  if (result.ocrMismatches.includes('traditionalChinese')) instructions.push('全部文字改为中国大陆规范简体中文');
  if (result.ocrMismatches.includes('confidence')) instructions.push('提高文字清晰度，避免模糊、缺笔和伪文字');
  return `${instructions.join('；')}。`.slice(0, 1_000);
}

function classifyMechanicalFailure(result) {
  if (!result.ocrExactMatch) {
    return result.ocrMismatches.some((mismatch) =>
      ['unreadableText', 'traditionalChinese', 'confidence'].includes(mismatch))
      ? 'OCR_UNCERTAIN'
      : 'OCR_MISMATCH';
  }
  if (result.extraClaims.length > 0) return 'EXTRA_FACT';
  if (result.textErrors.length > 0) return 'MINOR_TEXT';
  if (!result.styleMatched || !result.layoutMatched) return 'STYLE_LAYOUT';
  return 'SEMANTIC';
}

function buildMechanicalRepairInstruction(result, allowedVisibleText) {
  const instructions = [];
  if (!result.ocrExactMatch) instructions.push(buildOcrRepairInstruction(result, allowedVisibleText));
  if (!result.subjectMatched) instructions.push('重新生成与 visualSubject 一致的主体');
  if (!result.sceneMatched) instructions.push('重新生成与 sourceEvidence 一致的场景');
  if (!result.headlineMatched) instructions.push(`标题必须逐字显示为：${allowedVisibleText.headline}`);
  if (result.bulletCoverage < 0.8) instructions.push('完整呈现 allowedVisibleText 中的要点');
  if (!result.styleMatched) instructions.push('统一当前页与整套图集的风格');
  if (!result.layoutMatched) instructions.push('按 layoutDirection 调整构图与布局');
  if (result.contradictions.length > 0) {
    instructions.push(`删除矛盾内容：${boundedRepairItems(result.contradictions, { maxItems: 3 }).join('、')}`);
  }
  if (result.extraClaims.length > 0) {
    instructions.push(`删除正文外事实：${boundedRepairItems(result.extraClaims, { maxItems: 3 }).join('、')}`);
  }
  if (result.textErrors.length > 0) {
    instructions.push(`修正文字错误：${boundedRepairItems(result.textErrors, { maxItems: 3 }).join('、')}`);
  }
  return `${instructions.join('；') || '修复未通过的机械验收字段'}。`.slice(0, 1_000);
}

function booleanValue(value, name) {
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`);
  return value;
}

function parseObject(raw) {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > 30_000) {
    throw new TypeError('image alignment output must be bounded non-empty text');
  }
  const text = raw.trim();
  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]+?)```/iu);
  if (fenced) candidates.push(fenced[1].trim());
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(text.slice(firstBrace, lastBrace + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Continue to the next bounded candidate.
    }
  }
  throw new SyntaxError('image alignment output does not contain a valid JSON object');
}

export function buildImageAlignmentPrompt({ post, visualPage, pageIndex, imageCount }) {
  if (!isRecord(post) || !isRecord(visualPage)) throw new TypeError('post and visualPage are required');
  if (!Number.isInteger(pageIndex) || pageIndex < 1 || pageIndex > imageCount) throw new RangeError('pageIndex must be within the image set');
  const prompt = businessPrompt('IMAGE_ALIGNMENT_SYSTEM', {
    dataTag: 'untrusted_alignment_contract',
    data: { title: post.title, body: post.body, pageIndex, imageCount, page: visualPage },
    contract: '只返回 JSON：schemaVersion=1；subjectMatched、sceneMatched、headlineMatched、styleMatched、layoutMatched 为布尔值；bulletCoverage 为 0～1；contradictions、extraClaims、textErrors 为字符串数组；recognizedText 包含 headline、subtitle、bullets、otherText，其中 bullets 按画面自然读取顺序逐项抄录，程序以无序多重集合核对白名单完整性，逻辑或布局顺序错误由 layoutMatched、contradictions 和 failureClass 报告；unreadableText 只列 allowedVisibleText 或合规标识中不可读的任务预期文字，不要列背景书脊、屏幕边框等非预期装饰字；hasTraditionalChinese 为布尔值；ocrConfidence 为 0～1；failureClass 为 PASS、MINOR_TEXT、SEMANTIC、EXTRA_FACT、STYLE_LAYOUT、OCR_MISMATCH、OCR_UNCERTAIN；repairInstruction 为字符串，通过时为空，失败时 5～1000 字。程序按当前 OCR 比较配置校验，模型原始结论完整保留。',
  });
  return prompt.replace(
    '；hasTraditionalChinese 为布尔值；',
    '；温度标注中连续的 ℃ 与 °C 是等价写法，不得仅因两者差异报错；hasTraditionalChinese 为布尔值；',
  );
}
export function parseImageAlignmentOutput(raw, { allowedVisibleText } = {}) {
  const root = parseObject(raw);
  if (root.schemaVersion !== 1) throw new TypeError('image alignment schemaVersion must be 1');
  const bulletCoverage = Number(root.bulletCoverage);
  if (!Number.isFinite(bulletCoverage) || bulletCoverage < 0 || bulletCoverage > 1) {
    throw new RangeError('image alignment bulletCoverage must be between 0 and 1');
  }
  const modelFailureClass = requiredText(root.failureClass, 'failureClass', { max: 50 });
  if (!FAILURE_CLASSES.has(modelFailureClass)) throw new TypeError('image alignment failureClass is invalid');
  const recognizedText = validateRecognizedText(root.recognizedText);
  const unreadableText = textList(root.unreadableText, 'unreadableText');
  const hasTraditionalChinese = booleanValue(root.hasTraditionalChinese, 'hasTraditionalChinese');
  const ocrConfidence = Number(root.ocrConfidence);
  if (!Number.isFinite(ocrConfidence) || ocrConfidence < 0 || ocrConfidence > 1) {
    throw new RangeError('image alignment ocrConfidence must be between 0 and 1');
  }
  const otherOcrMismatches = compareRecognizedText(recognizedText, allowedVisibleText, {
    unreadableText: [],
    hasTraditionalChinese,
    ocrConfidence,
  });
  const ignoredUnreadableText = modelFailureClass === 'PASS' && otherOcrMismatches.length === 0
    ? unreadableText.filter((value) => clearlyIncidentalUnreadableText(value, allowedVisibleText))
    : [];
  const relevantUnreadableText = unreadableText.filter((value) => !ignoredUnreadableText.includes(value));
  const bulletComparison = compareTextMultiset(recognizedText.bullets, allowedVisibleText.bullets);
  const ocrMismatches = compareRecognizedText(recognizedText, allowedVisibleText, {
    unreadableText: relevantUnreadableText,
    hasTraditionalChinese,
    ocrConfidence,
  });
  const celsiusApplications = celsiusEquivalenceApplications(recognizedText, allowedVisibleText);
  const rawTextErrors = textList(root.textErrors, 'textErrors');
  const ignoredCelsiusTextErrors = celsiusApplications.length > 0 && ocrMismatches.length === 0
    ? rawTextErrors.filter((value) => isCelsiusNotationOnlyMessage(value, celsiusApplications))
    : [];
  const textErrors = rawTextErrors.filter((value) => {
    if (ignoredCelsiusTextErrors.includes(value)) return false;
    return promptRuntimeSnapshot()
      || ocrMismatches.length > 0
      || (!isQuoteVariantOnlyError(value) && !isSelfContradictoryExactMatchError(value));
  });
  const celsiusOnlyModelRejection = promptRuntimeSnapshot()
    && ['MINOR_TEXT', 'OCR_MISMATCH'].includes(modelFailureClass)
    && celsiusApplications.length > 0
    && ocrMismatches.length === 0
    && textErrors.length === 0
    && rawTextErrors.every((value) => isCelsiusNotationOnlyMessage(value, celsiusApplications))
    && isCelsiusNotationOnlyMessage(root.repairInstruction, celsiusApplications);
  const result = {
    schemaVersion: 1,
    subjectMatched: booleanValue(root.subjectMatched, 'subjectMatched'),
    sceneMatched: booleanValue(root.sceneMatched, 'sceneMatched'),
    headlineMatched: booleanValue(root.headlineMatched, 'headlineMatched'),
    bulletCoverage,
    styleMatched: booleanValue(root.styleMatched, 'styleMatched'),
    layoutMatched: booleanValue(root.layoutMatched, 'layoutMatched'),
    contradictions: textList(root.contradictions, 'contradictions'),
    extraClaims: textList(root.extraClaims, 'extraClaims'),
    textErrors,
    recognizedText,
    unreadableText,
    hasTraditionalChinese,
    ocrConfidence,
    ocrMismatches,
    ocrExactMatch: ocrMismatches.length === 0,
    failureClass: modelFailureClass,
    repairInstruction: typeof root.repairInstruction === 'string' ? root.repairInstruction.trim() : '',
  };
  result.passed = result.subjectMatched
    && result.sceneMatched
    && result.headlineMatched
    && result.bulletCoverage >= 0.8
    && result.styleMatched
    && result.layoutMatched
    && result.contradictions.length === 0
    && result.extraClaims.length === 0
    && result.textErrors.length === 0
    && result.ocrExactMatch;
  if (promptRuntimeSnapshot() && root.failureClass !== 'PASS' && !celsiusOnlyModelRejection) {
    result.passed = false;
  }
  if (result.passed) {
    result.failureClass = 'PASS';
    result.repairInstruction = '';
  } else {
    if (result.failureClass === 'PASS') {
      result.failureClass = classifyMechanicalFailure(result);
      result.repairInstruction = buildMechanicalRepairInstruction(result, allowedVisibleText);
    } else if (!result.ocrExactMatch) {
      result.repairInstruction = buildMechanicalRepairInstruction(result, allowedVisibleText);
    }
    result.repairInstruction = requiredText(result.repairInstruction, 'repairInstruction', { min: 5, max: 1_000 });
  }
  result.modelAssessment = structuredClone(root);
  result.programAssessment = {
    passed: result.passed, failureClass: result.failureClass, ocrExactMatch: result.ocrExactMatch,
    ocrMismatches: result.ocrMismatches,
    ignoredUnreadableText,
    celsiusEquivalence: {
      method: CELSIUS_EQUIVALENCE_METHOD,
      applied: celsiusApplications.length > 0,
      applications: celsiusApplications,
      ignoredTextErrors: ignoredCelsiusTextErrors,
      normalizedModelRejection: Boolean(celsiusOnlyModelRejection),
    },
    bulletComparison: {
      method: 'NORMALIZED_MULTISET',
      passed: bulletComparison.passed,
      orderMatched: bulletComparison.orderMatched,
      recognizedOrder: [...recognizedText.bullets],
      allowedOrder: [...allowedVisibleText.bullets],
      missing: bulletComparison.missing,
      unexpected: bulletComparison.unexpected,
      duplicates: bulletComparison.duplicates,
    },
    comparison: promptRuntimeSnapshot() ? promptPolicy().ocrComparison : 'LEGACY_NORMALIZED',
    minimumConfidence: promptRuntimeSnapshot() ? promptPolicy().ocrMinimumConfidence : MIN_OCR_CONFIDENCE,
    reason: '按可见验收契约逐项验证；模型原始结论独立保留',
  };
  return result;
}

export function createImageAlignmentValidator({
  agentClient,
  post,
  visualPlan,
  visualPage,
  imageCount,
  complianceDisclosure = '',
  onInvalidResponse,
}) {
  if (!agentClient?.runVision) throw new TypeError('Model vision client is required for image alignment');
  if (onInvalidResponse !== undefined && typeof onInvalidResponse !== 'function') {
    throw new TypeError('onInvalidResponse must be a function');
  }
  return async function validateImage({ imagePath, pageIndex, attempt }) {
    const page = visualPage ?? visualPlan?.pages?.[pageIndex - 1];
    if (!page) throw new TypeError(`visual plan page ${pageIndex} is missing`);
    const requiredDisclosures = [complianceDisclosure].filter(Boolean);
    const allowedVisibleText = requiredDisclosures.length > 0
      ? {
        ...page.allowedVisibleText,
        labels: [...new Set([...(page.allowedVisibleText.labels ?? []), ...requiredDisclosures])],
      }
      : page.allowedVisibleText;
    const validationPage = {
      ...page,
      allowedVisibleText,
      mustShow: [
        ...(page.mustShow ?? []),
        ...requiredDisclosures.map((value) => `图片右下角合规标识“${value}”`),
      ],
    };
    const prompt = buildImageAlignmentPrompt({
      post,
      visualPage: validationPage,
      pageIndex,
      imageCount,
    });
    let lastContractError;
    for (let responseAttempt = 1; responseAttempt <= MAX_ALIGNMENT_RESPONSE_ATTEMPTS; responseAttempt += 1) {
      const correction = responseAttempt === 1
        ? ''
        : `\n\n上一次响应未通过 JSON 契约（${lastContractError?.message ?? '结构无效'}）。这是格式纠正重试：只输出一个完整 JSON 对象，不要 Markdown、解释、前后缀或代码块。`;
      let generated;
      try {
        generated = await agentClient.runVision({
          prompt: `${prompt}${correction}`,
          inputPaths: [imagePath],
        });
      } catch (error) {
        throw new ImageAlignmentServiceError(error);
      }
      try {
        return {
          ...parseImageAlignmentOutput(generated.rawText, { allowedVisibleText }),
          model: generated.model,
          attempt,
          validatedAt: new Date().toISOString(),
        };
      } catch (error) {
        if (!(error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError)) throw error;
        lastContractError = error;
        await Promise.resolve(onInvalidResponse?.({
          pageIndex,
          generationAttempt: attempt,
          responseAttempt,
          model: generated.model,
          rawText: generated.rawText,
          error,
        })).catch(() => {});
      }
    }
    throw new ImageAlignmentResponseError(lastContractError);
  };
}
