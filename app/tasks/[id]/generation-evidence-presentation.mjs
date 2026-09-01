const DEMAND_LEVEL_LABELS = Object.freeze({
  strong: '强需',
  medium: '中需',
  weak: '弱需',
  none: '无需',
});

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value, fallback = '未填写', maxLength = 2_000) {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, maxLength)
    : fallback;
}

function taggedJson(content, tag) {
  if (typeof content !== 'string' || !content.trim()) return null;
  const match = content.match(new RegExp(
    `(?:^|\\r?\\n)\\s*<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>\\s*(?=\\r?\\n|$)`,
    'u',
  ));
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function imageCountLabel(value) {
  if (Number.isInteger(value) && value > 0) return `${value} 张`;
  const range = record(value);
  if (range.mode === 'auto' && Number.isInteger(range.min) && Number.isInteger(range.max)) {
    return `自动选择 ${range.min}–${range.max} 张`;
  }
  return '未记录';
}

function safeHttpUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

export function summarizeTextPrompt(content) {
  const task = taggedJson(content, 'untrusted_query');
  if (!task || !text(task.query, '', 500)) {
    return {
      available: false,
      message: '这条历史文案提示词无法整理为审核摘要；原始记录仍保留在折叠项中供技术排查。',
    };
  }

  const input = record(task.input);
  const judgement = record(input.taskJudgement);
  const webResearch = record(input.webResearch);
  return {
    available: true,
    query: text(task.query, '', 500),
    category: text(input.category),
    targetAudience: text(input.targetAudience),
    demandLevel: DEMAND_LEVEL_LABELS[judgement.demandLevel] || '未判定',
    primaryType: text(judgement.primaryType, '未判定', 100),
    judgementReason: text(judgement.reason, '未记录', 500),
    imageCount: imageCountLabel(task.deliveryImageCount),
    researchSourceCount: Array.isArray(webResearch.sources) ? webResearch.sources.length : 0,
    referenceUrlCount: Array.isArray(input.referenceUrls) ? input.referenceUrls.length : 0,
    referenceText: text(input.referenceText, '未提供', 2_000),
  };
}

export function researchSourceRows(snapshot) {
  if (snapshot?.status !== 'COMPLETED' || !Array.isArray(snapshot.sources)) return [];
  return snapshot.sources.slice(0, 5).flatMap((source) => {
    const url = safeHttpUrl(source?.url);
    if (!url) return [];
    return [{
      title: text(source.title, new URL(url).hostname, 300),
      url,
      siteName: text(source.siteName, new URL(url).hostname, 200),
      snippet: text(source.snippet, '未保存来源摘要。', 1_000),
      provider: text(source.provider, '未记录', 100),
      retrievedAt: text(source.retrievedAt, '', 100),
    }];
  });
}
