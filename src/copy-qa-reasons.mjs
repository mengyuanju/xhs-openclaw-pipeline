export const MAX_COPY_QA_REASON_CODES = 30;

export const COPY_QA_REASON_GROUPS = Object.freeze([
  Object.freeze({ code: 'TITLE', label: '标题' }),
  Object.freeze({ code: 'BODY', label: '正文' }),
  Object.freeze({ code: 'PLAN', label: '图文规划' }),
]);

export const COPY_QA_SYSTEM_REASONS = Object.freeze([
  Object.freeze({ code: 'TITLE_MISSING_CORE_KEYWORD', group: 'TITLE', label: '缺少核心关键词' }),
  Object.freeze({ code: 'TITLE_AI_TONE', group: 'TITLE', label: 'AI感严重' }),
  Object.freeze({ code: 'TITLE_UNCLEAR_WORDING', group: 'TITLE', label: '语句不通/措辞混乱' }),
  Object.freeze({ code: 'TITLE_MISSING_HOOK', group: 'TITLE', label: '缺少信息钩子' }),
  Object.freeze({ code: 'TITLE_NOT_ANSWERING_NEED', group: 'TITLE', label: '未直接回应需求' }),
  Object.freeze({ code: 'TITLE_PUNCTUATION_ERROR', group: 'TITLE', label: '标点错误' }),

  Object.freeze({ code: 'BODY_OFF_TOPIC', group: 'BODY', label: '跑题' }),
  Object.freeze({ code: 'BODY_AI_TONE', group: 'BODY', label: 'AI感严重' }),
  Object.freeze({ code: 'BODY_UNNATURAL_SCENE_INTRO', group: 'BODY', label: '场景化引入不自然' }),
  Object.freeze({ code: 'BODY_LOGIC_CONFUSION', group: 'BODY', label: '逻辑混乱' }),
  Object.freeze({ code: 'BODY_DETAIL_ERROR', group: 'BODY', label: '细节信息错误' }),
  Object.freeze({ code: 'BODY_INSUFFICIENT_DEPTH', group: 'BODY', label: '内容深度不够/缺少高质信息' }),
  Object.freeze({ code: 'BODY_REDUNDANT_LANGUAGE', group: 'BODY', label: '语言冗余/无意义废话' }),
  Object.freeze({ code: 'BODY_FORMAT_ERROR', group: 'BODY', label: '标点/空行/格式错误' }),
  Object.freeze({ code: 'BODY_UNCLEAR_WORDING', group: 'BODY', label: '措辞不通' }),
  Object.freeze({ code: 'BODY_MISSING_DISCLAIMER', group: 'BODY', label: '缺免责声明' }),

  Object.freeze({ code: 'PLAN_COVER_MISSING_HOOK', group: 'PLAN', label: '首页标题缺少信息钩子' }),
  Object.freeze({ code: 'PLAN_COVER_VISUAL_ERROR', group: 'PLAN', label: '首页画面要点错误' }),
  Object.freeze({ code: 'PLAN_TYPO', group: 'PLAN', label: '漏字错字' }),
  Object.freeze({ code: 'PLAN_MISSING_DISCLAIMER', group: 'PLAN', label: '缺免责声明' }),
  Object.freeze({ code: 'PLAN_ORDER_MISMATCH', group: 'PLAN', label: '与正文顺序不一致' }),
  Object.freeze({ code: 'PLAN_DETAIL_MISMATCH', group: 'PLAN', label: '与正文细节/数据不一致' }),
]);

// Keep historical verdicts readable after the picker moves to the detailed taxonomy.
export const COPY_QA_LEGACY_REASONS = Object.freeze([
  Object.freeze({ code: 'FACT_ERROR', group: 'BODY', label: '事实或数据错误' }),
  Object.freeze({ code: 'QUERY_MISMATCH', group: 'BODY', label: '偏离 Query' }),
  Object.freeze({ code: 'STRUCTURE_ERROR', group: 'BODY', label: '结构不完整' }),
  Object.freeze({ code: 'EXPRESSION_ERROR', group: 'BODY', label: '表达或合规问题' }),
]);

const REASON_BY_CODE = new Map(
  [...COPY_QA_SYSTEM_REASONS, ...COPY_QA_LEGACY_REASONS].map((reason) => [reason.code, reason]),
);

export function copyQaReasonDefinition(code) {
  return REASON_BY_CODE.get(String(code ?? '').trim()) ?? null;
}

export function copyQaReasonLabel(code, snapshots = []) {
  const normalized = String(code ?? '').trim();
  const snapshot = Array.isArray(snapshots)
    ? snapshots.find((entry) => entry?.code === normalized && typeof entry?.label === 'string')
    : null;
  return snapshot?.label ?? copyQaReasonDefinition(normalized)?.label ?? normalized;
}

export function copyQaReasonLabels(codes, snapshots = []) {
  return Array.isArray(codes) ? codes.map((code) => copyQaReasonLabel(code, snapshots)).filter(Boolean) : [];
}
