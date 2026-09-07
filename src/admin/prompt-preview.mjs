import { businessPrompt, createPromptRuntime, withPromptRuntime } from '../prompt-runtime.mjs';
import { PROMPT_KINDS, PROMPT_CONTRACT_DESCRIPTION } from '../prompt-catalog.mjs';
import { normalizePromptContent } from './prompt-service.mjs';

export function promptCompatibilityIssues(kind, content) {
  return kind === 'IMAGE_SYSTEM' && content.includes('整套图片均由图像模型逐张生成视觉底图')
    ? ['包含历史“仅生成底图”规则，与完整页面生图契约冲突。请人工修改并发布新版本；系统不会截断或重写此段。'] : [];
}

export function assertPromptPublishable(kind, content) {
  normalizePromptContent(content);
  const issues = promptCompatibilityIssues(kind, content);
  if (issues.length) throw new TypeError(issues.join('；'));
}

export function previewPrompt({ kind, content, query = '预览示例' }, configuration) {
  if (!PROMPT_KINDS.includes(kind)) throw new TypeError('未知提示词类型');
  const candidate = normalizePromptContent(content);
  const runtime = createPromptRuntime({ source: 'ADMIN_DRAFT_PREVIEW', settings: configuration.settings ?? {},
    prompts: { [kind]: { content: candidate } } });
  const prompt = withPromptRuntime(runtime, () => businessPrompt(kind, { contract: PROMPT_CONTRACT_DESCRIPTION,
    variables: { query, category: '示例品类', targetAudience: '示例读者', imageIndex: 1, imageCount: 3, reviewInstruction: '示例修订要求' },
    data: { query, previewOnly: true } }));
  return { prompt, issues: promptCompatibilityIssues(kind, candidate), templateSha256: runtime.prompts[kind].sha256,
    note: '仅预览当前模板的变量展开和固定总契约，不调用模型。实际阶段继承规则、任务数据、schema 和工具协议请在执行记录查看。' };
}
