const cleanText = value => String(value ?? '').normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();

const DISCLOSURE_REMOVAL_ACTION = /(?:删除|去掉|移除|去除|清除|抹掉|擦除)/gu;
const AI_DISCLOSURE_REFERENCE = /(?:ai(?:生成)?|人工智能|人工生成|生成式ai).{0,12}(?:标识|标签|水印|声明|提示|字样)/iu;

export function requestsDisclosureRemoval(instruction, disclosureText) {
  const value = String(instruction ?? '').normalize('NFKC');
  const exact = cleanText(disclosureText);
  for (const match of value.matchAll(DISCLOSURE_REMOVAL_ACTION)) {
    const before = value.slice(Math.max(0, match.index - 4), match.index);
    if (/(?:不要|不得|禁止|不可|别|无需|无须)$/u.test(before)) continue;
    const nearby = value.slice(Math.max(0, match.index - 32), Math.min(value.length, match.index + 64));
    if (AI_DISCLOSURE_REFERENCE.test(nearby) || (exact && cleanText(nearby).includes(exact))) return true;
  }
  return false;
}

export function localizedTargetIsDisclosure(target, disclosureText) {
  if (target?.targetIsAiDisclosure === true) return true;
  const description = String(target?.targetDescription ?? '');
  const exact = cleanText(disclosureText);
  return AI_DISCLOSURE_REFERENCE.test(description) || (exact && cleanText(description).includes(exact));
}

export function disclosureRemovalConfig(config) {
  return {
    ...config,
    preserve: '除说明明确点名的人工生成标识外，保留原图全部已批准文字、所有未点名区域、人物、构图和色调',
    negative: '不得修改说明之外的区域；不得新增、删除或改写被点名人工生成标识以外的任何文字',
  };
}
