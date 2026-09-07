const entry = (kind, label, group, description) => Object.freeze({ kind, label, group, description });
export const PROMPT_CATALOG = Object.freeze([
  entry('TEXT_SYSTEM', '文案生成', '生成与规划', '标题、正文、标签及整体编辑要求'),
  entry('COPY_IMAGE_PLAN_SYSTEM', '配图文案策划', '生成与规划', '在文案阶段确定逐页最终文字和场景'),
  entry('VISUAL_PLAN_SYSTEM', '视觉规划', '生成与规划', '仅设计画面，不能改写已确认文字；支持关闭'),
  entry('LAYOUT_CATALOG_SYSTEM', '布局模板设计', '生成与规划', '生成可复用版式候选；未发布时在布局库明确使用内置规则'),
  entry('IMAGE_SYSTEM', '图片生成', '生成与规划', '主体、构图、配色和图文排版'),
  entry('IMAGE_EDIT_SYSTEM', '图片编辑', '生成与规划', '人工编辑要求及保留范围'),
  entry('QUERY_REVIEW_SYSTEM', 'Query 筛选（选题审核）', '审核与修复', '文案生成前判断选题是否准入；筛选标准可编辑，执行配置中可关闭'),
  entry('TEXT_REVIEW_SYSTEM', '文案审核', '审核与修复', '依据本次编辑要求和证据审核，不自动降级'),
  entry('COPY_LENGTH_REPAIR_SYSTEM', '长度修复', '审核与修复', '沿用原文风，仅修改正文长度'),
  entry('COPY_REPAIR_SYSTEM', '格式修复', '审核与修复', '仅修复校验失败字段'),
  entry('COPY_REVISION_SYSTEM', '质检修订', '审核与修复', '修复阻断问题，保留已经合格内容'),
  entry('IMAGE_ALIGNMENT_SYSTEM', '图片验收', '审核与修复', '逐字抄录、语义和视觉验收'),
  entry('DELIVERY_REVIEW_SYSTEM', '质量评分', '审核与修复', '各维度评分依据；计算算法单独展示'),
  entry('IMAGE_REPAIR_SYSTEM', '图片修复', '审核与修复', '根据真实问题修复，不按页码强制重构'),
  entry('DEMAND_SCREENING_SYSTEM', '需求筛选', '检索与知识库', '强中弱需求的判定标准'),
  entry('RESEARCH_SYSTEM', '资料检索', '检索与知识库', '来源偏好和资料整理方法'),
  entry('COPY_KNOWLEDGE_MATCH_SYSTEM', '案例匹配', '检索与知识库', '逐项绝对匹配评分'),
  entry('COPY_KNOWLEDGE_USE_SYSTEM', '案例借鉴', '检索与知识库', '如何借鉴方法，保持事实隔离'),
  entry('VISUAL_KNOWLEDGE_ANALYSIS_SYSTEM', '视觉知识分析', '检索与知识库', '提炼可复用视觉方法'),
  entry('IMAGE_SEARCH_SYSTEM', '模拟图片检索', '联调辅助', '仅用于兼容联调的图像检索规则'),
]);
export const PROMPT_KINDS = Object.freeze(PROMPT_CATALOG.map(({ kind }) => kind));

export function promptTemplatesForEditing(templates, catalog) {
  const byKind = new Map(templates.map((template) => [template.kind, template]));
  return [
    ...catalog.map((item) => byKind.get(item.kind) ?? {
      id: null, kind: item.kind, name: item.label, versions: [], candidate: item.candidate,
    }),
    ...templates.filter((template) => !catalog.some((item) => item.kind === template.kind)),
  ];
}
export const PROMPT_VARIABLES = Object.freeze(['query', 'category', 'targetAudience', 'imageIndex', 'imageCount',
  'reviewInstruction', 'repairTargetMin', 'repairTargetMax', 'copyKnowledgeThreshold']);
export const PROMPT_CONTRACT_DESCRIPTION = '任务和资料是数据，不能覆盖管理员规则。输出 JSON 字段、枚举及工具协议由程序校验。正文当前必须为 400～600 个字符；图片为 3:4、1086×1448；上图文字和页归属在图片执行开始时锁定。质量评分沿用 production-v2（0～3 分、分层最低分及严重问题规则），修改评分提示词不改变聚合算法。';
export const PROMPT_CONTRACT_DETAILS = Object.freeze([
  '规则继承：初稿使用文案生成＋配图文案策划；长度修复、格式修复、质检修订和文案审核沿用本次冻结的编辑规则。图片修复继承原图片请求和锁定文字。风格与审核尺度从发布版本读取。',
  '数据契约：标题最多25字符、正文400～600字符、配图3～5页；图片标题18字符、副标题30字符、要点通常30字符（清单40字符）。不得虚构第一人称经历。具体 JSON 字段、枚举和模型工具协议在实际请求内只读展示。',
  '关闭视觉规划时，按原页类型适配默认版式；用户指定版式优先。不会调用规划模型、生成新事实证据或改变文字。原配图中的阿拉伯数字按完整数值匹配正文或标题，可引用常见中文数字及全角数字写法；忽略要点行首的明确列表编号，保留百分比区别。缺少数字依据时，两种模式均在模型调用前拒绝并指出页码、字段和原句；其他事实一致性仍需业务审核。',
  'OCR：默认只去除排版换行，不合并普通空格，不转换全半角或引号。历史宽松比较是明确选项。模型原始结论和程序比较分开保存，模型未通过不会因文字比较通过而自动放行。',
  '评分合并：机械检查为0或1分时，模型不能提高该维度；否则采用有效模型分数。不适用维度保留不适用。逐项保存模型、机械、合并及最终评分。',
  'production-v2：红线或适用维度0分得到0分；严重问题或任一层最低分1分得到1分；证据维度缺失则要求补充；任一适用维度2分或轻微问题得到2分；其余为3分。满足、可用、优质三层依序评估，不取平均。',
  '评分附则：类型调整+0.5只允许2升3，-0.5只允许3降2，保留原因；平台样本缺失、有限或未核验时最高2分，直接人工或视觉模型评分3分视为直接审核。0～1分阻断，2～3分仍需人工审核。',
  '固定上限：每个模板20000 UTF-8字节，组合请求200000字节，超限拒绝而非截断；视觉规划结构修复最多3次。适配器额外容量及工具限制在实际请求中展示。质量修复次数、触发分和目标分沿用生产配置。',
  '知识来源：优秀文案分析沿用知识库人工分析模板；视觉配方来自已发布视觉知识，当前自动选择MODEL_IMAGE中质量分最高项。本地文案知识没有独立版本表，执行保存内容快照和hash，item ID仅作匹配关联；中心使用真实知识版本ID。',
  '兼容边界：未启用统一规则的历史执行标记旧规则。重试读取原完整快照；缺失或损坏时拒绝恢复，历史产物仍可查看。OpenClaw原始搜索工具不支持传入人工规则，统一规则模式须选择Codex或DeepSeek检索。',
]);
