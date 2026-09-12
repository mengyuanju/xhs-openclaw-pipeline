const guard = (id, title, purpose) => Object.freeze({
  id,
  title,
  purpose,
  startMarker: `【关键优化开始：${id}】`,
  endMarker: `【关键优化结束：${id}】`,
});

export const PROMPT_OPTIMIZATION_GUARDS = Object.freeze({
  TEXT_SYSTEM: Object.freeze([
    guard(
      '正文与配图职责分离-V1',
      '正文与配图职责分离',
      '正文保留读者需要的信息，制图方式写入 imagePlan，减少重复内容和正文超长；规则适用于全部内容类型。',
    ),
  ]),
});

export function promptOptimizationGuardStatuses(kind, content) {
  const source = typeof content === 'string' ? content : '';
  return (PROMPT_OPTIMIZATION_GUARDS[kind] ?? []).map((item) => {
    const start = source.indexOf(item.startMarker);
    const end = start < 0 ? -1 : source.indexOf(item.endMarker, start + item.startMarker.length);
    const rule = start >= 0 && end > start
      ? source.slice(start + item.startMarker.length, end).trim()
      : '';
    return { ...item, present: start >= 0 && end > start && rule.length > 0, rule };
  });
}

export function missingPromptOptimizationGuards(kind, content) {
  return promptOptimizationGuardStatuses(kind, content).filter(({ present }) => !present);
}
