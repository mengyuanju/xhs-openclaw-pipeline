// Reconcile stable inventory IDs with concrete browser actions and executed TAP.
// A mapped component fixture does not prove a real database/model nor every branch.
import fs from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd();
const reportRoot=path.join(root,'reports/full-functional-2026-10-02');
const inventoryPath=path.join(root,'docs/full-functional-test-inventory-2026-10-02.md');
const inventory=await fs.readFile(inventoryPath,'utf8');
const rows=inventory.split('\n').filter(line=>/^\| F-/.test(line)).map(line=>{
  const c=line.split('|').map(v=>v.trim());return{id:c[1],route:c[2],operation:c[3],expected:c[4],inventoryStatus:c[6]};
});
const actions=[];
function add(file,line,ids,scope){
  for(const group of ids.split(';')){const [prefix,numbers]=group.trim().split(':');
    for(const item of numbers.split(',')){const [a,b]=item.split('-').map(Number);for(let n=a;n<=(b??a);n++)
      actions.push({featureId:`F-${prefix}-${String(n).padStart(3,'0')}`,file:`tests/${file}.test.mjs`,line,scope,evidenceType:'UI_FIXTURE',completeness:'PARTIAL_FEATURE'});}}
}
add('session-renewal-browser',278,'AUTH:9','浏览器共享会话续期：可信活动、重复窗口、旧401和登录/注销竞态；非登录表单完整覆盖');
add('profile-name-boundary-browser',25,'AUTH:11','真实ProfileManager空姓名零PATCH、80字原生上限、503保持输入/原profile不变、同version重试和实际刷新持久显示；HTTPfake不涉及密码或100任务');
add('background-tasks-browser',83,'NAV:7,11;COPY:17;PLAN:13-15;EDIT:5,10,13,39','重新生成规划确认、后台关闭、完成后载入；编辑后台运行后提醒和历史折叠');
add('background-tasks-browser',120,'NAV:9','实际单项标为已读，localStorage逐ID检查该IMAGE_EDIT提醒read改变、其余记录不变');
add('background-task-ownership-browser',149,'NAV:7,11;EDIT:5,10,13,29,39,40','外国账号记录不进入个人提醒，旧缓存先验证归属；本人后台程序标识和返回记录');
add('dialog-notification-browser',41,'NAV:12,13','真实浏览器通用弹窗/通知交叠，遮罩、Escape、焦点、动作只执行一次');
add('annotation-job-report-browser',92,'ANNOT:1,5-9','刷新、四种指标、自然日/工作日、数值显示、图例点击和画布交互；筛选导出另测');
add('annotation-job-report-browser',108,'ANNOT:2-4','实际只有质检记录人员显示/隐藏、人员作业表内容比较、统计口径展开关闭；纯HTTPfake的quality-only夹具，主100无该历史');
add('operator-performance-browser',107,'STAT:1-4,6-11,14,15','时间/内容/人员筛选、指标下钻、工作量趋势、三种明细页签、键盘切换、导出、移动排序、错误后保留成功数据；并非全部筛选参数');
add('operator-performance-browser',171,'STAT:12','实际下钻同一#100内容两条RETURN/PASS事件、昨日整批波及事件与范围切换；不声称当前任务链接导航或完整处理时间线已点');
add('prompt-catalog-browser',59,'PROMPT:1-5,10','搜索、业务目录、实际默认内容/调用位置/变量查看、只读协议、草稿切换保留及保存；不含全部执行配置');
add('prompt-catalog-browser',88,'PROMPT:11','TEXT_SYSTEM保护规则完整/缺标识/空内容/缺结束标识实际提示，保存警告取消无写入且草稿保持，完整恢复提示和缺规则继续保存草稿；HTTPfixture不发布');
add('prompt-catalog-browser',124,'PROMPT:2,3,10,12,18,19','实际Home/End/左右循环与草稿保持、Query规则快捷入口；其他管理员发布后刷新保留未存稿、禁陈旧保存且可放弃恢复新稿；示例Query500字边界和不可信文本，经生产previewPrompt真实展开、503重试；执行记录WEB/CENTER切换、503重试、非空列表与明细按钮、实际请求/原始响应/失败及脱敏占位文本；HTTPfake无模型');
add('copy-review-drafts-browser',129,'COPY:4,6,9,11,13-16;PLAN:3,11','评分2.5、标题草稿、IndexedDB跨刷新/账号/修订隔离、评分与规划正式保存；并非评分所有档位');
add('copy-rework-browser',136,'COPY:18,19,21;PLAN:3,11,17','质检退回任务规划直接提交、单独保存后提交，未改和还原不允许绕过门禁');
add('image-retry-rework-browser',111,'COPY:6,23;PLAN:3,17','失败耗尽后的新标题/新规划变更门禁及提交；仅浏览器HTTP夹具，强制V2由真实PG另测');
add('image-plan-review-browser',130,'COPY:3;PLAN:1,3,4,11,12,17','规划上一页/下一页、标题与换行差异、移动文案页签、保存与返修门禁');
add('image-plan-review-browser',188,'PLAN:2,5,7-10','实际页面类型、生成指令、自动/自定义排版、标题/主体/文字位置、对齐、留白、20/90占比边界、布局说明与示意、SAVE_PLAN请求；参数仍以实际点选项为限');
add('image-review-notes-browser',203,'WORK:7-9;IREVIEW:3-7,9,10,12','备注编辑跨失败/同版本保持，跳过/选择确认，集中采用拒绝后提交首次/强制复检');
add('copy-qa-detail-browser',87,'CQA:3,5,6','进入批次、查看并质检、最终文案与规划固定框架及窄屏可读');
add('copy-qa-overview-browser',81,'CQA:1,3,5-7','已完成/待质检、进入批次、打开样本、当前文案规划和匿名显示');
add('copy-qa-reason-picker-browser',94,'CQA:9','原因标签分组展开、多选、添加私人标签、打开管理、返回已选；并非发布/停用标签全CRUD');
add('image-quality-browser',189,'IQA:1,5,7-11,13,16','V2图片待办的盲评、重复强制退回、原因/问题页、通过；废弃空值/取消/失败重试和历史详情');
add('image-quality-browser',324,'IQA:14','权限capability=false隐藏整批按钮，true时理由及整批修改说明必填；实际范围预览、confirm取消无POST、确认精确批次/样本/计数请求；真实后台复检状态由PG另验');
add('image-quality-browser',357,'IQA:17','实际旧samplingItemId提交409、保留返工表单/错误；关闭刷新取新samplingItemId并成功提交，HTTPfake不代表真实并发抢锁；后台陈旧图集与幂等由真实PG验证');
add('reassignment-batch-browser',146,'REASSIGN:1,2,7,11-14','单选全选清空、分页/全部记录、接手账号失败重新载入、批量分配/废弃/还原部分失败和相同请求重试');
add('reassignment-batch-browser',361,'REASSIGN:3-6,8-10','实际单条处置/记录、初稿和分配历史展开、还原/清理失败重试同requestID、缺初稿再生成busy门禁、分配reason/失败retry、废弃取消/确认与恢复；HTTPfake，源contract不计');
add('secondary-assignment-feedback-browser',232,'WORK:6,13;IREVIEW:4;IPREVIEW:1,2;COPY:18;REASSIGN:15','图片作业、此前反馈、下一张与放大并关闭、二次分配任务的新审核反馈和草稿导航');
add('task-restoration-browser',84,'VIEW:9;LIST:28','废弃池任务恢复确认取消、失败保留、成功删除列表条目');
add('admin-task-discard-browser',131,'LIST:23,24,27,30','行菜单、单页选择、批量废弃取消确认、二级密码与永久删除确认；不等于所有上限边界');
add('admin-task-discard-browser',196,'LIST:1,26,29,31','实际列表503→刷新、单条删除取消/错误密码/成功与运行任务禁删、批量重试只允许子集和取消、导出21禁用/20实际ZIP下载bytes；HTTPfixture');
add('admin-task-discard-browser',214,'LIST:35','实际ADMIN空态点击创建第一条进入Query表单、关闭，USER空态隐藏CTA、全量无匹配显示空态且无错误通知；HTTPfixture');
add('workbench-route-empty-browser',30,'VIEW:10','真实WorkbenchListPage SSR在无中心配置下显示明确提示且不挂表单；未知view返回404。浏览器实际读取边界状态，无可点击控件；配置和导航adapter为fake');
add('current-image-editor-browser',101,'EDIT:1,3,5-9,10-28,29,31,32,35,36,38','程序和模型标识、徽章/颜色/屏幕取色fake、页选择、产品参考模式/批次、局部定位与动作、费用确认、采用、失败补强/定向修复；模型输出由HTTP夹具提供');
add('current-image-editor-browser',150,'EDIT:4,30,33,34,37','比较滑块0/100和缩放1/3、旧历史恢复、拒绝理由必填和确认取消、复用说明仍需新费用授权；HTTP夹具输出');
add('current-image-editor-browser',555,'EDIT:16','产品参考图超限、实际格式和扩展名不匹配后纠正重试');
add('current-image-editor-layout-browser',49,'EDIT:3,29,38','长失败/多条记录的滚动约束，失败原因、质量校验和审计展开、移动记录页签');
add('standalone-image-editor-browser',73,'STAND:1-4,6-12;EDIT:5-8,10-13,15,16,18,29,32,40','独立图片新增上传错误/多图、保存提交、查看运行/结果、下载、单条和批量删除、程序标识逐张/批量/旧批次继续采用；分页/取消及部分失败有未覆盖参数');
add('standalone-image-editor-browser',85,'STAND:5','实际上传进行中输入禁用、Escape无法关闭和close图标隐藏；没有取消上传功能，HTTPfixture延迟放行');
add('standalone-boundary-browser',75,'STAND:1-4,6,10-12','21行实际20/1分页、末页删除回退、运行禁选、单条/整页批量取消确认和503重试、列表失败旧行保持、name200/reset/未上传关闭零写入、6超5前置阻止、真decodeReference损坏/尺寸错误、上传失败保持、PNG/JPEG/WebP五图顺序与第1/5页；HTTPfake');
add('image-preview-browser',70,'IPREVIEW:2,4','预览左右方向键边界、100%及聚焦控件时不误切页；不含滑杆、滚轮全部操作');
add('image-preview-browser',109,'IPREVIEW:3,6-10','实际三种底色、源图切换、左右旋转与恢复、默认完整预览偏好跨刷新、下载字节、失败重试；无自定义拖动或历史参数恢复入口');
add('image-preview-browser',108,'IPREVIEW:5','真实大图原生viewport横向及纵向滚动，100%和适应窗口；503→retry后图片20px实际load。不存在自定义拖动控件');
add('work-mode-browser',248,'WORK:1-3,5-18;COPY:3,4,6,9,12,13,17,18,22;PLAN:1,6,11,13,15;IREVIEW:1-13,16;IPREVIEW:1,2,4,6;CQA:6,9-11;IQA:5,6,8-13,16;NAV:7,8,10-13','四种工作队列、分类/加载更多、侧栏、草稿导航/下一条、规划删除保存、QA打回/通过、图片放大右转/100%、集中修改全部/逐项/取消待处理、通知跳任务/全读/历史、废弃；每个compound用例仅该文件实际操作部分');
add('work-mode-browser',198,'WORK:4','真实筛选已加载待办控件fill无匹配/Query1/清空后恢复#2；只筛选已加载队列，未声称全库搜索');
add('model-call-trace-browser',88,'TRACE:3-5,7','模型记录展开、22条分页、调研来源/摘要脱敏、换文案版本、真实调用搜索结果展开；夹具无模型调用');
add('model-call-trace-browser',136,'TRACE:6','实际失败调用细节503/重试、截断提示、附件文件路径展开、原始Prompt文本无HTML执行和脱敏请求缺完整性提示；HTTPfixture');
add('account-copy-sampling-browser',66,'USER:5,9','编辑账号抽检单独0/继承、旧中心不支持门禁、失败草稿保留和移动布局；当前V2无旧0%保底承诺');
add('shared-delivery-browser',90,'DELIVERY:1-4,8,10-16,18-21','责任人、交付状态/日期查询、选择、已交付确认、汇总、冻结内容生成下载、取消、多卷重下/原范围重试/历史版本；初轮下载环境失败须以复测匹配');
add('shared-delivery-filter-browser',35,'DELIVERY:6,7,9,17','实际正向精确词包与批次成员、搜索task/Query/batch、全部汇总和当前/历史版本参数独立125条成员断言、20/50/100及四分页边界、USER隐藏管理控件；HTTPfixture');
add('frontend-followup-browser',85,'CFLOW:1-3,5,6,9;IQA:1-4,8','个人/混合页签、用户任务按需读取、质检项选择刷新创建；图片质检分页、人员筛选清除和通过后的状态计数');
add('frontend-followup-browser',110,'CFLOW:4,7,8,10','入批与质检项全选联动、跨审核人混合批次成员/样本精确请求、个人随机模式取消与确认、不上传指定样本、成功真实导航进入文案质检组件；随机算法仍以真实PG为准');
add('frontend-refresh-browser',133,'LIST:11;COPY:4,6,17;STAND:13;EDIT:39','最近变更日期、评分标题草稿关闭继续、编辑器加载失败重读、保留父层备注及重新打开');
add('frontend-round3-browser',97,'LIST:2,24;DELIVERY:18;CQA:1-5,8','列表关键词/勾选、历史加载失败重试、批次和明细分页、通过质检确认后精确刷新及返回');
add('performance-round2-app-browser',70,'EDIT:2,29,40','运行中元数据保持不读历史；真实夹具结果更新解锁、缩略图失败回退、旧独立编辑API恢复');
add('personal-workspace-browser',255,'PERSONAL:1-5,7-15;LIST:13-16;VIEW:1','个人/作业页签、今日QA详情、首次返修废弃提交下钻、分页、今天昨天7天自定义日历、返修分类/关系、交付记录与失败刷新；30天个人按钮当前不存在');
add('search-lab-browser',53,'LAB:1,3-21,23-26','13家控件逐一选择、Key显示隐藏、全部服务专属字段、13个实际HTTP假搜索、复制摘要、单家/全部文案、下载TXT、生成期间禁用、取消和诊断；不证明13家外部真实服务调用或所有服务字段参数分支');
add('search-lab-browser',53,'LAB:2,22','实际空选题拒绝、maxlength500和可输入边界、已有文案再点重新生成并捕获第二调用；HTTPfake无真实模型');
add('legacy-delivery-browser',70,'DLEGACY:1-14','所有实际工具页签、搜索/加载更多、图文全部页与原图、Excel/ZIP下载事件、单条上传取消确认/整包上下限、公开预览打开、历史详情、USER权限；HTTP夹具的合成交付');
add('creation-form-browser',63,'CREATE:1-7,9','创建表单真实100条多分隔输入、空/重复/501字/101条拒绝、全部页数、免审核负责人和角色限制、提交禁用、503保留重试、不可信Query仅原样文本；不证明真实队列/图片门禁');
add('creation-form-browser',69,'CREATE:8','实际免文案审核勾选、缺负责人禁提交、选择允许负责人后skipCopyReview与账号精确payload；图片初审/质检门禁是后续后台状态，引用独立HTTP与PG组合证据，不虚构额外开关');
add('query-package-browser',83,'QPK:1-15,22-35,41','实际200+1词包9状态/搜索/刷新503，TXT/CSV/真XLSXparser工作表/列/标准拆包与错误，200+5虚拟列表7状态/外部ID/只读/双向暂存关闭无写入/提交通过tasklink/拒绝reason/409重载仍可见错误、角色空态；HTTPfake持久化，真实后台由PG另验');
add('task-priority-batch-browser',34,'ASSIGN:6-10','实际全部6优先级、原因必填/2000上限、同一生产批次范围/503恢复/取消、3条精确priorityVersion、409强制重新预览、新version确认和混合批次无勾选项；HTTPfixture');
add('copy-qa-discard-browser',48,'CQA:12-15','实际理由/说明必填、二次确认取消与确认、失败保持与同requestId重试、废弃只读最终稿/理由、403错误展示；阈值后台处置和自检/陈旧版本不算本UI覆盖');
add('copy-review-controls-browser',39,'COPY:2,5,7,8,10,20,24,25;TRACE:1','实际正文399/400/600及英文计数、标签2/9拒绝8保存、机器2.5与最终3独立、1分废弃取消确认、返工暂存、未分配/他人/已质检只读、水印保存、实际ZIP下载和进入质检、文案/评分历史分页展开；HTTPfakes');
add('copy-review-controls-browser',64,'PLAN:16;IREVIEW:17','实际规划503后旧规划/正文保留并点重新生成；图片失败继续、耗尽重试、整套重新生成均取消与确认，精确useLatestConfig/operation/费用授权payload；HTTPfixture');
add('production-settings-browser',50,'SETTING:33,34,43,44','本机实际自动返修分数与次数、保存失败保留重试、AI披露字符正反例/开关/保存重载；本机模型单独控件在当前中心页面条件不适用');
add('production-settings-browser',86,'SETTING:12-23','本机ProductionSettingsForm实际提供方CODEX/DOTS/继承、Dots地址正反例、六种思考强度、六阶段模型、备用/冷却/超时边界、代理格式及凭证禁止、保存及恢复环境；真实normalizer处理HTTPfake，无模型与中心配置写入');
add('settings-policy-branches-browser',75,'SETTING:2,3,5,8-11,25,27,29,30,36,42','中心全部配置分支实际选择/保存，HTTPfixture经真实normalizer校验；layout候选模型输出fake，必须匹配本轮执行PASS才计证据');
add('settings-remaining-browser',75,'SETTING:1,4,6,24,26,28,31,32,48','DeepSeek模型/默认/超时/数量合法端点、tab草稿保持、copy/image盲评开关和0/100/小数、撤销/GET503及workflow409重读、人工图片/文案100字placeholder不预填评分；实际normalizer的HTTPfake');
add('settings-catalog-controls-browser',110,'SETTING:35,37-41,48','实际catalog分类/启用filter、10/20/50分页、启用保存、全部编辑字段与取消、新版本/CAS/失败保留、JSON文本和真文件1MB/schema/原子导入、27内置重复导入及JSON查看；HTTPfake');
add('settings-catalog-controls-browser',350,'SETTING:45,46,48','实际旧版七种页类型、21布局选项、随机参与开关、全部参数、增改删取消/确认、50条上限、初始失败禁空PUT和保存503草稿保持/重试；HTTPfake仅兼容配置');
add('user-auto-assignment-browser',80,'USER:16,22-24','实际总开关失败/开关/取消、定量3/5及5/5请求、空池禁派、CONTINUOUS确认与可补/满额/统计；完成后持续补位的UI快照fake，后台实际补1/上限/停补另真PG');
add('knowledge-analysis-browser',36,'KNOW:6,7','实际10Prompt满额替换目标与失败保留/取消/确认、模型分析费用确认/取消/忙碌/错误输入保留/重试自动入库；模型仅HTTPfake，真实模型调用另独立实测');
add('history-knowledge-failure-browser',42,'TRACE:2;IPREVIEW:11,12;KNOW:15','实际lazy历史503→retry、历史版本下拉/前后页和格式背景参数恢复、源图/成品预览与downloadbytes；真实KnowledgePage SSR服务失败和可见重载链接恢复；后端fake');
add('xhs-account-alert-browser',30,'EXEC:7','实际公共账号异常提示登录/CAPTCHA、关闭/相同状态保持关闭/下次状态变更再出现，真实两次轮询HTTPfake，唯读无POST');

