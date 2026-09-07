import { businessPrompt } from './prompt-runtime.mjs';

export function buildResearchPrompt(query, limit) {
  return businessPrompt('RESEARCH_SYSTEM', { dataTag: 'untrusted_query', data: { query },
    contract: `必须使用本次真实联网结果，只返回 JSON：{"summary":"资料摘要","sources":[{"title":"来源标题","url":"公开 HTTP(S) URL","snippet":"对应来源要点","siteName":"网站名称"}]}。最多 ${limit} 个来源；不得伪造来源或 URL。` });
}
