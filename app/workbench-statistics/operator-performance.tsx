'use client';
import { useEffect,useState,type FormEvent } from 'react';
import dynamic from 'next/dynamic';
import { RefreshCw,Download,ArrowUpDown,UsersRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Chart,duration,number } from './shared';
import { useOperatorPerformance,OPERATOR_API } from './use-operator-performance';
import { EXCLUSIONS,OperatorDetailDialog,RATE_LABEL } from './operator-detail';
import type { OperatorPerson,OperatorReport,Rate } from './operator-types';
import styles from './operator-performance.module.css';

const FlowStatistics=dynamic(()=>import('./admin-statistics').then(module=>module.AdminStatistics),{loading:()=> <p>正在读取流程概况…</p>});
const defaultFilters={period:'30d',from:'',to:'',stage:'',query:'',accountId:'',batchId:'',page:'1',pageSize:'20',sort:'submitted',order:'desc'};
const filterKeys=Object.keys(defaultFilters);

function RateValue({value,onClick}:{value:Rate;onClick:()=>void}) {
  return <button className={`${styles.link} ${styles.rate}`} onClick={onClick}><strong>{RATE_LABEL(value)}</strong>
    <small>{value.decided?`${value.passed} / ${value.decided} 已审`:'无有效样本'}</small>
    {value.decided>0&&value.decided<20&&<small className={styles.sample}>样本较少</small>}</button>;
}
function Card({label,value,note,onClick}:{label:string;value:string;note:string;onClick?:()=>void}) {
  return <div className={styles.card}><span>{label}</span>{onClick?<button className={styles.link} onClick={onClick}><strong>{value}</strong></button>:<strong>{value}</strong>}<small>{note}</small></div>;
}

