export const COPY_QA_DISCARD_REASONS = Object.freeze([
  Object.freeze({ code: 'SHALLOW_CONTENT', label: '生成内容无深度' }),
  Object.freeze({ code: 'DISORGANIZED_LOGIC', label: '逻辑混乱修改难度过大' }),
  Object.freeze({ code: 'OFF_TOPIC', label: '跑题' }),
]);

const historicalLabels = Object.freeze({
  QA_RECOMMENDATION: '质检建议废弃',
  UNRECOVERABLE_QUALITY: '质量问题无法修复',
  REWORK_COST_TOO_HIGH: '返工成本过高',
  MISSING_SOURCE_MATERIAL: '缺少必要素材',
  OTHER: '其他原因',
});

export function copyQaDiscardReasonLabel(code) {
  return COPY_QA_DISCARD_REASONS.find(reason => reason.code === code)?.label
    ?? historicalLabels[code]
    ?? code
    ?? '未记录';
}
