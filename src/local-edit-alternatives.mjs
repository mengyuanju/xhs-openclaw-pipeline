const text = value => typeof value === 'string' ? value.trim() : '';
const stages = new Set(['LOCAL_EDIT_SUGGESTION', 'LOCAL_TARGET_LOCALIZATION']);

// These are descriptions to choose from, never a claim that a blocked plan is safe.
// Keep the original request verbatim and change only the emphasis of its constraints.
export function localEditAlternatives(edit) {
  const validation = edit?.validation;
  if (edit?.operation !== 'AI_LOCAL' || edit.status !== 'FAILED' || edit.result
    || !validation || !stages.has(validation.stage) || validation.billedImageGeneration === true) return [];
  const original = text(edit.config?.instruction);
  if (!original || original.length > 1700) return [];
  const readySuggestion = validation.stage === 'LOCAL_EDIT_SUGGESTION' && validation.canEdit === true;
  const target = text(validation.targetDescription);
  const identified = Number.isFinite(validation.confidence) && validation.confidence >= .8
    && validation.candidateCount === 1 && target && target.length <= 500;
  const hasPlanningContext = Number.isFinite(validation.confidence) && validation.confidence >= .8
    && Number.isInteger(validation.candidateCount) && validation.candidateCount > 0 && target;
  if (!readySuggestion && !hasPlanningContext) return [];

  const planned = text(validation.suggestedInstruction);
  const detail = planned && planned !== original ? `执行说明：${planned}` : identified ? `仅针对已识别目标：${target}。` : '';
  const base = detail && original.length + detail.length <= 1700 ? `${original}\n${detail}` : original;
  const removing = validation.operationType === 'REMOVE';
  const moving = !removing && validation.operationType === 'MOVE';
  const options = [
    {
      id: 'precise', title: removing ? '精准移除' : '精准限定目标',
      description: '明确只处理点名对象，保留相邻物品与其他内容。',
      constraint: '严格按上述要求，仅修改明确点名的目标及其可见部分；不得把附近相似物品、人物或其他对象一并修改。保持未点名对象、文字、构图和色调不变。',
    },
    {
      id: 'natural', title: removing ? '自然修补背景' : moving ? '自然移动与衔接' : '自然融合与衔接',
      description: removing ? '移除同一目标，并重点修补原位置的纹理、光影与遮挡关系。' : '完成同一修改，重点保证背景、光影和接触关系自然。',
      constraint: removing
        ? '只移除上述明确点名的目标。依据周围已有背景自然补全原位置的纹理、光影与遮挡关系，不新增替代物、不留下残影；其他物体和所有文字保持原样。'
        : '完成上述同一修改，并与周围已有纹理、光照、透视和接触关系自然衔接；涉及移动时修补原位置，不重复生成目标，不新增其他对象，保留未点名内容和文字。',
    },
    {
      id: 'protected', title: '文字与边缘保护',
      description: '缩小修改范围，重点保护邻近标签、文字和画面边缘。',
      constraint: '在完成上述修改的前提下，把编辑限制在目标可见部分及必要的最小修补区域；目标贴边时沿现有边缘自然处理，不扩图、不裁切；邻近文字、标签边框和未点名对象保持不变。',
    },
  ];
  return options.map(({ constraint, ...option }) => ({ ...option, instruction: `${base}\n${constraint}` }));
}

export function selectLocalEditAlternative(edit, suggestionId) {
  const choice = localEditAlternatives(edit).find(option => option.id === suggestionId);
  if (!choice) throw new TypeError('请选择当前记录中的一个修改方案');
  return choice;
}
