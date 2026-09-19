'use client';
import { useEffect,useId,useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Dialog,DialogContent,DialogTitle,DialogDescription } from '@/components/ui/dialog';
import { apiRequest } from '../components/api-client';
import { Chart,duration } from './shared';
import { OPERATOR_API } from './use-operator-performance';
import type { OperatorDetail,OperatorReport,OperatorSummary,Rate,StagePerformance } from './operator-types';
import styles from './operator-performance.module.css';
import ui from './operator-detail.module.css';

export const RATE_LABEL=(rate:Rate)=>rate.rate===null?'—':`${(rate.rate*100).toFixed(1)}%`;
export const STAGE_LABEL={COPY:'文案',IMAGE:'图片'};
const time=(value:string)=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
const KINDS:Record<string,string>={SUBMIT:'阶段提交',QUALITY:'质检结论',RETURN:'终审返工',RELEASE:'最终放行',DELIVERY:'交付确认',SAMPLE:'抽样记录',BATCH_RETURN:'批次退回影响',PENDING:'等待质检',EXCLUDED:'非有效审核样本'};
const PHASES:Record<string,string>={HUMAN:'可人工处理',BACKGROUND:'等待后台结果',MACHINE_QUEUE:'机器排队',MACHINE_RUNNING:'机器执行',QUALITY_WAIT:'等待质检/批次',UNASSIGNED:'待分配',CLOSED:'本阶段结束'};
export const EXCLUSIONS:Record<string,string>={BYPASS:'免人工审核',SIMULATED:'模拟数据',ADMIN_DIRECT:'管理员快捷直放',SELF_REVIEW:'自检',UNKNOWN_IDENTITY:'身份未确认',NOT_SELECTED:'未抽中',BATCH_AFFECTED:'批次退回影响',NO_VERDICT:'无有效结论'};
const METRICS:Record<string,string>={all:'全部事件',submitted:'阶段提交',firstPass:'首轮质检',recheck:'强制复检',firstRecheck:'首次返修复检',delivered:'交付确认',returned:'实际退回',reworked:'返修提交',released:'首次最终放行',batchAffected:'批次退回影响',excluded:'排除样本',pending:'当前待质检'};
Object.assign(KINDS,{QA_REVIEW:'质检结论',QA_BATCH_RETURN:'批量退回操作',QA_DIRECT_PASS:'快捷直放',QA_DISCARD:'质检废弃',QA_PENDING:'质检待办'});
Object.assign(METRICS,{contributed:'参与处理作业',qaAll:'全部质检记录',qa:'质检结论',qaRecheck:'质检复检',qaBatch:'批量退回操作',qaSpecial:'快捷直放与废弃',qaPending:'可处理质检待办',qaBlocked:'暂不可处理质检'});
Object.assign(METRICS,{firstSubmitted:'首次标注提交',reassign:'当前建议改派'});
Object.assign(KINDS,{REASSIGN:'建议改派'});

function StageCard({stage,data}:{stage:'COPY'|'IMAGE';data:StagePerformance}) {
  const hasSamples=data.firstPass.decided+data.recheck.decided+data.firstRecheck.decided+data.coverage.eligible
    +data.coverage.unresolved+data.duration.samples+data.duration.missing+data.qualityWait.samples+data.pending>0;
  return <article className={ui.qualityCard}><header><h3>{STAGE_LABEL[stage]}质量与效率</h3><span>{data.submitted} 项提交</span></header>
    {hasSamples?<><dl className={ui.metricList}>
      {([['一次通过率',data.firstPass],['强制复检通过率',data.recheck],['首次返修通过率',data.firstRecheck]] as const).map(([label,rate])=><div key={label}><dt>{label}</dt><dd>{rate.decided?<><strong>{RATE_LABEL(rate)}</strong><small>{rate.passed} / {rate.decided} 已审</small></>:<span className={styles.muted}>暂无已审样本</span>}</dd></div>)}
      <div><dt>人工待办周转 · 中位数</dt><dd>{duration(data.duration.medianMs)}</dd></div>
      <div><dt>提交到质检结论 · 中位数</dt><dd>{duration(data.qualityWait.medianMs)}</dd></div>
      <div><dt>当前待质检样本</dt><dd>{data.pending} 条</dd></div>
    </dl><details className={ui.disclosure}><summary>抽检覆盖与时长样本</summary><dl className={ui.metricList}>
      <div><dt>已结批首次提交的抽检覆盖</dt><dd>{data.coverage.rate===null?'暂无样本':`${(data.coverage.rate*100).toFixed(1)}%`}<small>{data.coverage.sampled} / {data.coverage.eligible}</small></dd></div>
      <div><dt>尚无普通抽样记录</dt><dd>{data.coverage.unresolved} 条</dd></div>
      <div><dt>人工待办周转 · P90</dt><dd>{duration(data.duration.p90Ms)}</dd></div>
      <div><dt>完整时长样本 / 缺失</dt><dd>{data.duration.samples} / {data.duration.missing}</dd></div>
    </dl></details></>:<p className={ui.noSamples}>当前范围暂无标注质量与时效样本。</p>}
  </article>;
}

