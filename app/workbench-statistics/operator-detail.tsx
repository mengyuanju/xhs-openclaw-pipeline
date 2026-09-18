'use client';
import { useEffect,useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Dialog,DialogContent,DialogTitle,DialogDescription } from '@/components/ui/dialog';
import { apiRequest } from '../components/api-client';
import { Chart,duration } from './shared';
import { OPERATOR_API } from './use-operator-performance';
import type { OperatorDetail,OperatorReport,Rate,StagePerformance } from './operator-types';
import styles from './operator-performance.module.css';

export const RATE_LABEL=(rate:Rate)=>rate.rate===null?'—':`${(rate.rate*100).toFixed(1)}%`;
export const STAGE_LABEL={COPY:'文案',IMAGE:'图片'};
const time=(value:string)=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
const KINDS:Record<string,string>={SUBMIT:'阶段提交',QUALITY:'质检结论',RETURN:'终审返工',RELEASE:'最终放行',DELIVERY:'交付确认',SAMPLE:'抽样记录',BATCH_RETURN:'批次退回影响',PENDING:'等待质检',EXCLUDED:'非有效审核样本'};
const PHASES:Record<string,string>={HUMAN:'可人工处理',BACKGROUND:'等待后台结果',MACHINE_QUEUE:'机器排队',MACHINE_RUNNING:'机器执行',QUALITY_WAIT:'等待质检/批次',UNASSIGNED:'待分配',CLOSED:'本阶段结束'};
export const EXCLUSIONS:Record<string,string>={BYPASS:'免人工审核',SIMULATED:'模拟数据',ADMIN_DIRECT:'管理员快捷直放',SELF_REVIEW:'自检',UNKNOWN_IDENTITY:'身份未确认',NOT_SELECTED:'未抽中',BATCH_AFFECTED:'批次退回影响',NO_VERDICT:'无有效结论'};
const METRICS:Record<string,string>={all:'全部事件',submitted:'阶段提交',firstPass:'首轮质检',recheck:'强制复检',firstRecheck:'首次返修复检',delivered:'交付确认',returned:'实际退回',reworked:'返修提交',released:'首次最终放行',batchAffected:'批次退回影响',excluded:'排除样本',pending:'当前待质检'};

function StageCard({stage,data}:{stage:'COPY'|'IMAGE';data:StagePerformance}) {
  return <article className={styles.detailCard}><h3>{STAGE_LABEL[stage]}质量与效率</h3><dl>
    <dt>首轮通过率</dt><dd>{RATE_LABEL(data.firstPass)}（{data.firstPass.passed}/{data.firstPass.decided}）</dd>
    <dt>强制复检通过率</dt><dd>{RATE_LABEL(data.recheck)}（{data.recheck.passed}/{data.recheck.decided}）</dd>
    <dt>首个返修复检通过率</dt><dd>{RATE_LABEL(data.firstRecheck)}（{data.firstRecheck.passed}/{data.firstRecheck.decided}）</dd>
    <dt>已结批首次提交的抽检覆盖</dt><dd>{data.coverage.rate===null?'—':`${(data.coverage.rate*100).toFixed(1)}%`}（{data.coverage.sampled}/{data.coverage.eligible}）</dd>
    <dt>尚无普通抽样记录</dt><dd>{data.coverage.unresolved} 条</dd>
    <dt>人工待办周转 · 中位数</dt><dd>{duration(data.duration.medianMs)}</dd>
    <dt>人工待办周转 · P90</dt><dd>{duration(data.duration.p90Ms)}</dd>
    <dt>完整时长样本 / 缺失</dt><dd>{data.duration.samples} / {data.duration.missing}</dd>
    <dt>提交到质检结论 · 中位数</dt><dd>{duration(data.qualityWait.medianMs)}</dd>
    <dt>当前待质检样本</dt><dd>{data.pending}</dd>
  </dl></article>;
}