const tapRecords=new Map();
const tapFiles=[];
for(const directory of [reportRoot,path.join(root,'reports/full-functional-2026-10-02-final')]){
  for(const name of await fs.readdir(directory).catch(()=>[])){
    // Evidence names can describe the controls rather than contain "browser".
    // Match exact executed test names below, never infer PASS from filenames.
    if(!/\.(?:tap|log)$/.test(name))continue;
    const file=path.join(directory,name), stat=await fs.stat(file), content=await fs.readFile(file,'utf8');
    // A long suite may finish writing after its targeted repair already passed.
    // Use the actual run start from its footer, or the log creation time for a
    // distinct named run; last-write ordering would resurrect old failures.
    let runStartMs=stat.birthtimeMs;
    try{const paired=JSON.parse(await fs.readFile(file.replace(/\.(?:tap|log)$/,'-summary.json'),'utf8'));if(paired.startedAt)runStartMs=Date.parse(paired.startedAt);}catch{}
    for(const line of content.split('\n')){try{const metadata=JSON.parse(line);if(metadata.startedAt&&Array.isArray(metadata.files))runStartMs=Date.parse(metadata.startedAt);}catch{}}
    tapFiles.push({file,mtime:stat.mtimeMs,runStartMs,content});
  }
}
tapFiles.sort((a,b)=>a.runStartMs-b.runStartMs||a.mtime-b.mtime);
for(const {file,content,runStartMs} of tapFiles){
  for(const match of content.matchAll(/^\s*(not )?ok \d+ - (.+)$/gm)){
    if(/# SKIP/.test(match[2]))continue;
    tapRecords.set(match[2],{status:match[1]?'FAIL':'PASS',log:path.relative(root,file).replaceAll('\\','/'),runStartedAt:new Date(runStartMs).toISOString()});
  }
  for(const match of content.matchAll(/^([✔✖]) (.+?) \([\d.]+ms\)$/gm)){
    tapRecords.set(match[2],{status:match[1]==='✔'?'PASS':'FAIL',log:path.relative(root,file).replaceAll('\\','/'),runStartedAt:new Date(runStartMs).toISOString()});
  }
}
const fileRuns=new Map();
for(const file of new Set(actions.map(action=>action.file))){
  const content=await fs.readFile(path.join(root,file),'utf8');
  const starts=[...content.matchAll(/test\(\s*'([^']+)'/g)];
  const interactive=starts.map((match,index)=>({match,end:starts[index+1]?.index??content.length})).filter(({match,end})=>/\.click\(|\.check\(|\.fill\(|\.press\(/.test(content.slice(match.index,end)) || file==='tests/workbench-route-empty-browser.test.mjs' && /\.goto\(/.test(content.slice(match.index,end))).map(({match,end})=>({name:match[1],startLine:content.slice(0,match.index).split('\n').length,endLine:content.slice(0,end).split('\n').length,...(tapRecords.get(match[1])??{status:'UNMATCHED'})}));
  fileRuns.set(file,interactive);
}
const realCases=[];
try{const p=path.join(reportRoot,'functional-auth-nav-supplement.json');const entry=JSON.parse(await fs.readFile(p,'utf8')).cases?.find(entry=>entry.id==='AN05');
  const expected={2:'/workbench/unassigned',3:'/workbench/all-copy',4:'/workbench/copy-review',5:'/workbench/images',6:'/workbench/manual-archive',8:'/workbench/all'};
  for(const [n,href]of Object.entries(expected))if(entry?.evidence?.visited?.some(row=>row.href===href))realCases.push({featureId:`F-VIEW-${String(n).padStart(3,'0')}`,caseId:'AN05',name:entry.name,status:entry.status,source:'reports/full-functional-2026-10-02/functional-auth-nav-supplement.json',scope:'从桌面可见导航实际点击对应作业视图，核对当前位置；具体状态成员由HTTP/数据库和列表筛选另测，导航不等于全部列表行为通过。',evidenceType:'UI_REAL_ISOLATED',completeness:'PARTIAL_FEATURE'});
}catch{ }
for(const directory of [reportRoot]){
  for(const name of ['functional-100-results.json','functional-browser-retests.json','functional-browser-crud-date-retests.json','functional-admin-supplement.json','functional-prompt-supplement.json','report-supplement-results.json','image-controls-supplement-results.json','auth-nav-supplement-results.json','functional-auth-nav-supplement.json','functional-assignment-supplement.json','functional-list-filter-supplement.json','functional-task-report-supplement.json','functional-delivery-filter-supplement.json','functional-boundary-supplement.json','functional-statistics-supplement.json','functional-compatibility-route-supplement.json']){
    const p=path.join(directory,name);try{const content=JSON.parse(await fs.readFile(p,'utf8'));
      for(const entry of content.cases??[])for(const id of entry.featureIds??[])realCases.push({featureId:id,caseId:entry.id,name:entry.name,status:entry.status,source:path.relative(root,p).replaceAll('\\','/'),evidenceType:'UI_REAL_ISOLATED',completeness:'PARTIAL_FEATURE'});
    }catch{ /* Optional evidence has not been produced yet. */ }
  }
}
try{const p=path.join(reportRoot,'functional-assignment-supplement.json');const entry=JSON.parse(await fs.readFile(p,'utf8')).cases?.find(entry=>entry.id==='AS03');
  if(entry)realCases.push({featureId:'F-LIST-025',caseId:entry.id,name:entry.name,status:entry.status,source:path.relative(root,p).replaceAll('\\','/'),scope:'列表实际选择两条不同归属任务，批量目标选择、取消、真实分配与恢复；部分失败由独立HTTPfixture验证',evidenceType:'UI_REAL_ISOLATED',completeness:'PARTIAL_FEATURE'});
}catch{}
// F064 actually clicks all four settings tabs and keyboard Home/End, even
// though its optional save lookup finds no matching central save button.
for(const directory of [reportRoot]){
  const p=path.join(directory,'functional-100-results.json');try{const entry=JSON.parse(await fs.readFile(p,'utf8')).cases?.find(entry=>entry.id==='F064');
    if(entry)realCases.push({featureId:'F-SETTING-001',caseId:'F064',name:entry.name,status:entry.status,source:path.relative(root,p).replaceAll('\\','/'),scope:'实际点击四分区与Home/End导航，不宣称本项保存全部参数。',evidenceType:'UI_REAL_ISOLATED',completeness:'PARTIAL_FEATURE'});
  }catch{ }
}
const previewMap={'PV-01':[1],'PV-02':[2,3,4,5,6],'PV-03':[7,8,9,10,11],'PV-04':[12,13,14,15],'PV-05':[22,23,25],'PV-06':[17,18,19],'PV-07':[21,24],'PV-08':[16,24],'PV-09':[20],'PV-10':[1],'PV-11':[3,4,10],'PV-12':[18,21]};
for(const directory of [reportRoot]){
  try{const map=JSON.parse(await fs.readFile(path.join(directory,'feature-evidence-map.json'),'utf8'));
    for(const feature of map.features??[])for(const evidence of feature.browser??[]){
      const source=path.join(directory,evidence.source);let actual=evidence.caseStatus;
      try{actual=JSON.parse(await fs.readFile(source,'utf8')).cases?.find(entry=>entry.id===evidence.caseId)?.status??'UNMATCHED';}catch{actual='UNMATCHED';}
      realCases.push({featureId:feature.id,caseId:evidence.caseId,name:evidence.name,status:actual,source:path.relative(root,source).replaceAll('\\','/'),scope:evidence.verifiedScope,evidenceType:'UI_REAL_ISOLATED',completeness:evidence.completeness??'PARTIAL_FEATURE'});
    }
  }catch{ /* The independent 100-record evidence contribution map is optional. */ }
}
try{const p=path.join(reportRoot,'preview/results.json');const preview=JSON.parse(await fs.readFile(p,'utf8'));for(const entry of preview.cases??[])for(const n of previewMap[entry.id]??[])realCases.push({featureId:`F-PREVIEW-${String(n).padStart(3,'0')}`,caseId:entry.id,name:entry.name,status:entry.status,source:'reports/full-functional-2026-10-02/preview/results.json',evidenceType:entry.id==='PV-07'?'API_PREVIEW_ISOLATED':'UI_PREVIEW_ISOLATED',completeness:'PARTIAL_FEATURE'});}catch{ /* Independent preview evidence may not exist yet. */ }
const createGateFile='server/tests/skip-copy-review.test.mjs';
const createGateNames=[...((await fs.readFile(path.join(root,createGateFile),'utf8')).matchAll(/test\(\s*'([^']+)'/g))].map(match=>match[1]);
const createGateEvidence=createGateNames.map(name=>({file:createGateFile,name,evidenceType:'BACKEND_HTTP_OR_REPOSITORY_FAKE',...(tapRecords.get(name)??{status:'UNMATCHED'})}));
createGateEvidence.push({file:'server/tests/modular-workflow-postgres.e2e.test.mjs',name:'real PostgreSQL 18 modular workflow reaches the delivery pool after blind QA and mandatory recheck',evidenceType:'BACKEND_REAL_ISOLATED_PG_HTTP',...(tapRecords.get('real PostgreSQL 18 modular workflow reaches the delivery pool after blind QA and mandatory recheck')??{status:'UNMATCHED'})});
const features=rows.map(row=>{
  const fixture=actions.filter(action=>action.featureId===row.id).map(action=>({...action,executedTests:fileRuns.get(action.file).filter(test=>action.line>=test.startLine&&action.line<=test.endLine)}));
  const realByCase=new Map();
  for(const entry of realCases.filter(entry=>entry.featureId===row.id)){
    const key=[entry.source,entry.caseId,entry.status].join('::');
    const prior=realByCase.get(key);if(!prior||entry.scope)realByCase.set(key,entry);
  }
  const real=[...realByCase.values()];
  const hasPass=real.some(entry=>entry.status==='PASS')||fixture.some(action=>action.executedTests.length>0&&action.executedTests.every(test=>test.status==='PASS'));
  const currentHidden=/不适用|未挂载/.test(row.inventoryStatus);
  const testedLocal=currentHidden&&/^F-SETTING-0(?:1[2-9]|2[0-3])$/.test(row.id)&&hasPass;
  const backend=row.id==='F-CREATE-008'?createGateEvidence:[];
  return{...row,status:testedLocal?'CONDITIONAL_LOCAL_UI_PASS_EVIDENCE':currentHidden?'NOT_APPLICABLE_CURRENT_UI':hasPass?'PARTIAL_BROWSER_PASS_EVIDENCE':fixture.length||real.length?'AWAITING_PASS_OR_FINAL_MATCH':'NO_BROWSER_ACTION_EVIDENCE',fixture,real,backend,
    limitation:'仅列实际点击/输入范围；复合用例的全部选项、异常和权限仍需逐分支审阅。route load 和源码合约不计 UI 动作。'};
});
const counts=Object.fromEntries([...new Set(features.map(row=>row.status))].map(status=>[status,features.filter(row=>row.status===status).length]));
let latestSuite=null;
for(const {file,content}of tapFiles)for(const line of content.split('\n')){try{const item=JSON.parse(line);if(Array.isArray(item.files)&&item.files.length>=50&&typeof item.tests==='number'&&(!latestSuite||Date.parse(item.startedAt)>Date.parse(latestSuite.startedAt)))latestSuite={...item,log:path.relative(root,file).replaceAll('\\','/')};}catch{}}
let executionSummary=null;
if(latestSuite){
  const suite=tapFiles.find(entry=>path.relative(root,entry.file).replaceAll('\\','/')===latestSuite.log);
  const originalFailures=[...suite.content.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map(match=>match[1]);
  const resolution=originalFailures.map(name=>({name,originalStatus:'FAIL',latest:tapRecords.get(name)??{status:'UNMATCHED'}}));
  executionSummary={suiteStartedAt:latestSuite.startedAt,suiteFinishedAt:latestSuite.finishedAt,rawLog:latestSuite.log,tests:latestSuite.tests,originalPassed:latestSuite.passed,originalFailed:latestSuite.failed,skipped:latestSuite.skipped,resolution,unresolvedFailures:resolution.filter(item=>item.latest.status!=='PASS').length,notice:'保留统一运行原始失败；按同名测试后续定点复测合并，不将原始87/1写成当次88/0。'};
}
const result={generatedAt:new Date().toISOString(),total:features.length,notice:'这是动作贡献审计，PARTIAL 不代表整个功能通过；UI_FIXTURE使用HTTP假数据，UI_REAL_ISOLATED才操作临时真实服务，均不能宣称真实模型。',counts,executionSummary,sources:tapFiles.map(v=>path.relative(root,v.file).replaceAll('\\','/')),features};
await fs.writeFile(path.join(reportRoot,'browser-feature-action-audit.json'),JSON.stringify(result,null,2));
const md=['# 页面功能与浏览器动作证据审计（2026-10-02）','',result.notice,'',`当前稳定清单 ${features.length} 行；${Object.entries(counts).map(([k,v])=>`${k} ${v}`).join('，')}。状态由执行TAP和真实UI证据合并产生，不据测试文件名判断通过。`,'',
  ...(executionSummary?[`最终统一浏览器运行 ${executionSummary.tests} 项，原始 ${executionSummary.originalPassed} 通过、${executionSummary.originalFailed} 失败；同名后续定点复测后未解决失败 ${executionSummary.unresolvedFailures}。原日志为 ${executionSummary.rawLog}；修复复测为 ${executionSummary.resolution.map(item=>`${item.latest.log} (${item.latest.status})`).join('，')}。原始失败保留，没有冒称当次统一运行全部通过。`,'']:[]),
  '| 功能ID | 页面功能 | 动作证据 | 当前证据状态 |','| --- | --- | --- | --- |',...features.map(row=>`| ${row.id} | ${row.operation.replaceAll('|','/')} | ${[...row.fixture.map(action=>`${action.file}:${action.line}`),...row.real.map(entry=>`${entry.source}#${entry.caseId}(${entry.status})`)].join('<br>')||'无实际浏览器动作关联'} | ${row.status} |`),
  '', '## 当前页面边界', '', '- 词包页面无重命名或废弃恢复入口；搜索节点页面仅展示信息与安全移除，未挂载新增/编辑。',
  '- 个人统计日期按钮为今天、昨天、近7天和自定义；30天参数应通过自定义测试，不虚构额外按钮。',
  '- 任务报表查询方案CRUD弹窗没有打开入口，列为未挂载而非已测；对应API测试不能替代UI。',
  '- 屏幕取色浏览器回归使用EyeDropper假实现，证明UI分支，不代表设备真实桌面取色；第三方模型和发布须查看独立实测证据。',
  '- 已存在source-only旧图文审核/旧文案QA入口退役，应以当前负责人图片初审和文案V2功能为准。',
  '', '未覆盖行可在 browser-feature-action-audit.json 按 NO_BROWSER_ACTION_EVIDENCE 筛选；已有部分证据仍需对照 scope 逐分支核实，不能将整组参数一键标通过。'];
await fs.writeFile(path.join(root,'docs/full-functional-browser-action-audit-2026-10-02.md'),md.join('\n')+'\n');
console.log(JSON.stringify({total:features.length,counts,artifact:'reports/full-functional-2026-10-02/browser-feature-action-audit.json'}));