function Summary({person,qa}:{person:OperatorSummary;qa:boolean}) {
  const cards=qa?[
    {label:'已质检作业',value:person.qa.tasks,unit:'项',note:'提交过通过或退回结论 · 去重'},
    {label:'质检结论',value:person.qa.reviews,unit:'次',note:`文案 ${person.qa.COPY.reviews} · 图片 ${person.qa.IMAGE.reviews} · 含复检 ${person.qa.rechecks}`},
    {label:'通过 / 退回',value:`${person.qa.passed} / ${person.qa.returned}`,unit:'次',note:'按实际质检结论统计'},
    {label:'当前可质检',value:person.qa.pending,unit:'项',note:`另有 ${person.qa.blocked} 项暂不可处理`},
  ]:[
    {label:'参与处理作业',value:person.contributed,unit:'项',note:'标注提交与质检合并去重'},
    {label:'阶段提交',value:person.submissions,unit:'次',note:`文案 ${person.COPY.submitted} 项 · 图片 ${person.IMAGE.submitted} 项`},
    {label:'首次最终放行',value:person.released,unit:'项',note:`返修提交 ${person.reworkRounds} 次`},
    {label:'交付确认',value:person.delivered,unit:'项',note:`共 ${person.deliveredBatches} 批`},
  ];
  return <div className={ui.summary}>{cards.map(card=><div key={card.label}><span>{card.label}</span><div><strong>{card.value}</strong><span>{card.unit}</span></div><small>{card.note}</small></div>)}</div>;
}

function QualityPanel({person}:{person:OperatorSummary}) {
  return <div className={ui.panelSections}>
    <section><div className={ui.sectionHeading}><h3>标注质量与时效</h3><p>通过率归属内容提交人；周转包含自然等待。</p></div>
      <div className={ui.twoColumns}><StageCard stage="COPY" data={person.COPY}/><StageCard stage="IMAGE" data={person.IMAGE}/></div>
    </section>
    <section><div className={ui.sectionHeading}><h3>质检操作</h3><p>按实际操作账号统计，文案与图片合并去重。</p></div>
      <div className={ui.factGrid}>
        <div><span>已质检作业</span><strong>{person.qa.tasks} <small>项</small></strong></div>
        <div><span>文案 / 图片质检</span><strong>{person.qa.COPY.reviews} / {person.qa.IMAGE.reviews} <small>次</small></strong></div>
        <div><span>通过 / 退回</span><strong>{person.qa.passed} / {person.qa.returned} <small>次</small></strong></div>
        <div><span>其中复检</span><strong>{person.qa.rechecks} <small>次</small></strong></div>
      </div>
      <details className={ui.disclosure}><summary>批量操作与专项处置</summary>
        <dl className={ui.metricList}>
          <div><dt>批量退回</dt><dd>{person.qa.batchActions} 次<small>已知影响 {person.qa.affectedTasks} 项作业</small></dd></div>
          <div><dt>快捷直放 / 质检废弃</dt><dd>{person.qa.directPass} / {person.qa.discarded} 次</dd></div>
        </dl>
        {(person.qa.unknownBatchScopes>0||person.qa.legacyAffectedCount>0)&&<p className={styles.muted}>{person.qa.unknownBatchScopes} 次历史操作缺少完整范围，已记录 {person.qa.legacyAffectedCount} 影响项次。</p>}
        <p className={styles.muted}>批量影响、快捷直放和废弃不计入逐项质检结论。</p>
      </details>
    </section>
    <section><div className={ui.sectionHeading}><h3>返修与交付</h3></div><div className={ui.factGrid}>
      <div><span>返修提交</span><strong>{person.reworkRounds} <small>次</small></strong></div>
      <div><span>返修周转中位数</span><strong>{duration(person.reworkDuration.medianMs)}</strong></div>
      <div><span>重复退回</span><strong>{person.repeatedReturns} <small>项</small></strong></div>
      <div><span>交付确认</span><strong>{person.delivered} <small>项 / {person.deliveredBatches} 批</small></strong></div>
    </div></section>
    <details className={ui.disclosure}><summary>统计口径说明</summary><p>首次返修复检只计可追溯至原随机抽检的返修链。周转时间包含自然等待，不代表操作工时。</p><p>交付归属实际确认账号，不改变文案和图片提交贡献。明细与原报表使用同一份样本。</p></details>
  </div>;
}