export function OperatorDetailDialog({report,selection,onClose}:{report:OperatorReport;selection:{accountId:number;metric:string;stage:string};onClose:()=>void}) {
  const [metric,setMetric]=useState(selection.metric),[stage,setStage]=useState(selection.stage),[sampleSet,setSampleSet]=useState('all'),[page,setPage]=useState(1);
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
  return <Dialog open onOpenChange={open=>{if(!open)onClose();}}><DialogContent className={styles.dialog}>
    <div><DialogTitle>{data?.person.displayName??'作业人员'} · 质量与效率明细</DialogTitle>
      <DialogDescription className={styles.muted}>{report.range.from} 至 {report.range.to} · 报表时点 {time(report.asOf)} · 明细与原报表使用同一份样本</DialogDescription></div>
    {data && <><div className={styles.detailsGrid}><StageCard stage="COPY" data={data.person.COPY}/><StageCard stage="IMAGE" data={data.person.IMAGE}/></div>
      <p className={styles.muted}>返修提交 {data.person.reworkRounds} 次，返修总周转中位数 {duration(data.person.reworkDuration.medianMs)}；重复退回 {data.person.repeatedReturns} 项。首个复检只计可追溯至原随机抽检的返修链。周转时间包含自然等待，不代表操作工时。</p>
      <p className={styles.muted}>交付确认 {data.person.delivered} 项 / {data.person.deliveredBatches} 批，归属实际确认账号，不改变文案和图片提交贡献。</p>
      <details className={styles.methods}><summary>查看趋势、退回原因和当前待办</summary>
        <Chart label="人员每日提交和退回任务" labels={data.trend.map(day=>day.date.slice(5))} series={[
          {name:'提交任务',values:data.trend.map(day=>day.submitted)},{name:'退回任务',values:data.trend.map(day=>day.returned)}]}/>
        <p>主要退回原因：{data.person.reasons.length?data.person.reasons.map(item=>`${item.code}（${item.count} 次）`).join('、'):'暂无记录'}。同一退回可含多个原因。</p>
        {data.current.length?<ul>{data.current.map(task=><li key={task.taskId}>#{task.taskId} · {task.query} · {PHASES[task.phase]??task.phase} · {duration(task.waitingMs)}</li>)}</ul>:<p>报表时点没有当前待办。</p>}
      </details></>}
    <div className={styles.toolbar}>
      <label>明细范围 <select aria-label="明细范围" className={styles.selector} value={metric} onChange={event=>{setMetric(event.target.value);setPage(1);setSampleSet('all');}}>{Object.entries(METRICS).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
      <label>阶段 <select aria-label="明细阶段" className={styles.selector} value={stage} onChange={event=>{setStage(event.target.value);setPage(1);}}><option value="">全部阶段</option><option value="COPY">文案</option><option value="IMAGE">图片</option></select></label>
      {['firstPass','recheck','firstRecheck'].includes(metric)&&<label>结论 <select aria-label="质检结论" className={styles.selector} value={sampleSet} onChange={event=>{setSampleSet(event.target.value);setPage(1);}}><option value="all">全部已审样本</option><option value="passed">通过样本</option><option value="failed">退回样本</option></select></label>}
    </div>
    {error&&<div role="alert" className={`${styles.notice} ${styles.error}`}>{error}<Button variant="ghost" size="sm" onClick={()=>setRetry(value=>value+1)}>重试</Button></div>}
    {busy&&<p role="status" className={styles.muted}>正在读取对应任务和事件…</p>}
    {data&&<><p className={styles.muted}>共 {data.total} 条事件。任务数按任务去重；同一任务可能有多个提交或审核事件。</p><div className={styles.events}>
      {data.items.map(item=><article className={styles.event} key={item.id}><header><strong>#{item.taskId} · {STAGE_LABEL[item.stage]} · {KINDS[item.kind]??item.kind}</strong>
        <span className={item.outcome==='RETURN'?styles.bad:styles.good}>{item.outcome==='PASS'?'通过':item.outcome==='RETURN'?'退回':item.rework?'返修提交':''}</span></header>
        <p>{item.query}</p><small>{time(item.at)} · 提交人 {item.displayName||item.username||'身份未确认'}{item.reviewerId?` · 质检账号 #${item.reviewerId}`:''}</small>
        {item.exclusion&&<p>排除原因：{EXCLUSIONS[item.exclusion]??item.exclusion}</p>}
        {item.kind==='QUALITY'&&<p>{item.sampleKind==='MANDATORY_RECHECK'?'强制复检':item.first?'首轮随机抽检':'后续随机抽检'}{item.target?` · 整改范围 ${item.target==='BOTH'?'文案与图片':STAGE_LABEL[item.target as 'COPY'|'IMAGE']??item.target}`:''}</p>}
        {!!item.reasons?.length&&<p>退回原因：{item.reasons.join('、')}</p>}
        {item.timing&&<p>本人可处理时段：{duration(item.timing.humanMs)} · 后台/机器等待：{duration(item.timing.backgroundMs)}{item.timing.reason?' · 历史起点或本人时段不完整':''}</p>}
        <details><summary>版本与处理时间线</summary><p>文案版本 {item.copyRevisionId??'—'} · 图片版本 {item.imageRunId??'—'}</p>
          <ul>{data.timeline.filter(point=>point.taskId===item.taskId).map(point=><li key={point.id}>{time(point.at)} · {PHASES[point.phase]??point.phase} · 负责人 {point.accountId?`#${point.accountId}`:'未分配'}{point.baseline?'（开始采集，之前时长未知）':''}</li>)}</ul>
          {item.canOpen===false?<span className={styles.muted}>任务已删除，保留历史统计依据</span>:<Link href={`/workbench/all?taskId=${item.taskId}`} className={styles.link}>打开当前任务</Link>}</details>
      </article>)}
      {!data.items.length&&<p className={styles.empty}>该范围没有符合条件的记录</p>}
    </div><div className={styles.pagination}><span>第 {data.page} 页 / 共 {Math.max(1,Math.ceil(data.total/data.pageSize))} 页</span><div className={styles.actions}>
      <Button variant="outline" size="sm" disabled={busy||data.page<=1} onClick={()=>setPage(data.page-1)}>上一页</Button>
      <Button variant="outline" size="sm" disabled={busy||data.page*data.pageSize>=data.total} onClick={()=>setPage(data.page+1)}>下一页</Button></div></div></>}
  </DialogContent></Dialog>;
}
