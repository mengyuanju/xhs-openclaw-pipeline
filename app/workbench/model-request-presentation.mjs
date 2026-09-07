const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const parse = text => { try { return JSON.parse(text); } catch { return null; } };
const pretty = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const DATA_LABELS = { untrusted_task_data: '本次任务参数', untrusted_query: '本次选题与任务数据',
  untrusted_copy_knowledge_reference: '入选文案案例', untrusted_visual_reference: '视觉参考配方' };
function versionsFrom(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(item => object(item) && typeof item.kind === 'string').map(item => ({ kind: item.kind,
    versionId: typeof item.versionId === 'string' || Number.isSafeInteger(item.versionId) ? item.versionId : null,
    version: Number.isSafeInteger(item.version) ? item.version : null,
    source: typeof item.source === 'string' ? item.source : 'UNVERSIONED',
    templateSha256: typeof item.templateSha256 === 'string' ? item.templateSha256 : null,
    renderedSha256: typeof item.renderedSha256 === 'string' ? item.renderedSha256 : null,
  }));
}

function referenceFields(value, path = '任务数据', depth = 0) {
  if (!value || typeof value !== 'object' || depth > 12) return [];
  return Object.entries(value).flatMap(([key, item]) => {
    const label = `${path}.${key}`;
    if (/reference|knowledge|recipe|candidates/iu.test(key) && item != null && item !== '') return [{ label, value: item }];
    return referenceFields(item, label, depth + 1);
  });
}

function splitPrompt(prompt, view) {
  const pattern = /^<(trusted_business_rules|pinned_editorial_instruction|program_contract|untrusted_[a-z_]+)(?: kind="([A-Z_]+)")?>\r?\n([\s\S]*?)\r?\n<\/\1>/gmu;
  let offset = 0;
  const remainder = text => { if (text.trim()) view.program.push({ label: '其他请求内容（未单独标注来源）', content: text.trim() }); };
  for (const match of prompt.matchAll(pattern)) {
    remainder(prompt.slice(offset, match.index));
    offset = match.index + match[0].length;
    const [, tag, kind, content] = match;
    if (tag === 'trusted_business_rules' || tag === 'pinned_editorial_instruction') {
      view.business.push({ label: kind ?? '固定的编辑要求', content });
    } else if (tag === 'program_contract') {
      view.constraints.push({ label: '程序追加的输出与校验要求', content });
    } else {
      const value = parse(content) ?? content;
      if (/reference|knowledge|recipe/iu.test(tag)) view.references.push({ label: DATA_LABELS[tag] ?? tag, value });
      else {
        view.taskData.push({ label: DATA_LABELS[tag] ?? tag, value });
        view.references.push(...referenceFields(value));
      }
    }
  }
  remainder(prompt.slice(offset));
}

/** Read historical evidence only. Never fill missing data from today's settings. */
export function summarizeModelRequest({ prompt = '', request = '', truncated = false } = {}) {
  const record = parse(request);
  const current = object(record) && record.format === 'xhs-model-request' && record.schemaVersion === 1 && object(record.payload);
  const payload = current ? record.payload : null;
  const view = { complete: Boolean(current && !truncated && ['HTTP_BODY', 'CLI_INPUT'].includes(record.scope)),
    scope: current ? record.scope : 'LEGACY', rawRequest: request, payload,
    versions: current ? versionsFrom(record.provenance?.versions) : [],
    runtime: current && object(record.provenance?.runtime) ? record.provenance.runtime : null,
    business: [], program: [], taskData: [], references: [], constraints: [] };
  const messages = Array.isArray(payload?.messages) ? payload.messages : Array.isArray(parse(prompt)) ? parse(prompt) : null;
  if (messages) {
    for (const message of messages) {
      if (!object(message)) continue;
      const content = typeof message.content === 'string' ? message.content : pretty(message.content);
      if (!content) continue;
      if (['system', 'developer'].includes(message.role)) view.program.push({ label: `${message.role} 指令`, content });
      else {
        view.taskData.push({ label: `${message.role ?? 'input'} 消息`, value: message.content });
        splitPrompt(content, view);
      }
    }
  } else {
    splitPrompt(prompt, view);
    if (!view.taskData.length && !view.business.length && prompt) view.taskData.push({ label: '模型输入（未单独标注任务字段）', value: prompt });
  }
  for (const key of ['instructions', 'developerInstructions']) {
    if (typeof payload?.[key] === 'string') view.program.unshift({ label: '程序追加指令', content: payload[key] });
  }
  for (const key of ['outputSchema', 'text', 'response_format', 'tools', 'tool_choice', 'max_output_tokens', 'max_tokens']) {
    if (payload?.[key] !== undefined) view.constraints.push({ label: key, content: pretty(payload[key]) });
  }
  if (Array.isArray(payload?.args)) {
    const args = payload.args;
    const settings = args.flatMap((arg, index) => arg === '-c' && typeof args[index + 1] === 'string'
      && !args[index + 1].startsWith('developer_instructions=') ? [args[index + 1]] : []);
    const sandbox = args.indexOf('--sandbox');
    if (sandbox >= 0) settings.push(`sandbox=${args[sandbox + 1]}`);
    if (settings.length) view.constraints.push({ label: '工具与运行协议', content: settings.join('\n') });
    const files = args.flatMap((arg, index) => ['--file', '--image'].includes(arg) ? [args[index + 1]] : []);
    if (files.length) view.references.push({ label: '本次调用附件（文件位置，未保存图片二进制）', value: files });
  }
  return view;
}