const VIEWS=[['events','操作明细'],['quality','质量与时效'],['trends','趋势与待办']] as const;

export function OperatorDetailDialog({report,selection,onClose}:{report:OperatorReport;selection:{accountId:number;metric:string;stage:string;sampleSet?:string};onClose:()=>void}) {
  const dialogId=useId();
  const [view,setView]=useState<(typeof VIEWS)[number][0]>('events');
  const [metric,setMetric]=useState(selection.metric),[stage,setStage]=useState(selection.stage),[sampleSet,setSampleSet]=useState(selection.sampleSet??'all'),[page,setPage]=useState(1);
  const [data,setData]=useState<OperatorDetail|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[retry,setRetry]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();let disposed=false;
    const timeout=setTimeout(()=>controller.abort(),30_000);
    setBusy(true);setError('');setData(null);
    const search=new URLSearchParams({snapshotToken:report.snapshotToken,metric,stage,sampleSet,page:String(page),pageSize:'15'});
    const path=selection.accountId?`${selection.accountId}/tasks`:'tasks';
    void apiRequest<OperatorDetail>(`${OPERATOR_API}/${path}?${search}`,{signal:controller.signal,cache:'no-store'})
      .then(next=>{if(!next?.person||!Array.isArray(next.items))throw Error('明细数据不完整');if(!disposed)setData(next);})
      .catch(caught=>{if(!disposed)setError(controller.signal.aborted?'明细读取超时，请重试':caught instanceof Error?caught.message:'明细读取失败');})
      .finally(()=>{clearTimeout(timeout);if(!disposed)setBusy(false);});
    return()=>{disposed=true;controller.abort();clearTimeout(timeout);};
  },[report.snapshotToken,selection.accountId,metric,stage,sampleSet,page,retry]);
  const listedPerson=report.people.items.find(person=>person.accountId===selection.accountId);
  const person=data?.person??(selection.accountId?listedPerson:report.summary);
  const name=data?.person.displayName??(selection.accountId?listedPerson?.displayName??'标注':'团队');
  const qaContext=metric.startsWith('qa')||report.filters?.activity==='QA';
  return <Dialog open onOpenChange={open=>{if(!open)onClose();}}><DialogContent className={ui.dialog}>
    <header className={ui.header}><DialogTitle className={ui.title}>{name} · 质量与效率明细</DialogTitle>
      <DialogDescription className={ui.description}><span>{report.range.from} 至 {report.range.to}</span><span>报表时点 {time(report.asOf)}</span></DialogDescription>
    </header>
    {person&&<Summary person={person} qa={qaContext}/>}
    <div className={ui.tabs} role="tablist" aria-label="明细视图">{VIEWS.map(([key,label],index)=><button key={key} type="button" role="tab" id={`${dialogId}-${key}-tab`} aria-controls={`${dialogId}-${key}-panel`} aria-selected={view===key} tabIndex={view===key?0:-1}
      onClick={()=>setView(key)} onKeyDown={event=>{
        const next=event.key==='ArrowRight'?(index+1)%VIEWS.length:event.key==='ArrowLeft'?(index+VIEWS.length-1)%VIEWS.length:event.key==='Home'?0:event.key==='End'?VIEWS.length-1:null;
        if(next===null)return;event.preventDefault();setView(VIEWS[next][0]);
        document.getElementById(`${dialogId}-${VIEWS[next][0]}-tab`)?.focus();
      }}>{label}</button>)}</div>
    <div className={ui.body} key={view} role="tabpanel" id={`${dialogId}-${view}-panel`} aria-labelledby={`${dialogId}-${view}-tab`} tabIndex={0}>
    {view==='events'&&<div className={ui.filters}>
      <label>明细范围 <select aria-label="明细范围" className={styles.selector} value={metric} onChange={event=>{setMetric(event.target.value);setPage(1);setSampleSet('all');}}>{Object.entries(METRICS).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
      <label>阶段 <select aria-label="明细阶段" className={styles.selector} value={stage} onChange={event=>{setStage(event.target.value);setPage(1);}}><option value="">全部阶段</option><option value="COPY">文案</option><option value="IMAGE">图片</option></select></label>
      {['firstPass','recheck','firstRecheck','qa','qaRecheck'].includes(metric)&&<label>结论 <select aria-label="质检结论" className={styles.selector} value={sampleSet} onChange={event=>{setSampleSet(event.target.value);setPage(1);}}><option value="all">全部结论</option><option value="passed">通过样本</option><option value="failed">退回样本</option></select></label>}
    </div>}
    {error&&<div role="alert" className={`${styles.notice} ${styles.error}`}>{error}<Button variant="ghost" size="sm" onClick={()=>setRetry(value=>value+1)}>重试</Button></div>}
    {busy&&<p role="status" className={styles.muted}>正在读取对应任务和事件…</p>}
    {data&&view==='events'&&<><p className={ui.resultCount}>共 {data.total} 条事件。<span>同一作业可包含多条记录</span></p><div className={ui.events}>
      {data.items.map(item=><article className={ui.event} key={item.id}><header><div className={ui.eventIdentity}><strong>{item.taskId?`#${item.taskId}`:'批量操作'}</strong><span className={ui.stageBadge}>{STAGE_LABEL[item.stage]}</span><span>{KINDS[item.kind]??item.kind}</span></div>
        {(item.outcome==='PASS'||item.outcome==='RETURN'||item.rework)&&<span className={`${ui.verdict} ${item.outcome==='RETURN'?ui.returned:ui.passed}`}>{item.outcome==='PASS'?'通过':item.outcome==='RETURN'?'退回':'返修提交'}</span>}</header>
        <h3 className={ui.eventQuery}>{item.query||'批量质检操作'}</h3><div className={ui.eventMeta}><span>{item.at?time(item.at):'时间未记录'}</span><span>{item.kind.startsWith('QA_')?'操作／指派账号':'提交人'} {item.displayName||item.username||'身份未确认'}{item.reviewerId?` · 质检账号 #${item.reviewerId}`:''}</span></div>
        {item.kind==='QA_PENDING'&&<p>{item.blocked?'暂不可处理：暂停或权限变化':item.passBlocked?'图片修改待完成：仍可退回，暂不能通过':'当前可处理'}</p>}
        {item.kind==='QA_BATCH_RETURN'&&<p>影响数量 {item.affectedCount??'未记录'}；{Array.isArray(item.affectedTaskIds)?`作业 ${item.affectedTaskIds.map(id=>`#${id}`).join('、')}`:'历史完整范围未保留，不推算逐项质检次数'}</p>}
        {item.exclusion&&<p>排除原因：{EXCLUSIONS[item.exclusion]??item.exclusion}</p>}
        {['QUALITY','QA_REVIEW'].includes(item.kind)&&<p>{item.sampleKind==='MANDATORY_RECHECK'?'强制复检':item.kind==='QA_REVIEW'?'随机抽检':item.first?'首轮随机抽检':'后续随机抽检'}{item.target?` · 整改范围 ${item.target==='BOTH'?'文案与图片':STAGE_LABEL[item.target as 'COPY'|'IMAGE']??item.target}`:''}</p>}
        {['QUALITY','QA_REVIEW','REASSIGN'].includes(item.kind)&&<p className={ui.rounds}>{item.roundKnown?`第 ${item.reviewRound} 轮质检 · 本链路有效退回 ${item.returnRound} 次`:'历史轮次不明'}{item.outcome==='RETURN'&&item.roundKnown?` · 第 ${item.returnRound} 次返修`:''}{(item.consecutiveReturns??0)>0?` · 该标注连续退回 ${item.consecutiveReturns} 次`:''}</p>}
        {item.kind==='REASSIGN'&&<p>当前仍需该标注处理，已连续两次或更多次被有效退回。等待 {duration(item.waitingMs??null)}；请打开任务查看原因并决定是否改派。改派转移整条任务的标注责任，历史贡献保留。</p>}
        {!!item.reasons?.length&&<p>退回原因：{item.reasons.join('、')}</p>}
        {item.timing&&<p>本人可处理时段：{duration(item.timing.humanMs)} · 后台/机器等待：{duration(item.timing.backgroundMs)}{item.timing.reason?' · 历史起点或本人时段不完整':''}</p>}
        <div className={ui.eventFooter}><details><summary>版本与处理时间线</summary><p>文案版本 {item.copyRevisionId??'—'} · 图片版本 {item.imageRunId??'—'}</p>
          <ul>{data.timeline.filter(point=>point.taskId===item.taskId).map(point=><li key={point.id}>{time(point.at)} · {PHASES[point.phase]??point.phase} · 负责人 {point.accountId?`#${point.accountId}`:'未分配'}{point.baseline?'（开始采集，之前时长未知）':''}</li>)}</ul>
        </details>{item.taskId&&(item.canOpen===false?<span className={styles.muted}>任务已删除，保留历史统计依据</span>:<Link href={`/workbench/all?taskId=${item.taskId}`} className={styles.link}>打开当前任务 ↗</Link>)}</div>
      </article>)}
      {!data.items.length&&<p className={styles.empty}>该范围没有符合条件的记录</p>}
    </div></>}
    {person&&view==='quality'&&<QualityPanel person={person}/>}
    {data&&view==='trends'&&<div className={ui.panelSections}>
      <section><div className={ui.sectionHeading}><h3>每日变化</h3></div><div className={ui.twoColumns}>
        <article className={ui.chartCard}><h4>提交与退回作业</h4><Chart label="人员每日提交和退回任务" labels={data.trend.map(day=>day.date.slice(5))} series={[
          {name:'提交任务',values:data.trend.map(day=>day.submitted)},{name:'退回任务',values:data.trend.map(day=>day.returned)}]}/></article>
        <article className={ui.chartCard}><h4>质检结论</h4><Chart label="人员每日质检结论" unit="次" labels={data.trend.map(day=>day.date.slice(5))} series={[{name:'质检次数',values:data.trend.map(day=>day.qa)}]}/></article>
      </div></section>
      <section><div className={ui.sectionHeading}><h3>主要退回原因</h3><p>同一退回可包含多个原因。</p></div>
        {data.person.reasons.length?<ul className={ui.reasonList}>{data.person.reasons.map(item=><li key={item.code}><span>{item.code}</span><strong>{item.count} 次</strong></li>)}</ul>:<p className={styles.muted}>暂无退回原因记录</p>}
      </section>
      <section><div className={ui.sectionHeading}><h3>当前标注待办</h3><p>报表时点的任务与等待时长。</p></div>
        {data.current.length?<ul className={ui.currentList}>{data.current.map(task=><li key={task.taskId}><Link href={`/workbench/all?taskId=${task.taskId}`} className={styles.link}>#{task.taskId} · {task.query}</Link><span>{PHASES[task.phase]??task.phase} · {duration(task.waitingMs)}</span></li>)}</ul>:<p className={styles.muted}>报表时点没有当前标注待办。</p>}
        <p className={ui.waitingNote}>质检待办：{data.person.qa.pending} 项可处理，{data.person.qa.blocked} 项暂不可处理。</p>
      </section>
    </div>}
    </div>
    {view==='events'&&<footer className={ui.footer}><span>{data?`第 ${data.page} 页 / 共 ${Math.max(1,Math.ceil(data.total/data.pageSize))} 页`:error?'未获取到记录':'正在获取记录'}</span><div className={styles.actions}>
      <Button variant="outline" size="sm" disabled={busy||!data||data.page<=1} onClick={()=>setPage(page-1)}>上一页</Button>
      <Button variant="outline" size="sm" disabled={busy||!data||data.page*data.pageSize>=data.total} onClick={()=>setPage(page+1)}>下一页</Button></div></footer>}
  </DialogContent></Dialog>;
}