export function OperatorPerformance({initialFilters={}}:{initialFilters?:Record<string,string>}) {
  const [filters,setFilters]=useState<Record<string,string>>({...defaultFilters,...Object.fromEntries(Object.entries(initialFilters).filter(([key])=>filterKeys.includes(key)))});
  const [dateError,setDateError]=useState(''),[flowOpen,setFlowOpen]=useState(false);
  const [selection,setSelection]=useState<{accountId:number;metric:string;stage:string;report:OperatorReport}|null>(null);
  const {report,error,busy,refresh}=useOperatorPerformance(filters);
  const [exportError,setExportError]=useState(''),[exporting,setExporting]=useState(false);
  useEffect(()=>{
    const query=new URLSearchParams(Object.entries(filters).filter(([,value])=>value!==''));
    window.history.replaceState(null,'',`${window.location.pathname}?${query}`);
  },[filters]);
  useEffect(()=>{if(!report)setSelection(null);},[report]);
  const show=(accountId:number,metric='all',stage='')=>{if(report)setSelection({accountId,metric,stage,report});};
  function apply(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();const fields=new FormData(event.currentTarget);
    const from=String(fields.get('from')||''),to=String(fields.get('to')||'');
    if((from||to)&&(!from||!to||!Number.isFinite(Date.parse(from))||Date.parse(to)<Date.parse(from)||(Date.parse(to)-Date.parse(from))/86400000>=366)) {
      setDateError('自定义日期需填写完整，范围为 1–366 天');return;
    }
    setDateError('');setFilters(previous=>({...previous,from,to,period:from?'custom':previous.period==='custom'?'30d':previous.period,
      stage:String(fields.get('stage')||''),query:String(fields.get('query')||'').trim(),accountId:String(fields.get('accountId')||''),batchId:String(fields.get('batchId')||''),page:'1'}));
  }
  const sort=(key:string)=>setFilters(previous=>({...previous,sort:key,order:previous.sort===key&&previous.order==='desc'?'asc':'desc',page:'1'}));
  async function exportReport() {
    if(!report||exporting)return;setExporting(true);setExportError('');
    try{
      const response=await fetch(`${OPERATOR_API}/export?snapshotToken=${encodeURIComponent(report.snapshotToken)}`,{cache:'no-store',signal:AbortSignal.timeout(30_000)});
      if(!response.ok){const body=await response.json().catch(()=>null);throw Error(body?.error?.message||'导出失败，请刷新统计后重试');}
      const blob=await response.blob(),url=URL.createObjectURL(blob),anchor=document.createElement('a');
      anchor.href=url;anchor.download=`人员质量与效率_${report.range.from}_${report.range.to}.csv`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(caught){setExportError(caught instanceof Error?caught.message:'导出失败');}finally{setExporting(false);}
  }
  const summary=report?.summary;
  const columns=[['submitted','文案 / 图片提交'],['released','首次最终放行'],['copyRate','文案首轮通过率'],['imageRate','图片首轮通过率'],
    ['returned','退回 / 重复退回'],['copyMedian','文案周转中位数'],['imageMedian','图片周转中位数'],['pending','当前待办']] as const;
  function cells(person:OperatorPerson) {
    return <><td><button className={styles.link} onClick={()=>show(person.accountId,'submitted','COPY')}>{person.COPY.submitted}</button> / <button className={styles.link} onClick={()=>show(person.accountId,'submitted','IMAGE')}>{person.IMAGE.submitted}</button><small>{person.submissions} 次提交</small></td>
      <td><button className={styles.link} onClick={()=>show(person.accountId,'released')}>{person.released}</button><small>再次放行 {person.rereleased}</small></td>
      <td><RateValue value={person.COPY.firstPass} onClick={()=>show(person.accountId,'firstPass','COPY')}/></td>
      <td><RateValue value={person.IMAGE.firstPass} onClick={()=>show(person.accountId,'firstPass','IMAGE')}/></td>
      <td><button className={styles.link} onClick={()=>show(person.accountId,'returned')}>{person.returned} / {person.repeatedReturns}</button><small>返修提交 {person.reworkRounds} 次</small></td>
      <td><button className={styles.link} onClick={()=>show(person.accountId,'submitted','COPY')}>{duration(person.COPY.duration.medianMs)}</button><small>P90 {duration(person.COPY.duration.p90Ms)}</small></td>
      <td><button className={styles.link} onClick={()=>show(person.accountId,'submitted','IMAGE')}>{duration(person.IMAGE.duration.medianMs)}</button><small>P90 {duration(person.IMAGE.duration.p90Ms)}</small></td>
      <td>{person.pending}<small>超 24 小时 {person.longWaiting}</small></td></>;
  }
  return <div className={styles.page}>
    <header className={styles.header}><div><span className={styles.eyebrow}>TEAM PERFORMANCE</span><h1>作业人员质量与效率</h1><p className={styles.muted}>看完成量，也看提交质量与返修表现。历史成绩按实际提交人保留。</p></div>
      <div className={styles.actions}><Button variant="outline" size="sm" onClick={()=>setFlowOpen(value=>!value)}>{flowOpen?'收起流程概况':'生成与流程概况'}</Button>
        <Button variant="outline" size="sm" disabled={!report||exporting} onClick={()=>void exportReport()}><Download size={14}/>{exporting?'导出中…':'导出人员报表'}</Button>
        <Button size="sm" onClick={refresh} disabled={busy}><RefreshCw size={14}/>{busy?'更新中…':'刷新统计'}</Button></div></header>
    {flowOpen&&<details open className={`panel ${styles.section}`}><summary>当前分配与机器生成概况（独立统计口径）</summary><FlowStatistics/></details>}
    <form className={`panel ${styles.filters}`} onSubmit={apply} key={`${filters.period}:${filters.from}:${filters.to}`}>
      <div className={styles.presets}>{[['today','今日'],['7d','近 7 天'],['30d','近 30 天']].map(([value,label])=><Button key={value} variant="outline" size="sm" type="button" aria-pressed={filters.period===value}
        onClick={()=>{setDateError('');setFilters(previous=>({...previous,period:value,from:'',to:'',page:'1'}));}}>{label}</Button>)}</div>
      <DatePicker name="from" label="开始日期" defaultValue={filters.from}/><DatePicker name="to" label="结束日期" defaultValue={filters.to}/>
      <label>作业阶段<select name="stage" defaultValue={filters.stage}><option value="">全部阶段</option><option value="COPY">文案</option><option value="IMAGE">图片</option></select></label>
      <label className={styles.search}>作业人员<input name="query" aria-label="作业人员" placeholder="搜索姓名或账号" maxLength={128} defaultValue={filters.query}/></label>
      <label>账号 ID<input name="accountId" type="number" min="1" step="1" defaultValue={filters.accountId}/></label>
      <label>生产批次 ID<input name="batchId" type="number" min="1" step="1" defaultValue={filters.batchId}/></label><Button type="submit" size="sm">应用筛选</Button>
    </form>
    {dateError&&<div role="alert" className={`${styles.notice} ${styles.error}`}>{dateError}</div>}
    {error&&<div role="alert" className={`${styles.notice} ${styles.error}`}>{error}{report?'。以下保留上次成功的数据和范围，可能已过时。':'。尚未取得统计数据。'}</div>}
    {exportError&&<div role="alert" className={`${styles.notice} ${styles.error}`}>{exportError}</div>}
    {report&&<p role="status" className={styles.muted}>{report.range.from} 至 {report.range.to} · 北京时间 · 更新于 {new Date(report.asOf).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})} · 质量按结论日，提交按提交日，待办为当前状态</p>}
    {!report&&busy&&<p role="status">正在汇总人员提交、质检和处理记录…</p>}
    <section className={styles.cards} aria-label="团队表现总览">
      <Card label="期间参与完成作业" value={number(summary?.submitted)} note="文案与图片提交任务合并去重" onClick={()=>show(0,'submitted')}/>
      <Card label="期间首次最终放行" value={number(summary?.released)} note={`再次放行 ${number(summary?.rereleased)} 项；放行不等于已交付`} onClick={()=>show(0,'released')}/>
      <Card label="文案首轮质检通过率" value={summary?RATE_LABEL(summary.COPY.firstPass):'—'} note={summary?`${summary.COPY.firstPass.passed} / ${summary.COPY.firstPass.decided} 个已审样本`:'等待统计'} onClick={()=>show(0,'firstPass','COPY')}/>
      <Card label="图片首轮质检通过率" value={summary?RATE_LABEL(summary.IMAGE.firstPass):'—'} note={summary?`${summary.IMAGE.firstPass.passed} / ${summary.IMAGE.firstPass.decided} 个已审样本`:'等待统计'} onClick={()=>show(0,'firstPass','IMAGE')}/>
      <Card label="期间实际退回作业" value={number(summary?.returned)} note={`${number(summary?.returnRounds)} 次退回；批次影响另计`} onClick={()=>show(0,'returned')}/>
      <Card label="期间返修提交" value={number(summary?.reworkRounds)} note={`重复退回 ${number(summary?.repeatedReturns)} 项`} onClick={()=>show(0,'reworked')}/>
      <Card label="当前人工待办" value={number(summary?.pending)} note={`其中超 24 小时 ${number(summary?.longWaiting)} 项`} onClick={()=>show(0)}/>
      <Card label="当前等待质检 / 批次" value={number(summary?.waitingQuality)} note="机器与质检等待不作为人员工时" onClick={()=>show(0,'pending')}/>
    </section>
    <section className={`panel ${styles.section}`} aria-label="作业人员表现"><div className={styles.sectionHeading}><div><h2><UsersRound size={18} style={{display:'inline',marginRight:8}}/>人员表现</h2><p className={styles.muted}>点击人员、通过率或时长查看原始任务。文案和图片分别评估；小样本只作参考。</p></div><span className={styles.muted}>{number(report?.people.total)} 位人员</span></div>
      <div className={styles.tableScroll} role="region" aria-label="人员表现表，可横向滚动" tabIndex={0}><table className={styles.table}><thead><tr><th scope="col">作业人员</th>{columns.map(([key,label])=><th scope="col" key={key} aria-sort={filters.sort===key?(filters.order==='asc'?'ascending':'descending'):'none'}>
        <button className={styles.link} onClick={()=>sort(key)}>{label} <ArrowUpDown size={11} style={{display:'inline'}}/></button></th>)}</tr></thead>
        <tbody>{report?.people.items.map(person=><tr key={person.accountId}><th scope="row"><button className={`${styles.link} ${styles.name}`} onClick={()=>show(person.accountId)}>{person.displayName}</button><small>{person.username} · #{person.accountId}</small></th>{cells(person)}</tr>)}
          {report&&!report.people.items.length&&<tr><td colSpan={9} className={styles.empty}>该范围暂无人员记录</td></tr>}</tbody></table></div>
      {report&&<div className={styles.pagination}><span>第 {report.people.page} / {Math.max(1,Math.ceil(report.people.total/report.people.pageSize))} 页 · 按同一报表排序</span><div className={styles.actions}>
        <Button variant="outline" size="sm" disabled={busy||report.people.page<=1} onClick={()=>setFilters(previous=>({...previous,page:String(report.people.page-1)}))}>上一页</Button>
        <Button variant="outline" size="sm" disabled={busy||report.people.page*report.people.pageSize>=report.people.total} onClick={()=>setFilters(previous=>({...previous,page:String(report.people.page+1)}))}>下一页</Button></div></div>}
    </section>
    {report&&<section className={styles.charts}><article className={`panel ${styles.section}`}><h3>每日提交与首次放行</h3><p className={styles.muted}>每天独立去重；全期去重总量不等于每日数量相加。</p><Chart label="每日提交与首次放行" labels={report.trend.map(day=>day.date.slice(5))} series={[
      {name:'提交任务',values:report.trend.map(day=>day.submitted)},{name:'首次放行',values:report.trend.map(day=>day.released)}]}/></article>
      <article className={`panel ${styles.section}`}><h3>首轮质检通过率趋势</h3><p className={styles.muted}>无样本日期留空；人员详情可查看样本与复检。</p><Chart label="首轮质检通过率趋势" unit="%" labels={report.trend.map(day=>day.date.slice(5))} series={[
        {name:'文案',values:report.trend.map(day=>day.COPY.rate===null?null:Math.round(day.COPY.rate*1000)/10)},
        {name:'图片',values:report.trend.map(day=>day.IMAGE.rate===null?null:Math.round(day.IMAGE.rate*1000)/10)}]}/></article></section>}
    <details className={`panel ${styles.section} ${styles.methods}`}><summary>统计口径与数据完整性</summary>
      <p>首轮通过率 = 首轮随机抽检通过样本 / 已出结论的首轮随机抽检样本。未抽中、免检、待结论、快捷直放、自检及模拟数据不计入；强制复检单列。通过率同时显示分子和分母，少于 20 个样本提示样本较少。</p>
      <p>历史贡献属于实际提交该版本的账号，改派不转移成绩。团队作业按任务去重，人员阶段贡献不能直接相加。当前待办独立于历史日期；批次退回影响不代表每条都被人工判定失败。</p>
      <p>人工待办周转统计本人负责且可操作的自然时间，包含非工作时间，不是操作工时。中位数和 P90 仅使用完整时段；机器执行与质检等待单列。历史缺失起点不补造。</p>
      <p>抽检覆盖率使用期间首次提交中已形成普通抽样记录的集合；尚未结批或无普通抽样记录的提交单列，不推定为未通过。不同任务难度和抽检政策应结合阶段、批次分别比较。</p>
      {report&&<p>身份未确认 {report.dataQuality.unknownIdentity} 条；排除记录：{report.dataQuality.excluded.length?report.dataQuality.excluded.map(item=>`${EXCLUSIONS[item.reason]??item.reason} ${item.count}`).join('、'):'无'}。文案时长缺失 {report.summary.COPY.duration.missing} 条，图片时长缺失 {report.summary.IMAGE.duration.missing} 条。导出与当前成功报表的范围一致。</p>}
    </details>
    {selection&&<OperatorDetailDialog key={`${selection.report.snapshotToken}:${selection.accountId}:${selection.metric}:${selection.stage}`} report={selection.report} selection={selection} onClose={()=>setSelection(null)}/>}
  </div>;
}
