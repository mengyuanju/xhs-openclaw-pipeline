import { businessPrompt, promptPolicy, promptRuntimeSnapshot } from './prompt-runtime.mjs';
import { createHash } from 'node:crypto';

const REVIEW_SCHEMA_VERSION = 1;
const REVIEW_MAX_ATTEMPTS = 2;
const TEXT_REVIEW_POLICY_VERSION = 2;
const STAGES = ['QUERY', 'TEXT'];
const DECISIONS = ['PASS', 'REJECT'];
const SEVERITIES = ['WARNING', 'BLOCKING'];
const GRAPHEME_SEGMENTER = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });

function visibleLength(value) {
  return [...GRAPHEME_SEGMENTER.segment(String(value ?? ''))].length;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function expectString(value, field, { min = 1, max = 500 } = {}) {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`);
  const normalized = value.replace(/\s+/gu, ' ').trim();
  const length = [...normalized].length;
  if (length < min || length > max) {
    throw new RangeError(`${field} must contain between ${min} and ${max} characters`);
  }
  return normalized;
}

function expectEnum(value, field, allowed) {
  if (!allowed.includes(value)) throw new TypeError(`${field} must be one of: ${allowed.join(', ')}`);
  return value;
}

function parseJsonFragments(raw) {
  const fragments = [];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  if (fenced) fragments.push(fenced[1].trim());
  fragments.push(raw.trim());

  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) fragments.push(raw.slice(start, index + 1));
    }
  }
  return [...new Set(fragments)];
}

function parseFirstObject(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 50_000) {
    throw new TypeError('review output must be a non-empty string no longer than 50000 characters');
  }
  for (const fragment of parseJsonFragments(raw)) {
    try {
      const value = JSON.parse(fragment);
      if (isRecord(value)) return value;
    } catch {
      // Try the next fenced or balanced object.
    }
  }
  throw new SyntaxError('review output does not contain a valid JSON object');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

function subjectSha256(subject) {
  return createHash('sha256').update(JSON.stringify(stableValue(subject))).digest('hex');
}

function querySubject(task) {
  return {
    query: typeof task?.query === 'string' ? task.query : '',
    input: isRecord(task?.input) ? task.input : {},
  };
}

function boundedEvidenceText(value, maxLength) {
  return typeof value === 'string' ? [...value].slice(0, maxLength).join('') : null;
}

function normalizedReviewEvidence(value) {
  const input = isRecord(value) ? value : {};
  const research = isRecord(input.webResearch) ? input.webResearch : null;
  return {
    referenceText: boundedEvidenceText(input.referenceText, 12_000),
    referenceUrls: Array.isArray(input.referenceUrls)
      ? input.referenceUrls.filter((item) => typeof item === 'string').slice(0, 8)
        .map((item) => [...item].slice(0, 500).join(''))
      : [],
    webResearch: research ? {
      provider: boundedEvidenceText(research.provider, 100),
      searchedAt: boundedEvidenceText(research.searchedAt, 100),
      summary: boundedEvidenceText(research.summary, 6_000),
      sources: Array.isArray(research.sources) ? research.sources.slice(0, 5).map((source) => {
        const item = isRecord(source) ? source : {};
        return {
          title: boundedEvidenceText(item.title, 200),
          url: boundedEvidenceText(item.url, 500),
          snippet: boundedEvidenceText(item.snippet, 1_000),
          siteName: boundedEvidenceText(item.siteName, 100),
        };
      }) : [],
    } : null,
  };
}

function reviewEvidenceFromTask(task) {
  return normalizedReviewEvidence(isRecord(task?.input) ? task.input : {});
}

function textSubject({
  task,
  post,
  allowedSources,
  editorialInstruction = '',
  evidence = reviewEvidenceFromTask(task),
}) {
  return {
    reviewPolicyVersion: TEXT_REVIEW_POLICY_VERSION,
    query: typeof task?.query === 'string' ? task.query : '',
    post,
    allowedSources: Array.isArray(allowedSources) ? allowedSources : [],
    editorialInstruction: typeof editorialInstruction === 'string' ? editorialInstruction : '',
    evidence: normalizedReviewEvidence(evidence),
  };
}

function promptData(value, field, maxLength = 20_000) {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized.length > maxLength) throw new RangeError(`${field} is too large for stage review`);
  return serialized;
}

function reviewedAt(now) {
  const value = now();
  return typeof value?.toISOString === 'function' ? value.toISOString() : String(value);
}

export function parseStageReviewOutput(raw) {
  const value = parseFirstObject(raw);
  if (value.schemaVersion !== REVIEW_SCHEMA_VERSION) {
    throw new TypeError(`schemaVersion must be ${REVIEW_SCHEMA_VERSION}`);
  }
  const decision = expectEnum(value.decision, 'decision', DECISIONS);
  const summary = expectString(value.summary, 'summary', { max: 300 });
  if (!Array.isArray(value.issues) || value.issues.length > 10) {
    throw new RangeError('issues must contain between 0 and 10 items');
  }
  const issues = value.issues.map((rawIssue, index) => {
    if (!isRecord(rawIssue)) throw new TypeError(`issues[${index}] must be an object`);
    const code = expectString(rawIssue.code, `issues[${index}].code`, { max: 40 });
    if (!/^[A-Z][A-Z0-9_]{1,39}$/u.test(code)) {
      throw new TypeError(`issues[${index}].code must be an uppercase identifier`);
    }
    return {
      code,
      severity: expectEnum(rawIssue.severity, `issues[${index}].severity`, SEVERITIES),
      message: expectString(rawIssue.message, `issues[${index}].message`, { max: 500 }),
    };
  });
  const blockingCount = issues.filter((issue) => issue.severity === 'BLOCKING').length;
  if (decision === 'PASS' && blockingCount > 0) {
    throw new TypeError('PASS review cannot contain blocking issues');
  }
  if (decision === 'REJECT' && blockingCount === 0) {
    throw new TypeError('REJECT review must contain at least one blocking issue');
  }
  return { schemaVersion: REVIEW_SCHEMA_VERSION, decision, summary, issues };
}

export function buildQueryReviewPrompt(task) {
  return businessPrompt('QUERY_REVIEW_SYSTEM', { data: querySubject(task), contract: reviewContract() });
}

function reviewContract() {
  return '只返回合法 JSON：{"schemaVersion":1,"decision":"PASS|REJECT","summary":"中文摘要","issues":[{"code":"UPPERCASE_CODE","severity":"WARNING|BLOCKING","message":"中文证据"}]}。PASS 不得包含 BLOCKING；REJECT 必须至少包含一个 BLOCKING。';
}

export function buildTextReviewPrompt({ query, post, allowedSources = [], editorialInstruction = '', evidence = {} }) {
  const bodyCharacterCount = visibleLength(post?.body);
  return businessPrompt('TEXT_REVIEW_SYSTEM', {
    inherits: promptRuntimeSnapshot() ? ['TEXT_SYSTEM'] : [],
    contract: `${reviewContract()}\n正文当前范围为400～600个可见字符，使用 deterministicMetrics 的实际计数。\n管理员编辑要求：\n${editorialInstruction}`,
    data: { query, post, allowedSources, evidence: normalizedReviewEvidence(evidence),
      deterministicMetrics: { bodyCharacterCount, requiredBodyRange: { min: 400, max: 600 },
        bodyLengthWithinRequiredRange: bodyCharacterCount >= 400 && bodyCharacterCount <= 600 } },
  });
}

function localReview({ stage, source, subject, summary, now }) {
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    stage,
    decision: 'PASS',
    summary,
    issues: [],
    source,
    model: null,
    reviewedAt: reviewedAt(now),
    subjectSha256: subjectSha256(subject),
  };
}

async function runReview({ client, stage, subject, prompt, thinking, mock, now }) {
  if (mock) {
    return localReview({
      stage,
      source: 'MOCK',
      subject,
      summary: '模拟运行未调用真实审核模型，仅供管线验证。',
      now,
    });
  }
  if (typeof client?.runReview !== 'function') {
    if (promptRuntimeSnapshot()) throw new Error('当前客户端不支持独立审核；未执行模型审核，不能自动通过');
    return localReview({
      stage,
      source: 'COMPATIBILITY',
      subject,
      summary: '当前注入的兼容客户端不支持独立审核调用，已仅执行本地契约校验。',
      now,
    });
  }

  let lastError;
  for (let attempt = 0; attempt < REVIEW_MAX_ATTEMPTS; attempt += 1) {
    const repairSuffix = attempt === 0 ? '' : `\n\n上一次审核输出不符合 JSON 契约：${JSON.stringify({ validationError: String(lastError?.message ?? lastError).slice(0, 300) })}。请重新返回完整合法 JSON，不要加 Markdown。`;
    const generated = await client.runReview({ prompt: `${prompt}${repairSuffix}`, thinking });
    try {
      const parsed = parseStageReviewOutput(generated.rawText);
      const policyApplied = parsed;
      return {
        ...policyApplied,
        stage,
        source: (generated.provider ?? client.provider) === 'codex' ? 'CODEX' : 'OPENCLAW',
        model: typeof generated.model === 'string' ? generated.model.slice(0, 200) : null,
        reviewedAt: reviewedAt(now),
        subjectSha256: subjectSha256(subject),
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`${stage === 'QUERY' ? 'Query' : '文本'}审核输出连续未通过结构校验：${lastError?.message ?? String(lastError)}`);
}

export function runQueryReview({ client, task, mock = false, now = () => new Date() }) {
  const subject = querySubject(task);
  if (!promptPolicy().queryReviewEnabled) {
    return { ...localReview({ stage: 'QUERY', source: 'DISABLED', subject,
      summary: 'Query 筛选已关闭，当前选题未经模型审核。', now }), skipped: true };
  }
  return runReview({
    client,
    stage: 'QUERY',
    subject,
    prompt: buildQueryReviewPrompt(task),
    mock,
    now,
  });
}

export function runTextReview({
  client,
  task,
  post,
  allowedSources = [],
  editorialInstruction = '',
  thinking,
  mock = false,
  now = () => new Date(),
}) {
  const evidence = reviewEvidenceFromTask(task);
  const subject = textSubject({
    task,
    post,
    allowedSources,
    editorialInstruction,
    evidence,
  });
  return runReview({
    client,
    stage: 'TEXT',
    subject,
    prompt: buildTextReviewPrompt({
      query: task?.query ?? '',
      post,
      allowedSources,
      editorialInstruction,
      evidence,
    }),
    thinking,
    mock,
    now,
  });
}

export function isReusableStageReview(review, { stage, subject }) {
  if (!isRecord(review) || !STAGES.includes(stage) || review.stage !== stage
    || review.schemaVersion !== REVIEW_SCHEMA_VERSION || !DECISIONS.includes(review.decision)
    || !['CODEX', 'OPENCLAW', 'MOCK', 'COMPATIBILITY'].includes(review.source)
    || review.subjectSha256 !== subjectSha256(subject)) return false;
  try {
    parseStageReviewOutput(JSON.stringify(review));
    return true;
  } catch {
    return false;
  }
}

export function describeStageReviewFailure(review) {
  const label = review?.stage === 'QUERY' ? 'Query' : '文本';
  const evidence = Array.isArray(review?.issues)
    ? review.issues.filter((issue) => issue?.severity === 'BLOCKING')
      .slice(0, 3)
      .map((issue) => String(issue.message ?? '').replace(/\s+/gu, ' ').trim().slice(0, 300))
      .filter(Boolean)
      .join('；')
    : '';
  return `${label}审核未通过${evidence ? `：${evidence}` : ''}`;
}

export function queryReviewSubject(task) {
  return querySubject(task);
}

export function textReviewSubject({
  task,
  post,
  allowedSources = [],
  editorialInstruction = '',
}) {
  return textSubject({
    task,
    post,
    allowedSources,
    editorialInstruction,
    evidence: reviewEvidenceFromTask(task),
  });
}
